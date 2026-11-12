/**
 * Server entrypoint.
 *
 * Node-only by design: the DGII SDK signs with a private key and talks to DGII
 * over the certificate that owns it, so nothing here is safe to bundle for a
 * browser. Import `@deuriib/better-dgii-ecf/client` for the isomorphic client
 * plugin instead.
 */
export { dgiiEcf, dgiiEcfOrganizationSchema } from './plugin.js';
export type { DgiiEcfPlugin } from './plugin.js';

export { DGII_ECF_ERROR_CODES } from './errors.js';
export type { DgiiEcfErrorCode } from './errors.js';

export { isTaxPayerIdShape, normalizeTaxPayerId } from './tax-payer.js';

export { SUBMISSION_MODEL } from './persistence.js';
export type {
  SubmissionRecord,
  SubmissionStatus,
  DgiiEcfSubmissionStore,
} from './persistence.js';

export type { DgiiEcfClientProvider } from './client-provider.js';

export type {
  DgiiEcfAuthorizer,
  DgiiEcfClientCacheOptions,
  DgiiEcfClientResolver,
  DgiiEcfCredentialsResolver,
  DgiiEcfOptions,
  DgiiEcfOrganizationOptions,
  DgiiEcfPersistenceOptions,
  DgiiEcfScope,
  DgiiEcfStatusOptions,
  DgiiEcfTaxPayerIdResolver,
  DgiiEcfTaxPayerIdSource,
  TaxPayerIdValidation,
  TaxPayerIdValidator,
} from './types.js';

/** Re-exported so a host imports the DGII environment from one place. */
export { Environment } from '@deuriib/dgii-ecf';
