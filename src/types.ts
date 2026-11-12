import type { Session, User } from 'better-auth';
import type { ECF, Environment, P12ReaderData } from '@deuriib/dgii-ecf';

/**
 * Everything a resolver needs to answer "which credentials / which client /
 * which environment applies to this call".
 *
 * It carries no request body: resolvers run after the taxpayer id and the
 * organization have been resolved and authorized, so a resolver cannot be used
 * to widen the scope it is given.
 */
export interface DgiiEcfScope {
  /** Canonical taxpayer id (RNC / cédula) the call is acting for. */
  readonly taxPayerId: string;
  /** Organization in scope, when the call resolved one. */
  readonly organizationId: string | null;
  /** Authenticated user making the call. */
  readonly userId: string;
  /** DGII environment the call targets. */
  readonly environment: Environment;
}

/** Resolver for the PKCS#12 key material the DGII SDK signs with. */
export type DgiiEcfCredentialsResolver = (
  scope: DgiiEcfScope,
) => P12ReaderData | null | Promise<P12ReaderData | null>;

/**
 * Resolver for a fully built DGII client.
 *
 * Use it when credentials live in an HSM, a KMS-backed signer or a sidecar, or
 * when the host already pools clients and wants to keep owning their lifecycle.
 * When it is provided, the plugin caches nothing.
 */
export type DgiiEcfClientResolver = (
  scope: DgiiEcfScope,
) => ECF | null | Promise<ECF | null>;

/**
 * Resolver for the taxpayer id, used when the request does not name one and
 * the organization has no stored value.
 *
 * It receives the session so a single-tenant or user-scoped mapping is possible
 * (`user -> RNC`), and its result is authorized like any other source.
 */
export type DgiiEcfTaxPayerIdResolver = (context: {
  readonly user: User;
  readonly session: Session;
  readonly organizationId: string | null;
}) => string | null | Promise<string | null>;

/** Custom authorization decision. Returning `true` allows, `false` denies. */
export type DgiiEcfAuthorizer = (context: {
  readonly user: User;
  readonly session: Session;
  readonly taxPayerId: string;
  readonly organizationId: string | null;
  /** Organization's stored taxpayer id, when one was resolved. */
  readonly organizationTaxPayerId: string | null;
  /** Which source produced the taxpayer id for this call. */
  readonly source: DgiiEcfTaxPayerIdSource;
}) => boolean | Promise<boolean>;

/** Where the taxpayer id for a call came from. */
export type DgiiEcfTaxPayerIdSource = 'request' | 'organization' | 'resolver';

export interface DgiiEcfOrganizationOptions {
  /**
   * Organization field holding the taxpayer id. Defaults to `taxPayerId`,
   * matching the field this package exports for `organization({ schema })`.
   */
  field?: string;
  /**
   * Register the field on the `organization` model from this plugin (and let
   * Better Auth's CLI migration create it).
   *
   * Defaults to `false`, because the supported way to make the field writable
   * is the organization plugin's own `additionalFields` — declare it there and
   * `organization.update` persists it. Enable this only for read-only setups
   * where the value is written by another system; `organization.update` will
   * not accept a field it does not know about.
   */
  extendSchema?: boolean;
}

export interface DgiiEcfPersistenceOptions {
  /**
   * Persist submissions so retries are replay-safe across restarts and the
   * audit trail survives. Defaults to `true`; the table is part of the plugin
   * schema, so the Better Auth CLI creates it with the rest of the schema.
   */
  enabled?: boolean;
  /**
   * Store the successful DGII response body on the record so an idempotent
   * replay can return the original answer. Defaults to `true`; disable it when
   * the response must not be retained.
   */
  storeResponses?: boolean;
  /** Values longer than this are truncated before storage. Defaults to 8192. */
  maxResponseLength?: number;
}

export interface DgiiEcfClientCacheOptions {
  /** Maximum number of cached clients. Defaults to 50. */
  maxSize?: number;
  /** How long a cached client is reused. Defaults to 10 minutes. */
  ttlMs?: number;
}

export interface DgiiEcfStatusOptions {
  /**
   * API key for the DGII status service (`statusecf.dgii.gov.do`). The status
   * endpoints fail with `DGII_STATUS_API_KEY_REQUIRED` when it is absent.
   */
  apiKey?: string;
}

export interface DgiiEcfOptions {
  /**
   * DGII environment, or a function returning one per scope. Defaults to
   * `Environment.Dev` — the certification environments are opt-in so a
   * misconfigured deployment cannot issue real fiscal documents.
   */
  environment?:
    | Environment
    | ((
        scope: Omit<DgiiEcfScope, 'environment'>,
      ) => Environment | Promise<Environment>);
  /**
   * Resolve the PKCS#12 key material per taxpayer. Required unless `getClient`
   * is provided. The plugin never accepts key material over HTTP.
   */
  credentials?: DgiiEcfCredentialsResolver;
  /** Provide a ready-made DGII client per scope. Disables the plugin's cache. */
  getClient?: DgiiEcfClientResolver;
  /** Fallback taxpayer id mapping when neither the request nor the org has one. */
  resolveTaxPayerId?: DgiiEcfTaxPayerIdResolver;
  /** Replace the built-in authorization policy entirely. */
  authorize?: DgiiEcfAuthorizer;
  /**
   * Confirm that an organization owns a taxpayer id before it is stored on the
   * organization.
   *
   * Required to let anyone set `organization.taxPayerId` through the auth API: the
   * field is the tenant boundary, and without this check an organization admin can
   * claim any RNC. Return `true` to allow the write. Hosts that keep the field
   * read-only (`organization.extendSchema: true`) do not need it — they write the
   * value from their own verified path.
   */
  verifyTaxPayerOwnership?: (context: {
    readonly taxPayerId: string;
    readonly organizationId: string | null;
    readonly user: User;
    readonly session: Session;
  }) => boolean | Promise<boolean>;
  /**
   * Direct delivery to buyer Sender↔Receiver hosts, by name.
   *
   * The URL never comes from a request: a request selects a name, and this map
   * decides where the call goes. Without it, requesting a buyer is refused.
   */
  buyerDelivery?: {
    /** Name → absolute HTTPS URL, e.g. `{ acme: 'https://fe.acme.com' }`. */
    readonly hosts: Record<string, string>;
  };
  /** Organization integration knobs. */
  organization?: DgiiEcfOrganizationOptions;
  /** Roles allowed to perform DGII operations. Defaults to owner and admin. */
  roles?: string[];
  /**
   * Allow a request-supplied taxpayer id when no organization is in scope.
   *
   * Only meaningful while the organization plugin is installed: without it there
   * is no tenant model to check against, so request-supplied ids are accepted
   * (this is the documented single-tenant mode) and this flag changes nothing.
   */
  allowUntrustedTaxPayerId?: boolean;
  /**
   * Taxpayer id validation policy. Defaults to `format` (shape only) — the value
   * `resolveRequestScope` applies when the option is unset. Opt into `checksum`
   * to also verify the DGII check digit for 9-digit RNCs (measured at 100% over
   * DGII's public registry); an 11-digit id is shape-checked either way, because
   * the cédula check refuses 41 taxpayers that registry contains.
   */
  validateTaxPayerId?: TaxPayerIdValidation;
  /** Submission persistence and idempotency. */
  persistence?: DgiiEcfPersistenceOptions;
  /** Client cache sizing. Ignored when `getClient` is provided. */
  clientCache?: DgiiEcfClientCacheOptions;
  /** DGII status service configuration. */
  status?: DgiiEcfStatusOptions;
  /** Request timeout forwarded to the DGII SDK. Defaults to the SDK's value. */
  timeoutMs?: number;
}

export type { Environment, ECF, P12ReaderData };
export type { TaxPayerIdValidation, TaxPayerIdValidator } from './tax-payer.js';
import type { TaxPayerIdValidation } from './tax-payer.js';
