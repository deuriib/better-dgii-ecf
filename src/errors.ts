import { APIError } from 'better-auth/api';
import { defineErrorCodes } from '@better-auth/core/utils/error-codes';
import type { DgiiError, DgiiErrorCode } from '@deuriib/dgii-ecf';

/**
 * Error codes this plugin can return.
 *
 * They are declared through `defineErrorCodes` so they flow into Better Auth's
 * own type surface (`auth.$ERROR_CODES`, client `error.code`) and so the keys
 * are constrained to UPPER_SNAKE_CASE at compile time. Every code describes a
 * condition the plugin itself decided on; a failure DGII produced is reported
 * as {@link DGII_ECF_ERROR_CODES.DGII_REQUEST_FAILED} with the upstream detail
 * attached, never smuggled into a success payload.
 */
export const DGII_ECF_ERROR_CODES = defineErrorCodes({
  DGII_SESSION_REQUIRED: 'A session is required to call a DGII e-CF endpoint',
  DGII_TAXPAYER_ID_REQUIRED:
    'No taxpayer id (RNC) could be resolved: send `taxPayerId`, set the organization field, or configure `resolveTaxPayerId`',
  DGII_TAXPAYER_ID_INVALID:
    'The taxpayer id is not a valid DGII RNC (9 digits) or cédula (11 digits)',
  DGII_TAXPAYER_ID_MISMATCH:
    'The signed document was issued under a taxpayer id other than the one resolved for this request',
  DGII_TAXPAYER_ID_FORBIDDEN:
    'This session is not allowed to act on behalf of the requested taxpayer id',
  DGII_BUYER_HOST_NOT_ALLOWED:
    'Direct buyer delivery needs a configured buyer host; a request cannot supply a delivery URL',
  DGII_OWNERSHIP_UNVERIFIED:
    'The organization taxpayer id cannot be set or trusted without ownership verification',
  DGII_ORGANIZATION_NOT_FOUND: 'The organization in scope was not found',
  DGII_ORGANIZATION_REQUIRED:
    'This request needs an organization: send `organizationId` or select an active organization',
  DGII_NOT_A_MEMBER: 'The session user is not a member of the organization in scope',
  DGII_INSUFFICIENT_ROLE:
    'The session user does not hold a role allowed to perform this DGII operation',
  DGII_CREDENTIALS_UNAVAILABLE:
    'No DGII credentials could be resolved for this taxpayer id',
  DGII_STATUS_API_KEY_REQUIRED:
    'The DGII status service needs an API key: configure `status.apiKey`',
  DGII_ENCF_INVALID:
    'The document carries an e-NCF that does not match the DGII format (E + type + sequence)',
  DGII_DOCUMENT_UNREADABLE:
    'The signed document carries no issuer taxpayer id (RNCEmisor / RncEmisor)',
  DGII_SIGNING_FAILED: 'The document could not be signed with the organization key',
  DGII_REQUEST_FAILED: 'The DGII request failed',
  DGII_PERSISTENCE_UNAVAILABLE:
    'Submission persistence is disabled, so this operation is unavailable',
  DGII_IDEMPOTENCY_IN_FLIGHT:
    'A submission with this idempotency key is still in flight or has an unknown outcome; reconcile it before retrying',
});

export type DgiiEcfErrorCode = keyof typeof DGII_ECF_ERROR_CODES;

type ApiErrorStatus = Parameters<typeof APIError.from>[0];

/**
 * HTTP status for a failure the DGII SDK reported.
 *
 * The distinction matters to callers: a 400 means the request or the document
 * is wrong and resending it unchanged will fail again, while a 502 means DGII
 * (or the network to it) is the problem and the call is worth retrying. An
 * upstream credential problem is a 500: the application's server-side
 * configuration is broken and no retry from the client can fix it.
 *
 * `HTTP` in this table is only the fallback. A response DGII actually sent is
 * classified by {@link statusForUpstreamHttp}: a 400 or 422 is a permanent
 * rejection and must not be reported as a retryable 502.
 */
const STATUS_BY_DGII_CODE: Record<DgiiErrorCode, ApiErrorStatus> = {
  INVALID_XML: 'BAD_REQUEST',
  SIGNING: 'BAD_REQUEST',
  VALIDATION: 'BAD_REQUEST',
  CERTIFICATE: 'INTERNAL_SERVER_ERROR',
  IDEMPOTENCY: 'CONFLICT',
  AUTH: 'BAD_GATEWAY',
  HTTP: 'BAD_GATEWAY',
  TIMEOUT: 'BAD_GATEWAY',
  CIRCUIT_OPEN: 'BAD_GATEWAY',
  UNKNOWN: 'BAD_GATEWAY',
};

/**
 * 4xx statuses that are not a rejection of this document. The SDK treats them
 * as retryable; callers should too, so they surface as 502 rather than 400.
 */
const RETRYABLE_UPSTREAM_STATUS = new Set<number>([408, 429]);

/**
 * Classify an `HTTP` failure by the status DGII returned.
 *
 * `400`, `409` and `422` are preserved. Every other 4xx is the same
 * client-error class (`400`), except `408` and `429`. Every 5xx, and a
 * failure that carries no upstream status, is `502`.
 */
const statusForUpstreamHttp = (status: number | undefined): ApiErrorStatus => {
  if (status === 409) {
    return 'CONFLICT';
  }
  if (status === 422) {
    return 'UNPROCESSABLE_ENTITY';
  }
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_UPSTREAM_STATUS.has(status)
  ) {
    return 'BAD_REQUEST';
  }
  return 'BAD_GATEWAY';
};

interface DgiiFailureDetail {
  readonly code: DgiiErrorCode;
  readonly status?: number | undefined;
  readonly statusText?: string | undefined;
  readonly resource?: string | undefined;
  readonly method?: string | undefined;
  readonly mensajes?: readonly { valor: string; codigo: number | string }[] | undefined;
}

/**
 * Shapes a {@link DgiiError} for the wire.
 *
 * `data` and `baseURL` are deliberately dropped. `data` is whatever body DGII
 * returned, and on the authentication endpoints that body carries the bearer
 * token — echoing it back in an error message would leak a credential into
 * logs, browser devtools and error trackers.
 */
const toFailureDetail = (error: DgiiError): DgiiFailureDetail => ({
  code: error.code,
  status: error.status,
  statusText: error.statusText,
  resource: error.resource,
  method: error.method,
  mensajes: error.mensajes,
});

/** The shape `defineErrorCodes` produces, without depending on its internals. */
export interface ErrorCodeLike {
  readonly code: string;
  readonly message: string;
}

export const badRequest = (error: ErrorCodeLike, message?: string): APIError =>
  new APIError('BAD_REQUEST', {
    message: message ?? error.message,
    code: error.code,
  });

export const forbidden = (error: ErrorCodeLike, message?: string): APIError =>
  new APIError('FORBIDDEN', {
    message: message ?? error.message,
    code: error.code,
  });

export const conflict = (error: ErrorCodeLike, message?: string): APIError =>
  new APIError('CONFLICT', {
    message: message ?? error.message,
    code: error.code,
  });

export const serverError = (error: ErrorCodeLike, message?: string): APIError =>
  new APIError('INTERNAL_SERVER_ERROR', {
    message: message ?? error.message,
    code: error.code,
  });

/** Translate a DGII SDK failure into an `APIError` the client can branch on. */
export const toApiError = (error: DgiiError): APIError =>
  new APIError(
    error.code === 'HTTP'
      ? statusForUpstreamHttp(error.status)
      : STATUS_BY_DGII_CODE[error.code],
    {
      message: error.message,
      code: DGII_ECF_ERROR_CODES.DGII_REQUEST_FAILED.code,
      dgii: toFailureDetail(error),
    },
  );

/**
 * Whether a DGII failure proves the document was **not** received.
 *
 * This decides whether a submission may be retried. Getting it wrong in the
 * permissive direction submits the same e-NCF twice, so the default for anything
 * unclear is "the outcome is unknown".
 *
 * - A rejection, a validation/signing/certificate error, an authentication
 *   failure (which happens before transmission) and the SDK's own idempotency
 *   guard all mean nothing was delivered.
 * - A 4xx from DGII is DGII refusing the document.
 * - A timeout, a 5xx, a 408/429, an open circuit, a saturated bulkhead or an
 *   unrecognised failure mean the request may have been delivered.
 */
export const isDefiniteRejection = (error: DgiiError): boolean => {
  switch (error.code) {
    case 'INVALID_XML':
    case 'VALIDATION':
    case 'SIGNING':
    case 'CERTIFICATE':
    case 'AUTH':
    case 'IDEMPOTENCY':
      return true;
    case 'HTTP':
      // 4xx is a refusal; 5xx, 408 and 429 left the document's fate open.
      return error.status !== undefined && error.status >= 400 && error.status < 500;
    case 'CIRCUIT_OPEN':
    case 'TIMEOUT':
    case 'UNKNOWN':
      return false;
  }
};
