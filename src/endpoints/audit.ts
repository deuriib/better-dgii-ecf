import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';
import { type DgiiEcfEndpointDeps, prepare, scopeEcho } from './shared.js';
import { createSubmissionStore } from '../persistence.js';

/**
 * Introspection endpoints: "which taxpayer will this call use" and "what has
 * already been submitted".
 *
 * Both exist because the two hardest questions in a multi-tenant fiscal
 * integration are answered by the server, not by the client's own bookkeeping.
 */

const scopeShape = {
  taxPayerId: z.string().min(1).optional().meta({
    description:
      'Taxpayer id (RNC / cédula) to act for. Overrides the organization field.',
  }),
  organizationId: z.string().min(1).optional().meta({
    description:
      'Organization to act for. Defaults to the session active organization.',
  }),
};

/**
 * GET /dgii-ecf/taxpayer — the resolved identity of the next call.
 *
 * `source` says which of the three resolution modes answered, which is what a
 * UI needs to explain itself ("this invoice will be issued as RNC … because your
 * organization stores it") instead of guessing.
 */
export const resolveTaxPayer = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/taxpayer',
    {
      method: 'GET',
      query: z.object(scopeShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope } = await prepare(deps, ctx, ctx.query);
      return ctx.json({
        taxPayerId: scope.taxPayerId,
        organizationId: scope.organizationId,
        organizationTaxPayerId: scope.organizationTaxPayerId,
        source: scope.source,
        environment: scope.environment,
      });
    },
  );

/** GET /dgii-ecf/submissions — the audit trail for the scope in question. */
export const listSubmissions = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/submissions',
    {
      method: 'GET',
      query: z.object({
        ...scopeShape,
        limit: z.coerce.number().int().min(1).max(100).optional().meta({
          description: 'Maximum number of records to return. Defaults to 20.',
        }),
        status: z
          .enum(['pending', 'succeeded', 'failed'])
          .optional()
          .meta({ description: 'Filter by record status.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope } = await prepare(deps, ctx, ctx.query);
      const store = createSubmissionStore(ctx, deps.options.persistence);

      // Filtering happens here rather than in the query: the adapter's `where`
      // set is built from authorized values only, so a caller cannot widen the
      // listing by inventing an organization id.
      const records = await store.list({
        organizationId: scope.organizationId,
        taxPayerId: scope.organizationId === null ? scope.taxPayerId : null,
        limit: Math.min(ctx.query.limit ?? 20, 100),
      });

      const filtered =
        ctx.query.status === undefined
          ? records
          : records.filter((record) => record.status === ctx.query.status);

      return ctx.json({
        ...scopeEcho(scope),
        submissions: filtered.map((record) => ({
          id: record.id,
          operation: record.operation,
          status: record.status,
          taxPayerId: record.taxPayerId,
          organizationId: record.organizationId ?? null,
          environment: record.environment,
          encf: record.encf ?? null,
          trackId: record.trackId ?? null,
          documentHash: record.documentHash ?? null,
          errorCode: record.errorCode ?? null,
          createdAt: record.createdAt ?? null,
        })),
      });
    },
  );
