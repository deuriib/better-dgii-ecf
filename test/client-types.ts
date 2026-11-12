/**
 * Type-level contract of the client plugin.
 *
 * This file has no runtime assertions on purpose: it is compiled by
 * `mise run lint-types`, so a renamed endpoint or a broken client plugin fails
 * the build instead of failing in a browser. Every method below is *inferred*
 * from the server plugin's endpoints — nothing here is hand-written in `src`.
 */
import { createAuthClient } from 'better-auth/client';
import { dgiiEcfClient } from '../src/client.js';

const client = createAuthClient({ plugins: [dgiiEcfClient()] });

export const api = {
  taxpayer: client.dgiiEcf.taxpayer,
  authenticate: client.dgiiEcf.authenticate,
  submissions: client.dgiiEcf.submissions,
  documents: {
    send: client.dgiiEcf.documents,
    electronic: client.dgiiEcf.documents.electronic,
    summary: client.dgiiEcf.documents.summary,
    commercialApproval: client.dgiiEcf.documents.commercialApproval,
    voidRange: client.dgiiEcf.documents.voidRange,
    reconcile: client.dgiiEcf.documents.reconcile,
  },
  tracks: client.dgiiEcf.tracks,
  inquiries: {
    status: client.dgiiEcf.inquiries.status,
    tracks: client.dgiiEcf.inquiries.tracks,
    summary: client.dgiiEcf.inquiries.summary,
  },
  directories: {
    all: client.dgiiEcf.directories.all,
    customers: client.dgiiEcf.directories.customers,
  },
  service: {
    status: client.dgiiEcf.serviceStatus,
    maintenanceWindows: client.dgiiEcf.maintenanceWindows,
    availability: client.dgiiEcf.serviceAvailability,
  },
};

// The namespace must not be `any`: every declared endpoint is present, and a
// name the plugin does not declare is absent. Both are type-level assertions, so
// they cost nothing at runtime and fail the build rather than a request.
type DgiiEcfNamespace = typeof client.dgiiEcf;

type ExpectedEndpoints =
  | 'taxpayer'
  | 'authenticate'
  | 'submissions'
  | 'documents'
  | 'tracks'
  | 'inquiries'
  | 'directories'
  | 'serviceStatus'
  | 'maintenanceWindows'
  | 'serviceAvailability';

export const declaresEveryEndpoint: ExpectedEndpoints extends keyof DgiiEcfNamespace
  ? true
  : never = true;

export const declaresNothingElse: 'notAnEndpoint' extends keyof DgiiEcfNamespace
  ? never
  : true = true;

export type { api as DgiiEcfClientApi };
