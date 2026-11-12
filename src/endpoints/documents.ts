import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';
import type {
  B2BCommercialApprovalResponse,
  CommercialApprovalResponse,
  InvoiceResponse,
} from '@deuriib/dgii-ecf';
import {
  assertIssuer,
  type DgiiEcfEndpointDeps,
  documentEncf,
  prepare,
  runSubmission,
  scopeEcho,
  signDocument,
  unwrap,
} from './shared.js';

/**
 * Document transmission endpoints.
 *
 * Every one of them takes XML — signed already, or signable — never a JSON
 * invoice model: building a DGII document is a domain problem the host owns,
 * while signing and transmitting are the plugin's. `sign: true` moves the
 * signature server-side, next to the key, which is the reason a browser can call
 * these endpoints at all without ever holding a certificate.
 */

const scopeShape = {
  taxPayerId: z.string().min(1).optional().meta({
    description:
      'Taxpayer id (RNC / cédula) to act for. Overrides the organization field for this request only.',
  }),
  organizationId: z.string().min(1).optional().meta({
    description:
      'Organization to act for. Defaults to the session active organization.',
  }),
};

const documentShape = {
  ...scopeShape,
  xml: z.string().min(1).meta({ description: 'The DGII document, as XML.' }),
  fileName: z.string().min(1).max(255).optional().meta({
    description: 'Multipart file name sent to DGII. Defaults to the document e-NCF.',
  }),
  sign: z.boolean().optional().meta({
    description:
      'Sign the XML server-side with the organization key before transmitting. Requires the `credentials` resolver.',
  }),
  idempotencyKey: z.string().min(1).max(200).optional().meta({
    description:
      'Replay guard key. Defaults to the SHA-256 of the document, so retrying the same document never double-issues.',
  }),
};

const fileNameFor = (xml: string, fallback: string): string => {
  const encf = documentEncf(xml);
  return encf === null ? `${fallback}.xml` : `${encf}.xml`;
};

/** POST /dgii-ecf/documents — route to the reception the document belongs to. */
export const sendDocument = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents',
    {
      method: 'POST',
      body: z.object({
        ...documentShape,
        buyerHost: z.string().url().optional().meta({
          description:
            'Deliver directly to the buyer Sender↔Receiver host instead of DGII.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml =
        ctx.body.sign === true
          ? await signDocument(deps, scope, ctx.body.xml)
          : ctx.body.xml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission({
        ctx,
        deps,
        scope,
        operation: 'sendDocument',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        send: () =>
          client.sendDocument(
            xml,
            ctx.body.fileName ?? fileNameFor(xml, 'document'),
            ctx.body.buyerHost,
          ),
      });

      return ctx.json({
        ...scopeEcho(scope),
        submissionId: outcome.submissionId,
        replayed: outcome.replayed,
        result: outcome.result,
      });
    },
  );

/** POST /dgii-ecf/documents/electronic — general e-CF reception only. */
export const sendElectronicDocument = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents/electronic',
    {
      method: 'POST',
      body: z.object({
        ...documentShape,
        buyerHost: z.string().url().optional(),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml =
        ctx.body.sign === true
          ? await signDocument(deps, scope, ctx.body.xml)
          : ctx.body.xml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission<InvoiceResponse>({
        ctx,
        deps,
        scope,
        operation: 'sendElectronicDocument',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        send: () =>
          client.sendElectronicDocument(
            xml,
            ctx.body.fileName ?? fileNameFor(xml, 'ecf'),
            ctx.body.buyerHost,
          ),
      });

      return ctx.json({
        ...scopeEcho(scope),
        submissionId: outcome.submissionId,
        replayed: outcome.replayed,
        result: outcome.result,
      });
    },
  );

/** POST /dgii-ecf/documents/summary — RFCE summary invoices only. */
export const sendSummary = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents/summary',
    {
      method: 'POST',
      body: z.object(documentShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml =
        ctx.body.sign === true
          ? await signDocument(deps, scope, ctx.body.xml)
          : ctx.body.xml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission({
        ctx,
        deps,
        scope,
        operation: 'sendSummary',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        send: () =>
          client.sendSummary(xml, ctx.body.fileName ?? fileNameFor(xml, 'summary')),
      });

      return ctx.json({
        ...scopeEcho(scope),
        submissionId: outcome.submissionId,
        replayed: outcome.replayed,
        result: outcome.result,
      });
    },
  );

/** POST /dgii-ecf/documents/commercial-approval — ACECF. */
export const sendCommercialApproval = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents/commercial-approval',
    {
      method: 'POST',
      body: z.object({
        ...documentShape,
        buyerHost: z.string().url().optional().meta({
          description: 'Deliver the approval directly to the issuer host.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml =
        ctx.body.sign === true
          ? await signDocument(deps, scope, ctx.body.xml)
          : ctx.body.xml;
      assertIssuer(xml, scope.taxPayerId);

      const buyerHost = ctx.body.buyerHost;
      const outcome = await runSubmission<
        CommercialApprovalResponse | B2BCommercialApprovalResponse
      >({
        ctx,
        deps,
        scope,
        operation: 'sendCommercialApproval',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        send: () => {
          const fileName = ctx.body.fileName ?? fileNameFor(xml, 'approval');
          return buyerHost === undefined
            ? client.sendCommercialApproval(xml, fileName)
            : client.sendCommercialApproval(xml, fileName, buyerHost);
        },
      });

      return ctx.json({
        ...scopeEcho(scope),
        submissionId: outcome.submissionId,
        replayed: outcome.replayed,
        result: outcome.result,
      });
    },
  );

/** POST /dgii-ecf/documents/void-range — ANECF range voiding. */
export const voidENCF = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents/void-range',
    {
      method: 'POST',
      body: z.object(documentShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml =
        ctx.body.sign === true
          ? await signDocument(deps, scope, ctx.body.xml)
          : ctx.body.xml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission({
        ctx,
        deps,
        scope,
        operation: 'voidENCF',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        send: () =>
          client.voidENCF(xml, ctx.body.fileName ?? fileNameFor(xml, 'void-range')),
      });

      return ctx.json({
        ...scopeEcho(scope),
        submissionId: outcome.submissionId,
        replayed: outcome.replayed,
        result: outcome.result,
      });
    },
  );

/**
 * POST /dgii-ecf/documents/reconcile — resolve a submission whose outcome is
 * unknown.
 *
 * This is the counterpart of the replay guard: when a pending record exists the
 * caller reconciles by e-NCF instead of re-sending, and DGII — not the plugin —
 * decides whether the document landed.
 */
export const reconcileSubmission = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/documents/reconcile',
    {
      method: 'POST',
      body: z.object({
        ...scopeShape,
        xml: z.string().min(1).meta({ description: 'The signed document, as XML.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      assertIssuer(ctx.body.xml, scope.taxPayerId);

      const result = unwrap(await client.reconcileSubmission(ctx.body.xml));
      return ctx.json({ ...scopeEcho(scope), result });
    },
  );
