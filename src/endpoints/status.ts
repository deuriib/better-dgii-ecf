import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';
import { StatusEnvironment } from '@deuriib/dgii-ecf';
import { type DgiiEcfEndpointDeps, prepare, scopeEcho, unwrap } from './shared.js';
import { DGII_ECF_ERROR_CODES, serverError } from '../errors.js';

/**
 * DGII operational endpoints.
 *
 * The status service answers "is DGII up right now", which a back office needs
 * before it lets anybody transmit. It takes an API key instead of the bearer
 * token, so it works without a session against DGII — but it still needs the
 * plugin's own session, because where an application exposes DGII health is a
 * business decision, not a public endpoint's.
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

/** Environments the status service names with its own numeric codes. */
const STATUS_ENVIRONMENTS = {
  precertification: StatusEnvironment.PreCertification,
  production: StatusEnvironment.Production,
  certification: StatusEnvironment.Certification,
} as const;

const requireStatusKey = (deps: DgiiEcfEndpointDeps): void => {
  if (deps.provider.constructsClients && deps.options.status?.apiKey === undefined) {
    throw serverError(DGII_ECF_ERROR_CODES.DGII_STATUS_API_KEY_REQUIRED);
  }
};

/**
 * POST /dgii-ecf/authenticate — warm the DGII token for a taxpayer.
 *
 * The token itself is never returned. It is a bearer credential for DGII, valid
 * for the certificate that minted it; handing it to a browser would undo the
 * reason this plugin exists. Callers get the validity window instead, which is
 * what a UI actually shows.
 */
export const authenticate = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/authenticate',
    {
      method: 'POST',
      body: z.object({
        ...scopeShape,
        buyerHost: z
          .string()
          .url()
          .optional()
          .meta({ description: 'Authenticate against a buyer Sender↔Receiver host.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { scope, client } = await prepare(deps, ctx, ctx.body);
      const token = unwrap(await client.authenticate(ctx.body.buyerHost));
      return ctx.json({
        ...scopeEcho(scope),
        issuedAt: token.expedido,
        expiresAt: token.expira,
      });
    },
  );

/** GET /dgii-ecf/service-status — operational status of every DGII service. */
export const serviceStatus = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/service-status',
    {
      method: 'GET',
      query: z.object(scopeShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      requireStatusKey(deps);
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const services = unwrap(await client.getServiceStatus());
      return ctx.json({ ...scopeEcho(scope), services });
    },
  );

/** GET /dgii-ecf/maintenance-windows — DGII scheduled maintenance. */
export const maintenanceWindows = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/maintenance-windows',
    {
      method: 'GET',
      query: z.object(scopeShape),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      requireStatusKey(deps);
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const windows = unwrap(await client.getMaintenanceWindows());
      return ctx.json({ ...scopeEcho(scope), windows });
    },
  );

/** GET /dgii-ecf/service-availability — is one environment inside a window. */
export const serviceAvailability = (deps: DgiiEcfEndpointDeps) =>
  createAuthEndpoint(
    '/dgii-ecf/service-availability',
    {
      method: 'GET',
      query: z.object({
        ...scopeShape,
        environment: z
          .enum(['precertification', 'production', 'certification'])
          .meta({ description: 'DGII environment to query.' }),
      }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      requireStatusKey(deps);
      const { scope, client } = await prepare(deps, ctx, ctx.query);
      const result = unwrap(
        await client.checkServiceAvailability(
          STATUS_ENVIRONMENTS[ctx.query.environment],
        ),
      );
      return ctx.json({
        ...scopeEcho(scope),
        environmentChecked: ctx.query.environment,
        estado: result.estado,
      });
    },
  );
