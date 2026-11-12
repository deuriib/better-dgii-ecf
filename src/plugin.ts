import type { BetterAuthPlugin } from 'better-auth';
import type { DBFieldAttribute } from '@better-auth/core/db';
import { createClientProvider, type DgiiEcfClientProvider } from './client-provider.js';
import { DGII_ECF_ERROR_CODES } from './errors.js';
import { SUBMISSION_MODEL } from './persistence.js';
import type { DgiiEcfOptions } from './types.js';
import {
  sendCommercialApproval,
  sendDocument,
  sendElectronicDocument,
  sendSummary,
  reconcileSubmission,
  voidENCF,
} from './endpoints/documents.js';
import {
  customerDirectory,
  directoryListing,
  inquiryStatus,
  summaryInvoiceInquiry,
  trackStatus,
  trackStatuses,
} from './endpoints/inquiries.js';
import {
  authenticate,
  maintenanceWindows,
  serviceAvailability,
  serviceStatus,
} from './endpoints/status.js';
import { listSubmissions, resolveTaxPayer } from './endpoints/audit.js';

/**
 * The `organization` field the plugin reads.
 *
 * `input: false` because this definition is used when *the plugin* registers the
 * field (the read-only `organization.extendSchema` mode): the value is written
 * by another system, so Better Auth's input parser must not accept it.
 */
const readonlyTaxPayerIdField = (): DBFieldAttribute => ({
  type: 'string',
  required: false,
  input: false,
  returned: true,
  unique: false,
});

/**
 * Fragments to drop into `organization({ schema })`.
 *
 * Exported so an application declares the field exactly once, with exactly the
 * definition this plugin expects. This is the supported way to make the value
 * *writable*: the organization plugin builds its create/update schemas from its
 * own `additionalFields`, so a field registered only by this plugin's schema is
 * readable but not accepted by `organization.update`.
 *
 * @example
 * ```ts
 * organization({ schema: { organization: dgiiEcfOrganizationSchema() } })
 * ```
 */
export const dgiiEcfOrganizationSchema = (
  field = 'taxPayerId',
): {
  additionalFields: Record<string, DBFieldAttribute>;
} => ({
  additionalFields: {
    [field]: {
      type: 'string',
      required: false,
      // Writable: this fragment is declared by the organization plugin, which
      // is what makes `organization.create` / `organization.update` accept it.
      input: true,
      returned: true,
      unique: false,
    },
  },
});

/**
 * Better Auth plugin wiring the DGII e-CF SDK into an authenticated API.
 *
 * Three responsibilities, and deliberately no fourth:
 *
 * 1. **Identity** — decide *which* taxpayer a call acts for: the request, the
 *    organization, or a server-side mapping, authorized in that order.
 * 2. **Credentials** — resolve key material per taxpayer through a server-side
 *    callback, so no certificate or bearer token ever reaches a browser.
 * 3. **Durability** — record submissions, so a retry is replay-safe across
 *    restarts and the fiscal audit trail survives the process.
 *
 * Document *content* stays the host's job: the plugin signs and transmits XML,
 * it does not model invoices.
 */
export const dgiiEcf = (options: DgiiEcfOptions = {}) => {
  // Built once: the provider owns the client cache, so it must outlive requests.
  const provider = createClientProvider(options);
  const deps = { options, provider } as const;

  const schema: NonNullable<BetterAuthPlugin['schema']> = {
    [SUBMISSION_MODEL]: {
      modelName: SUBMISSION_MODEL,
      fields: {
        organizationId: { type: 'string', required: false },
        taxPayerId: { type: 'string', required: true },
        userId: { type: 'string', required: true },
        environment: { type: 'string', required: true },
        operation: { type: 'string', required: true },
        status: { type: 'string', required: true },
        idempotencyKey: { type: 'string', required: false },
        encf: { type: 'string', required: false },
        trackId: { type: 'string', required: false },
        documentHash: { type: 'string', required: false },
        errorCode: { type: 'string', required: false },
        response: { type: 'string', required: false },
        // Better Auth does not add timestamps implicitly: a plugin table that
        // wants them declares them. `createdAt` orders the replay lookup and the
        // audit listing; `updatedAt` records when a submission was closed.
        createdAt: { type: 'date', required: true, defaultValue: () => new Date() },
        updatedAt: { type: 'date', required: false, onUpdate: () => new Date() },
      },
      indexes: [
        // The replay lookup: taxpayer + key must be a cheap read.
        { fields: ['taxPayerId', 'idempotencyKey'] },
        // The audit listing: "everything this organization submitted".
        { fields: ['organizationId', 'createdAt'] },
      ],
    },
  };

  if (options.organization?.extendSchema === true) {
    schema.organization = {
      fields: {
        [options.organization.field ?? 'taxPayerId']: readonlyTaxPayerIdField(),
      },
    };
  }

  // The plugin literal stays exactly a `BetterAuthPlugin` so Better Auth can
  // infer its endpoints; the provider is attached afterwards because widening
  // the return type would erase that inference.
  const plugin = {
    id: 'dgii-ecf',
    $ERROR_CODES: DGII_ECF_ERROR_CODES,
    schema,
    endpoints: {
      // Identity
      dgiiEcfResolveTaxPayer: resolveTaxPayer(deps),
      // Session / token
      dgiiEcfAuthenticate: authenticate(deps),
      // Documents
      dgiiEcfSendDocument: sendDocument(deps),
      dgiiEcfSendElectronicDocument: sendElectronicDocument(deps),
      dgiiEcfSendSummary: sendSummary(deps),
      dgiiEcfSendCommercialApproval: sendCommercialApproval(deps),
      dgiiEcfVoidENCF: voidENCF(deps),
      dgiiEcfReconcileSubmission: reconcileSubmission(deps),
      // Queries
      dgiiEcfTrackStatus: trackStatus(deps),
      dgiiEcfInquiryStatus: inquiryStatus(deps),
      dgiiEcfTrackStatuses: trackStatuses(deps),
      dgiiEcfSummaryInvoiceInquiry: summaryInvoiceInquiry(deps),
      dgiiEcfCustomerDirectory: customerDirectory(deps),
      dgiiEcfDirectoryListing: directoryListing(deps),
      // DGII operations
      dgiiEcfServiceStatus: serviceStatus(deps),
      dgiiEcfMaintenanceWindows: maintenanceWindows(deps),
      dgiiEcfServiceAvailability: serviceAvailability(deps),
      // Audit
      dgiiEcfListSubmissions: listSubmissions(deps),
    },
    rateLimit: [
      {
        // Fiscal transmissions are metered by DGII and expensive to retry, so
        // the whole surface gets a conservative per-window budget.
        window: 60,
        max: 60,
        pathMatcher: (path: string) => path.startsWith('/dgii-ecf'),
      },
    ],
  } satisfies BetterAuthPlugin;

  return Object.assign(plugin, { clientProvider: provider });
};

/**
 * Public type of the plugin.
 *
 * `ReturnType` rather than an interface on purpose: an explicit interface would
 * widen `endpoints` to an index signature and destroy the client-side inference
 * that makes a renamed path a compile error.
 */
export type DgiiEcfPlugin = ReturnType<typeof dgiiEcf>;

/** Exposed so a host can drop a cached client after rotating a certificate. */
export type { DgiiEcfClientProvider };

declare module '@better-auth/core' {
  interface BetterAuthPluginRegistry<AuthOptions, Options> {
    'dgii-ecf': {
      creator: typeof dgiiEcf;
    };
  }
}
