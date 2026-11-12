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
 */

/** Model key of the table this plugin owns. */
export const SUBMISSION_MODEL = 'dgiiEcfSubmission';

export type SubmissionStatus = 'pending' | 'succeeded' | 'failed';

export interface SubmissionRecord extends Record<string, unknown> {
  id: string;
  organizationId?: string | null;
  taxPayerId: string;
  userId: string;
  environment: string;
  operation: string;
  status: SubmissionStatus;
  idempotencyKey?: string | null;
  encf?: string | null;
  trackId?: string | null;
  documentHash?: string | null;
  errorCode?: string | null;
  response?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface BeginSubmissionInput {
  readonly organizationId: string | null;
  readonly taxPayerId: string;
  readonly userId: string;
  readonly environment: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly encf: string | null;
  readonly documentHash: string | null;
}

export interface ListSubmissionsInput {
  readonly organizationId: string | null;
  readonly taxPayerId: string | null;
  readonly limit: number;
}

const DEFAULT_MAX_RESPONSE_LENGTH = 8192;

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
   * A previously recorded submission for the same taxpayer and replay key.
   *
   * Returns the record whatever its status: the caller decides what a `pending`
   * or `failed` record means for the attempt it is about to make.
   */
  findReplay(
    taxPayerId: string,
    idempotencyKey: string,
  ): Promise<SubmissionRecord | null>;
  /** Record the attempt before it is transmitted; `null` when persistence is off. */
  begin(input: BeginSubmissionInput): Promise<string | null>;
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
  /** Audit listing for the organization (or taxpayer) in scope. */
  list(input: ListSubmissionsInput): Promise<SubmissionRecord[]>;
}

const disabledStore: DgiiEcfSubmissionStore = {
  enabled: false,
  async findReplay() {
    return null;
  },
  async begin() {
    return null;
  },
  async complete() {
    // Persistence is off: there is no row to finish.
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

  return {
    enabled: true,
    async findReplay(taxPayerId, idempotencyKey) {
      // `findOne` takes no ordering, and a key can legitimately repeat (a failed
      // attempt followed by a new one), so the newest row is read explicitly.
      const rows = await adapter.findMany<SubmissionRecord>({
        model: SUBMISSION_MODEL,
        where: [
          { field: 'taxPayerId', value: taxPayerId },
          { field: 'idempotencyKey', value: idempotencyKey },
        ],
        limit: 1,
        sortBy: { field: 'createdAt', direction: 'desc' },
      });
      return rows[0] ?? null;
    },
    async begin(input) {
      const created = await adapter.create<SubmissionRecord>({
        model: SUBMISSION_MODEL,
        data: {
          organizationId: input.organizationId,
          taxPayerId: input.taxPayerId,
          userId: input.userId,
          environment: input.environment,
          operation: input.operation,
          status: 'pending',
          idempotencyKey: input.idempotencyKey,
          encf: input.encf,
          trackId: null,
          documentHash: input.documentHash,
          errorCode: null,
          response: null,
        },
      });
      return created.id;
    },
    async complete(id, outcome) {
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
 * - A `succeeded` record is returned as-is: the document already exists at
 *   DGII, so re-sending it cannot be the caller's intent.
 * - A `pending` record means an earlier attempt may have reached DGII. Refusing
 *   with a conflict is the only safe answer — the caller reconciles by e-NCF
 *   instead of gambling on a duplicate fiscal document.
 * - A `failed` record is not a replay: the previous attempt did not land, so the
 *   new one may proceed.
 */
export const planReplay = (
  record: SubmissionRecord | null,
):
  | { kind: 'proceed' }
  | { kind: 'replay'; record: SubmissionRecord }
  | { kind: 'conflict' } => {
  if (record === null) {
    return { kind: 'proceed' };
  }
  if (record.status === 'succeeded') {
    return { kind: 'replay', record };
  }
  if (record.status === 'pending') {
    return { kind: 'conflict' };
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
