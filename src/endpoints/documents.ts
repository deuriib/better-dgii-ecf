import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';
import type {
  B2BCommercialApprovalResponse,
  CommercialApprovalResponse,
  EcfInvoice,
  InvoiceResponse,
} from '@deuriib/dgii-ecf';
import {
  assertIssuer,
  type DgiiEcfEndpointDeps,
  documentEncf,
  prepare,
  resolveDocumentXml,
  runSubmission,
  scopeEcho,
  signDocument,
  unwrap,
} from './shared.js';
import { createSubmissionStore } from '../persistence.js';
import { resolveBuyerHost } from '../buyer-delivery.js';

/**
 * Document transmission endpoints.
 *
 * Every one of them accepts either `xml` (as a signed or signable string) or
 * `json` (as an invoice object or JSON string) — building a DGII document is a
 * domain problem the host owns, while converting, signing, and transmitting are
 * the plugin's. When `json` is provided, `Transformer.json2xml` transforms it
 * with monetary half-up rounding (`round ?? true`). `sign: true` moves the
 * signature server-side, next to the key, which is the reason a browser can
 * call these endpoints at all without ever holding a certificate.
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

const jsonInvoiceSchema = z.union([
  z.custom<EcfInvoice | Record<string, unknown>>(
    (val) => typeof val === 'object' && val !== null && !Array.isArray(val),
    { message: 'Expected an invoice object' },
  ),
  z.string().min(1),
]);

const documentShape = {
  ...scopeShape,
  xml: z.string().min(1).optional().meta({ description: 'The DGII document, as XML.' }),
  json: jsonInvoiceSchema.optional().meta({
    description:
      'The DGII document, as a JSON invoice model or raw JSON string. Transformed to XML via `Transformer.json2xml`.',
  }),
  round: z.boolean().optional().meta({
    description:
      'Whether monetary values are rounded half-up to two decimal places when converting from JSON. Defaults to `true`.',
  }),
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
      body: z.strictObject({
        ...documentShape,
        buyer: z.string().min(1).optional().meta({
          description:
            'Name of a configured buyer host (`buyerDelivery.hosts`) to deliver to directly instead of DGII. A URL is never accepted from a request.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const buyerHost = resolveBuyerHost(deps.options, ctx.body.buyer);
      const rawXml = resolveDocumentXml(ctx.body);
      const xml =
        ctx.body.sign === true ? await signDocument(deps, scope, rawXml) : rawXml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission({
        ctx,
        deps,
        scope,
        operation: 'sendDocument',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        destination: buyerHost,
        send: () =>
          client.sendDocument(
            xml,
            ctx.body.fileName ?? fileNameFor(xml, 'document'),
            buyerHost,
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
      body: z.strictObject({
        ...documentShape,
        buyer: z.string().min(1).optional(),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const buyerHost = resolveBuyerHost(deps.options, ctx.body.buyer);
      const rawXml = resolveDocumentXml(ctx.body);
      const xml =
        ctx.body.sign === true ? await signDocument(deps, scope, rawXml) : rawXml;
      assertIssuer(xml, scope.taxPayerId);

      const outcome = await runSubmission<InvoiceResponse>({
        ctx,
        deps,
        scope,
        operation: 'sendElectronicDocument',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        destination: buyerHost,
        send: () =>
          client.sendElectronicDocument(
            xml,
            ctx.body.fileName ?? fileNameFor(xml, 'ecf'),
            buyerHost,
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
      body: z.strictObject(documentShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const rawXml = resolveDocumentXml(ctx.body);
      const xml =
        ctx.body.sign === true ? await signDocument(deps, scope, rawXml) : rawXml;
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
      body: z.strictObject({
        ...documentShape,
        buyer: z.string().min(1).optional().meta({
          description:
            'Name of a configured buyer host (`buyerDelivery.hosts`) to deliver the approval directly.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const rawXml = resolveDocumentXml(ctx.body);
      const xml =
        ctx.body.sign === true ? await signDocument(deps, scope, rawXml) : rawXml;
      assertIssuer(xml, scope.taxPayerId);

      const buyerHost = resolveBuyerHost(deps.options, ctx.body.buyer);
      const outcome = await runSubmission<
        CommercialApprovalResponse | B2BCommercialApprovalResponse
      >({
        ctx,
        deps,
        scope,
        operation: 'sendCommercialApproval',
        xml,
        idempotencyKey: ctx.body.idempotencyKey,
        destination: buyerHost,
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
      body: z.strictObject(documentShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const rawXml = resolveDocumentXml(ctx.body);
      const xml =
        ctx.body.sign === true ? await signDocument(deps, scope, rawXml) : rawXml;
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
      body: z.strictObject({
        ...scopeShape,
        xml: z
          .string()
          .min(1)
          .optional()
          .meta({ description: 'The signed document, as XML.' }),
        json: jsonInvoiceSchema.optional().meta({
          description: 'The document, as a JSON invoice model or raw JSON string.',
        }),
        round: z.boolean().optional().meta({
          description:
            'Whether monetary values are rounded half-up to two decimal places when converting from JSON. Defaults to `true`.',
        }),
        buyer: z.string().min(1).optional().meta({
          description:
            'Name of a configured buyer host (`buyerDelivery.hosts`) to reconcile against.',
        }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const xml = resolveDocumentXml(ctx.body);
      assertIssuer(xml, scope.taxPayerId);

      const buyerHost = resolveBuyerHost(deps.options, ctx.body.buyer);
      const result = unwrap(
        await (buyerHost === undefined
          ? client.reconcileSubmission(xml)
          : client.reconcileSubmission(xml, buyerHost)),
      );

      // Reconcile is the only exit from `pending`/`unconfirmed`, so it has to
      // close the records it just settled — otherwise the conflict it resolves
      // outlives the answer, and the caller stays blocked forever.
      const store = createSubmissionStore(ctx, deps.options.persistence);
      const closedRecords = await store.reconcile({
        environment: scope.environment,
        organizationId: scope.organizationId,
        taxPayerId: scope.taxPayerId,
        encf: documentEncf(xml),
        delivered: result.delivered,
        response: result,
        destination: buyerHost,
      });

      return ctx.json({ ...scopeEcho(scope), result, closedRecords });
    },
  );
