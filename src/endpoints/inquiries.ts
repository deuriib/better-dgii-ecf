import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';
import { type DgiiEcfEndpointDeps, prepare, scopeEcho, unwrap } from './shared.js';

/**
 * Read-only DGII queries: tracking, existence checks and the service
 * directories.
 *
 * None of them mutate fiscal state, so none of them touch the replay guard, and
 * each one carries its own taxpayer scope check — a track id is not a secret, so
 * the only thing standing between organizations is the authorization performed
 * during scope resolution.
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

/** GET /dgii-ecf/tracks — DGII per-track result (`consultaresultado`). */
export const trackStatus = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/tracks',
    {
      method: 'GET',
      query: z.object({
        ...scopeShape,
        trackId: z.string().min(1).meta({ description: 'DGII track id.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const result = unwrap(await client.statusTrackId(ctx.query.trackId));
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );

/**
 * POST /dgii-ecf/inquiries/status — DGII existence read (`consultaestado`).
 *
 * DGII answers "No encontrado" for a document it never received, so this is the
 * read a caller uses to decide whether a pending submission landed.
 */
export const inquiryStatus = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/inquiries/status',
    {
      method: 'POST',
      body: z.object({
        ...scopeShape,
        ncf: z.string().min(1).meta({ description: 'The e-NCF to look up.' }),
        buyerTaxPayerId: z
          .string()
          .min(1)
          .optional()
          .meta({ description: 'Buyer RNC, when DGII needs it to disambiguate.' }),
        securityCode: z
          .string()
          .min(1)
          .optional()
          .meta({ description: 'Six-digit security code of the document.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const result = unwrap(
        await client.inquiryStatus(
          scope.taxPayerId,
          ctx.body.ncf,
          ctx.body.buyerTaxPayerId,
          ctx.body.securityCode,
        ),
      );
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );

/** POST /dgii-ecf/inquiries/tracks — every track DGII knows for an e-NCF. */
export const trackStatuses = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/inquiries/tracks',
    {
      method: 'POST',
      body: z.object({
        ...scopeShape,
        encf: z.string().min(1).meta({ description: 'The e-NCF to list tracks for.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const result = unwrap(
        await client.trackStatuses(scope.taxPayerId, ctx.body.encf),
      );
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );

/**
 * POST /dgii-ecf/inquiries/summary — RFCE inquiry.
 *
 * Production only: DGII does not publish the consumption-summary inquiry in the
 * certification environments, and the SDK refuses it there rather than returning
 * an empty answer that would read as "not found".
 */
export const summaryInvoiceInquiry = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/inquiries/summary',
    {
      method: 'POST',
      body: z.object({
        ...scopeShape,
        encf: z.string().min(1).meta({ description: 'The RFCE e-NCF to look up.' }),
        securityCode: z
          .string()
          .min(1)
          .meta({ description: 'Six-digit security code of the summary invoice.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const result = unwrap(
        await client.getSummaryInvoiceInquiry(
          scope.taxPayerId,
          ctx.body.encf,
          ctx.body.securityCode,
        ),
      );
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );

/** GET /dgii-ecf/directories/customers — the service directory for one RNC. */
export const customerDirectory = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/directories/customers',
    {
      method: 'GET',
      query: z.object({
        ...scopeShape,
        rnc: z.string().min(1).optional().meta({
          description:
            'RNC to look up. Defaults to the taxpayer this request acts for.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const result = unwrap(
        await client.getCustomerDirectory(ctx.query.rnc ?? scope.taxPayerId),
      );
      return ctx.json({ ...scopeEcho(scope), result: result ?? [] });
    },
  );

/** GET /dgii-ecf/directories — every receiver that publishes service URLs. */
export const directoryListing = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/directories/all',
    {
      method: 'GET',
      query: z.object(scopeShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const result = unwrap(await client.getDirectoryListing());
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );
