import { APIError } from 'better-auth/api';
import type { GenericEndpointContext } from '@better-auth/core';
import type { DgiiResult, ECF } from '@deuriib/dgii-ecf';
import { Signature } from '@deuriib/dgii-ecf';
import {
  badRequest,
  conflict,
  DGII_ECF_ERROR_CODES,
  forbidden,
  serverError,
  toApiError,
} from '../errors.js';
import type { DgiiEcfClientProvider } from '../client-provider.js';
import { type DgiiEcfRequestScope, resolveRequestScope } from '../resolution.js';
import {
  createSubmissionStore,
  hashDocument,
  parseStoredResponse,
  planReplay,
} from '../persistence.js';
import { normalizeTaxPayerId } from '../tax-payer.js';
import type { DgiiEcfOptions, DgiiEcfScope } from '../types.js';
import { elementText, issuerTaxPayerId, rootElementName } from '../xml.js';

/** What every endpoint handler needs from the plugin closure. */
export interface DgiiEcfEndpointDeps {
  readonly options: DgiiEcfOptions;
  readonly provider: DgiiEcfClientProvider;
}

export interface EndpointInput {
  taxPayerId?: string | undefined;
  organizationId?: string | undefined;
}

export interface PreparedRequest {
  readonly scope: DgiiEcfRequestScope;
  readonly client: ECF;
}

/**
 * Resolve the scope, then the client — in that order.
 *
 * Authorization is part of resolution, so a caller who may not act on behalf of
 * a taxpayer never reaches the credential resolver and cannot learn, from timing
 * or error shape, whether that taxpayer has credentials configured.
 */
export const prepare = async (
  deps: DgiiEcfEndpointDeps,
  ctx: GenericEndpointContext,
  input: EndpointInput,
): Promise<PreparedRequest> => {
  const scope = await resolveRequestScope({ ctx, options: deps.options, input });
  const client = await deps.provider.get(scope);
  return { scope, client };
};

/**
 * Unwrap a DGII SDK result, mapping a failure to an `APIError`.
 *
 * The SDK never throws domain errors; it returns `Result`. This is the single
 * place that turns `Err` into an HTTP response, so the status mapping stays
 * consistent across every endpoint.
 */
export const unwrap = <T>(result: DgiiResult<T>): T => {
  if (result.isErr()) {
    throw toApiError(result.error);
  }
  return result.value;
};

/**
 * Refuse a document whose issuer is not the taxpayer this request acts for.
 *
 * Without this check a member of organization A could build a perfectly valid
 * document for RNC B, have it signed with A's certificate (which is merely a
 * signing key, not an authorization), and submit it under A's credentials. The
 * issuer is the fiscal identity of the document, so it must equal the identity
 * the caller was authorized for.
 */
export const assertIssuer = (xml: string, taxPayerId: string): void => {
  const issuer = issuerTaxPayerId(xml);
  if (issuer === undefined) {
    throw badRequest(DGII_ECF_ERROR_CODES.DGII_DOCUMENT_UNREADABLE);
  }
  if (normalizeTaxPayerId(issuer) !== taxPayerId) {
    throw forbidden(
      DGII_ECF_ERROR_CODES.DGII_TAXPAYER_ID_MISMATCH,
      `The document is issued by ${issuer} but this request acts for ${taxPayerId}`,
    );
  }
};

/**
 * Sign a document server-side with the organization's key.
 *
 * The signature is what makes the credential model work: the browser sends the
 * document body, the server signs it, and the private key never leaves the
 * process. Signing requires the `credentials` resolver — a host that supplies a
 * ready-made client has kept the key outside the plugin's reach on purpose.
 */
export const signDocument = async (
  deps: DgiiEcfEndpointDeps,
  scope: DgiiEcfScope,
  xml: string,
): Promise<string> => {
  const resolver = deps.options.credentials;
  if (resolver === undefined) {
    throw serverError(
      DGII_ECF_ERROR_CODES.DGII_CREDENTIALS_UNAVAILABLE,
      'Server-side signing needs the `credentials` resolver; `getClient` hands the key to the host.',
    );
  }
  const material = await resolver(scope);
  if (material === null) {
    throw serverError(
      DGII_ECF_ERROR_CODES.DGII_CREDENTIALS_UNAVAILABLE,
      `No credentials were resolved for taxpayer ${scope.taxPayerId}`,
    );
  }
  const { key, cert } = material;
  if (key === undefined || cert === undefined) {
    // `P12ReaderData` keeps both fields optional, but a signature needs both.
    // Failing here names the real problem instead of surfacing a CERTIFICATE
    // error from underneath the signer.
    throw serverError(
      DGII_ECF_ERROR_CODES.DGII_CREDENTIALS_UNAVAILABLE,
      'The resolved credentials carry no `key`/`cert` PEM pair, so the document cannot be signed',
    );
  }
  const signature = new Signature(key, cert);
  const root = rootElementName(xml);
  const signed =
    root === undefined ? signature.signXml(xml) : signature.signXml(xml, root);
  if (signed.isErr()) {
    throw new APIError('BAD_REQUEST', {
      message: signed.error.message,
      code: DGII_ECF_ERROR_CODES.DGII_SIGNING_FAILED.code,
      dgii: { code: signed.error.code },
    });
  }
  return signed.value;
};

/** The e-NCF a document refers to, used for the audit trail. */
export const documentEncf = (xml: string): string | null =>
  elementText(xml, 'eNCF') ??
  elementText(xml, 'SecuenciaeNCFDesde') ??
  elementText(xml, 'RangoNCF') ??
  null;

export interface RunSubmissionInput<T> {
  readonly ctx: GenericEndpointContext;
  readonly deps: DgiiEcfEndpointDeps;
  readonly scope: DgiiEcfRequestScope;
  /** Operation name recorded in the audit trail. */
  readonly operation: string;
  /** Signed XML about to be transmitted. */
  readonly xml: string;
  /** Caller-supplied idempotency key; defaults to the document hash. */
  readonly idempotencyKey?: string | undefined;
  /** The actual transmission. Only called when a replay is not possible. */
  readonly send: () => Promise<DgiiResult<T>>;
}

export interface SubmissionOutcome<T> {
  readonly result: T;
  /** True when the answer came from the stored record, not from DGII. */
  readonly replayed: boolean;
  /** Row id of the audit record, when persistence is enabled. */
  readonly submissionId: string | null;
}

const trackIdOf = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = (value as { trackId?: unknown }).trackId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
};

/**
 * Run a submission through the durable replay guard and the audit trail.
 *
 * Order matters and is the whole point: look for a replay, write the pending
 * row, transmit, then record the outcome. A crash between "write pending" and
 * "record outcome" leaves a row that makes the next attempt refuse instead of
 * guessing — a duplicate fiscal document is worse than a failed request.
 */
export const runSubmission = async <T>({
  ctx,
  deps,
  scope,
  operation,
  xml,
  idempotencyKey,
  send,
}: RunSubmissionInput<T>): Promise<SubmissionOutcome<T>> => {
  const store = createSubmissionStore(ctx, deps.options.persistence);
  const documentHash = hashDocument(xml);
  const replayKey = idempotencyKey ?? documentHash;

  if (store.enabled) {
    const existing = await store.findReplay(scope.taxPayerId, replayKey);
    const decision = planReplay(existing);
    if (decision.kind === 'conflict') {
      throw conflict(
        DGII_ECF_ERROR_CODES.DGII_IDEMPOTENCY_IN_FLIGHT,
        `A submission for this document is still in flight (record ${existing?.id ?? 'unknown'}). Reconcile it by e-NCF before retrying.`,
      );
    }
    if (decision.kind === 'replay') {
      return {
        result: parseStoredResponse(decision.record) as T,
        replayed: true,
        submissionId: decision.record.id,
      };
    }
  }

  const submissionId = await store.begin({
    organizationId: scope.organizationId,
    taxPayerId: scope.taxPayerId,
    userId: scope.userId,
    environment: scope.environment,
    operation,
    idempotencyKey: replayKey,
    encf: documentEncf(xml),
    documentHash,
  });

  let result: T;
  try {
    result = unwrap(await send());
  } catch (error) {
    const errorCode =
      error instanceof APIError
        ? String(error.body?.code ?? error.status)
        : error instanceof Error
          ? error.name
          : 'UNKNOWN';
    await store.complete(submissionId, { status: 'failed', errorCode });
    throw error;
  }

  await store.complete(submissionId, {
    status: 'succeeded',
    trackId: trackIdOf(result),
    response: result,
  });

  return { result, replayed: false, submissionId };
};

/** The scope fields every response echoes back. */
export const scopeEcho = (scope: DgiiEcfScope) => ({
  taxPayerId: scope.taxPayerId,
  organizationId: scope.organizationId,
  environment: scope.environment,
});
