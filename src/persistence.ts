import { createHash } from 'node:crypto';
import { APIError } from 'better-auth/api';
import type { GenericEndpointContext } from '@better-auth/core';
import { DGII_ECF_ERROR_CODES } from './errors.js';
import type { DgiiEcfPersistenceOptions } from './types.js';

/**
 * Submission persistence: the audit trail and the replay guard.
 *
 * Two problems are solved by the same row:
 *
 * 1. **Replay safety.** The DGII SDK keeps its idempotency markers in memory, so
 *    a restart or a second instance loses them and a retried POST can submit the
 *    same fiscal document twice. The row makes the guard durable.
 * 2. **Audit.** Who submitted what, under which taxpayer, with which track id
 *    and what DGII answered. Fiscal operations need that trail.
 *
 * Only derived data is stored: the SHA-256 of the signed document, never the
 * document, and never key material or a bearer token.
 *
 * The status is a state machine, not a boolean, because "failed" and "we do not
 * know" have opposite consequences for a retry:
 *
 * ```text
 *            begin
 *             │
 *             ▼
 *          pending ──definite rejection──► failed ──retry──► pending
 *             │
 *             └──may have been delivered──► unconfirmed ──reconcile──► succeeded | failed
 *             │
 *             └──────────DGII accepted─────► succeeded ──► replay
 * ```
 *
 * `failed` allows a retry. `unconfirmed` does not: only `reconcile` closes it,
 * because a rejected document is cheap and a duplicate fiscal document is not.
 */

/** Model key of the table this plugin owns. */
export const SUBMISSION_MODEL = 'dgiiEcfSubmission';

export type SubmissionStatus = 'pending' | 'succeeded' | 'failed' | 'unconfirmed';

/** Statuses that still need a decision from DGII. */
export const OPEN_STATUSES: readonly SubmissionStatus[] = ['pending', 'unconfirmed'];

export interface SubmissionRecord extends Record<string, unknown> {
  id: string;
  organizationId?: string | null;
  taxPayerId: string;
  userId: string;
  environment: string;
  operation: string;
  status: SubmissionStatus;
  /** Collision-safe key: environment + organization + taxpayer + idempotency key. */
  replayKey?: string | null;
  idempotencyKey?: string | null;
  encf?: string | null;
  trackId?: string | null;
  documentHash?: string | null;
  errorCode?: string | null;
  response?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface ReplayKeyInput {
  readonly environment: string;
  readonly organizationId: string | null;
  readonly taxPayerId: string;
  readonly idempotencyKey: string;
}

/**
 * The key the replay guard is looked up by.
 *
 * It carries the environment and the organization, not just the taxpayer: a
 * certification document must not replay a production one, and two organizations
 * that happen to share an RNC must not see each other's submissions.
 *
 * `-` stands in for "no organization" so the key is unique per mode and cannot
 * collide with an organization whose id happens to be empty.
 */
export const replayKeyFor = ({
  environment,
  organizationId,
  taxPayerId,
  idempotencyKey,
}: ReplayKeyInput): string =>
  [environment, organizationId ?? '-', taxPayerId, idempotencyKey].join('\u0000');

export interface BeginSubmissionInput extends ReplayKeyInput {
  readonly userId: string;
  readonly operation: string;
  readonly encf: string | null;
  readonly documentHash: string | null;
}

export type BeginOutcome =
  | { readonly status: 'started'; readonly id: string }
  | { readonly status: 'conflict'; readonly record: SubmissionRecord }
  | { readonly status: 'disabled' };

export interface ReconcileInput {
  readonly environment: string;
  readonly organizationId: string | null;
  readonly taxPayerId: string;
  readonly encf: string | null;
  /** DGII says the document exists. */
  readonly delivered: boolean;
  readonly response: unknown;
}

export interface ListSubmissionsInput {
  readonly organizationId: string | null;
  readonly taxPayerId: string | null;
  readonly limit: number;
}

const DEFAULT_MAX_RESPONSE_LENGTH = 8192;

/** Code stored on a record that reconcile closed as "never received". */
export const RECONCILED_NOT_DELIVERED = 'RECONCILED_NOT_DELIVERED';

/** SHA-256 of a signed document, hex encoded — the replay key of last resort. */
export const hashDocument = (xml: string): string =>
  createHash('sha256').update(xml, 'utf8').digest('hex');

const serializeResponse = (value: unknown, maxLength: number): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized === undefined) {
    return null;
  }
  return serialized.length > maxLength ? serialized.slice(0, maxLength) : serialized;
};

export interface DgiiEcfSubmissionStore {
  readonly enabled: boolean;
  /**
   * A previously recorded submission for this exact scope and key.
   *
   * Returns the record whatever its status: the caller decides what `pending`,
   * `unconfirmed` or `failed` means for the attempt it is about to make.
   */
  findReplay(replayKey: string): Promise<SubmissionRecord | null>;
  /**
   * Claim the key for a new attempt.
   *
   * Returns `conflict` when another attempt holds it. A `failed` row is reused
   * rather than duplicated, which is what makes "retry after a definite
   * rejection" work under the unique index.
   */
  begin(input: BeginSubmissionInput): Promise<BeginOutcome>;
  /** Finish a recorded attempt, whatever its outcome. */
  complete(
    id: string | null,
    outcome: {
      status: Exclude<SubmissionStatus, 'pending'>;
      trackId?: string | null;
      response?: unknown;
      errorCode?: string | null;
    },
  ): Promise<void>;
  /**
   * Close every open record for a document using DGII's answer.
   *
   * This is the only exit from `pending`/`unconfirmed`, and it exists because a
   * conflict the caller cannot resolve is a dead end, not a safeguard.
   */
  reconcile(input: ReconcileInput): Promise<number>;
  /** Audit listing for the organization (or taxpayer) in scope. */
  list(input: ListSubmissionsInput): Promise<SubmissionRecord[]>;
}

const disabledStore: DgiiEcfSubmissionStore = {
  enabled: false,
  async findReplay() {
    return null;
  },
  async begin() {
    return { status: 'disabled' };
  },
  async complete() {
    // Persistence is off: there is no row to finish.
  },
  async reconcile() {
    return 0;
  },
  async list() {
    throw new APIError('NOT_IMPLEMENTED', {
      message: DGII_ECF_ERROR_CODES.DGII_PERSISTENCE_UNAVAILABLE.message,
      code: DGII_ECF_ERROR_CODES.DGII_PERSISTENCE_UNAVAILABLE.code,
    });
  },
};

/**
 * Build the store over the Better Auth adapter.
 *
 * Failures to write are surfaced, not swallowed: a submission that cannot be
 * recorded must not be transmitted, because the record is the only thing that
 * makes the retry safe. The pending row is written *before* the request leaves,
 * so an interrupted send leaves a marker a later caller can reconcile.
 */
export const createSubmissionStore = (
  ctx: GenericEndpointContext,
  options: DgiiEcfPersistenceOptions | undefined,
): DgiiEcfSubmissionStore => {
  if (options?.enabled === false) {
    return disabledStore;
  }
  const adapter = ctx.context.adapter;
  const storeResponses = options?.storeResponses ?? true;
  const maxResponseLength = options?.maxResponseLength ?? DEFAULT_MAX_RESPONSE_LENGTH;

  const findOne = async (replayKey: string): Promise<SubmissionRecord | null> => {
    const rows = await adapter.findMany<SubmissionRecord>({
      model: SUBMISSION_MODEL,
      where: [{ field: 'replayKey', value: replayKey }],
      limit: 1,
    });
    return rows[0] ?? null;
  };

  const complete = async (
    id: string | null,
    outcome: {
      status: Exclude<SubmissionStatus, 'pending'>;
      trackId?: string | null;
      response?: unknown;
      errorCode?: string | null;
    },
  ): Promise<void> => {
    if (id === null) {
      return;
    }
    await adapter.update<SubmissionRecord>({
      model: SUBMISSION_MODEL,
      where: [{ field: 'id', value: id }],
      update: {
        status: outcome.status,
        trackId: outcome.trackId ?? null,
        errorCode: outcome.errorCode ?? null,
        response: storeResponses
          ? serializeResponse(outcome.response, maxResponseLength)
          : null,
      },
    });
  };

  return {
    enabled: true,
    findReplay: findOne,
    async begin(input) {
      const replayKey = replayKeyFor(input);

      // Compare-and-set: a `failed` row is claimed by flipping it back to
      // `pending`, guarded on its current status so exactly one concurrent
      // caller wins. A fresh document goes through `create`, where the unique
      // index is the guard.
      const existing = await findOne(replayKey);
      if (existing !== null) {
        if (existing.status !== 'failed') {
          return { status: 'conflict', record: existing };
        }
        const claimed = await adapter.updateMany({
          model: SUBMISSION_MODEL,
          where: [
            { field: 'id', value: existing.id },
            { field: 'status', value: 'failed' },
          ],
          update: {
            status: 'pending',
            idempotencyKey: input.idempotencyKey,
            documentHash: input.documentHash,
            encf: input.encf,
            trackId: null,
            errorCode: null,
            response: null,
          },
        });
        if (claimed === 1) {
          return { status: 'started', id: existing.id };
        }
        const current = await findOne(replayKey);
        if (current !== null) {
          return { status: 'conflict', record: current };
        }
      }

      try {
        const created = await adapter.create<SubmissionRecord>({
          model: SUBMISSION_MODEL,
          data: {
            organizationId: input.organizationId,
            taxPayerId: input.taxPayerId,
            userId: input.userId,
            environment: input.environment,
            operation: input.operation,
            status: 'pending',
            replayKey,
            idempotencyKey: input.idempotencyKey,
            encf: input.encf,
            trackId: null,
            documentHash: input.documentHash,
            errorCode: null,
            response: null,
          },
        });
        return { status: 'started', id: created.id };
      } catch (error) {
        // The unique index rejected the insert: another process claimed the key
        // between the read and the write. That is a conflict, not a failure.
        const claimed = await findOne(replayKey);
        if (claimed !== null) {
          return { status: 'conflict', record: claimed };
        }
        throw error;
      }
    },
    complete,
    async reconcile(input) {
      if (input.encf === null) {
        return 0;
      }
      const rows = await adapter.findMany<SubmissionRecord>({
        model: SUBMISSION_MODEL,
        where: [
          { field: 'taxPayerId', value: input.taxPayerId },
          { field: 'environment', value: input.environment },
          { field: 'encf', value: input.encf },
        ],
      });
      // Organization equality is applied here rather than in the query: a
      // single-tenant record has no organization, and "no organization" must
      // match only those rows — not "any organization", which is what omitting
      // the filter would do.
      const open = rows.filter(
        (row) =>
          OPEN_STATUSES.includes(row.status) &&
          (row.organizationId ?? null) === input.organizationId,
      );
      for (const row of open) {
        await complete(row.id, {
          status: input.delivered ? 'succeeded' : 'failed',
          response: input.response,
          errorCode: input.delivered ? null : RECONCILED_NOT_DELIVERED,
        });
      }
      return open.length;
    },
    async list({ organizationId, taxPayerId, limit }) {
      const where: { field: string; value: string }[] = [];
      if (organizationId !== null) {
        where.push({ field: 'organizationId', value: organizationId });
      }
      if (taxPayerId !== null) {
        where.push({ field: 'taxPayerId', value: taxPayerId });
      }
      return adapter.findMany<SubmissionRecord>({
        model: SUBMISSION_MODEL,
        ...(where.length > 0 ? { where } : {}),
        limit,
        sortBy: { field: 'createdAt', direction: 'desc' },
      });
    },
  };
};

/**
 * Replay decision for a submission about to be transmitted.
 *
 * - `succeeded` → replay: the document already exists at DGII, so re-sending it
 *   cannot be the caller's intent.
 * - `pending` or `unconfirmed` → conflict: an earlier attempt may have reached
 *   DGII and its fate is unknown. Only `reconcile` can end that state.
 * - `failed` → proceed: a definite rejection means nothing was delivered.
 */
export const planReplay = (
  record: SubmissionRecord | null,
):
  | { kind: 'proceed' }
  | { kind: 'replay'; record: SubmissionRecord }
  | { kind: 'conflict'; record: SubmissionRecord } => {
  if (record === null) {
    return { kind: 'proceed' };
  }
  if (record.status === 'succeeded') {
    return { kind: 'replay', record };
  }
  if (OPEN_STATUSES.includes(record.status)) {
    return { kind: 'conflict', record };
  }
  return { kind: 'proceed' };
};

/** Parse a stored response back into the shape the caller originally received. */
export const parseStoredResponse = (record: SubmissionRecord): unknown => {
  const raw = record.response;
  if (typeof raw !== 'string' || raw === '') {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};
