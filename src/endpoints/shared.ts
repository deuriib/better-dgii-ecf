import { APIError } from 'better-auth/api';
import type { GenericEndpointContext } from '@better-auth/core';
import type { DgiiResult, ECF } from '@deuriib/dgii-ecf';
import { Signature } from '@deuriib/dgii-ecf';
import {
  badRequest,
  conflict,
  DGII_ECF_ERROR_CODES,
  forbidden,
  isDefiniteRejection,
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
  type ReplayKeyInput,
} from '../persistence.js';
import { normalizeTaxPayerId } from '../tax-payer.js';
import { validateEcf } from 'dgii-ts/validators';
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
 * SDK calls return `Result` rather than raising domain errors, but this
 * boundary does throw: `unwrap` (below) turns `Err` into an `APIError`, and
 * `signXml` can raise if signing fails. This is the single place that maps
 * `Err` into an HTTP response, so the status mapping stays consistent across
 * every endpoint.
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

/**
 * Refuse a document whose e-NCF is not a DGII e-NCF.
 *
 * Only values that claim to be one are checked (`E…`): the ANECF voiding request
 * carries a range start and hand-built documents may carry no e-NCF at all, and
 * inventing a rule for those would reject documents DGII accepts. A malformed
 * `E…` value, on the other hand, is refused here rather than by DGII after the
 * document has been signed and transmitted.
 */
export const assertEncF = (encf: string | null): void => {
  if (encf === null || !encf.startsWith('E')) {
    return;
  }
  const result = validateEcf(encf);
  if (!result.valid) {
    throw badRequest(
      DGII_ECF_ERROR_CODES.DGII_ENCF_INVALID,
      `"${encf}" is not a valid DGII e-NCF (E + document type + sequence, 13 characters)`,
    );
  }
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
  /**
   * The DGII answer, or `null` on a replay when responses are not retained.
   *
   * `null` is the honest answer for "the submission exists and we know its
   * outcome, but the body was not stored" — asserting `T` there would hand the
   * caller a value it cannot use.
   */
  readonly result: T | null;
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
  const encf = documentEncf(xml);
  // Before any row is written: a document DGII's own format already rejects must
  // not occupy the replay key.
  assertEncF(encf);

  const store = createSubmissionStore(ctx, deps.options.persistence);
  const documentHash = hashDocument(xml);
  const keyInput: ReplayKeyInput = {
    environment: scope.environment,
    organizationId: scope.organizationId,
    taxPayerId: scope.taxPayerId,
    idempotencyKey: idempotencyKey ?? documentHash,
  };

  // A `failed` attempt is retried in place, which is why `begin` has to run
  // before the replay decision can be final: it is the compare-and-set that
  // decides who owns the key.
  const begin = await store.begin({
    ...keyInput,
    userId: scope.userId,
    operation,
    encf,
    documentHash,
  });

  if (begin.status === 'conflict') {
    const decision = planReplay(begin.record);
    if (decision.kind === 'replay') {
      return {
        result: parseStoredResponse(decision.record) as T | null,
        replayed: true,
        submissionId: decision.record.id,
      };
    }
    throw conflict(
      DGII_ECF_ERROR_CODES.DGII_IDEMPOTENCY_IN_FLIGHT,
      `A submission for this document may have reached DGII and its outcome is unknown (record ${begin.record.id}, status ${begin.record.status}). Reconcile it by e-NCF before retrying.`,
    );
  }

  const submissionId = begin.status === 'started' ? begin.id : null;

  let raw: Awaited<ReturnType<typeof send>>;
  try {
    raw = await send();
  } catch (error) {
    // A thrown error is not a `Result`, so the SDK did not classify it: the
    // document may or may not have been transmitted. Treat it as unknown.
    await store.complete(submissionId, {
      status: 'unconfirmed',
      errorCode: error instanceof Error ? error.name : 'UNKNOWN',
    });
    throw error;
  }

  if (raw.isErr()) {
    const error = raw.error;
    // A definite rejection is safe to retry; anything else may have been
    // delivered, so it stays open until `reconcile` settles it.
    const status = isDefiniteRejection(error) ? 'failed' : 'unconfirmed';
    await store.complete(submissionId, { status, errorCode: error.code });
    throw toApiError(error);
  }

  const result = raw.value;
  if (!isObjectPayload(result)) {
    // DGII answered 2xx with something that is not a payload. "Something came
    // back" is not "the document was accepted", so it is not a success.
    await store.complete(submissionId, {
      status: 'unconfirmed',
      errorCode: 'UNRECOGNISED_PAYLOAD',
      response: result,
    });
    throw new APIError('BAD_GATEWAY', {
      message: 'DGII answered with a payload this integration cannot read',
      code: DGII_ECF_ERROR_CODES.DGII_REQUEST_FAILED.code,
      dgii: { code: 'VALIDATION' },
    });
  }

  await store.complete(submissionId, {
    status: 'succeeded',
    trackId: trackIdOf(result),
    response: result,
  });

  return { result, replayed: false, submissionId };
};

const isObjectPayload = (value: unknown): boolean =>
  typeof value === 'object' && value !== null;

/** The scope fields every response echoes back. */
export const scopeEcho = (scope: DgiiEcfScope) => ({
  taxPayerId: scope.taxPayerId,
  organizationId: scope.organizationId,
  environment: scope.environment,
});
