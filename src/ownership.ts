import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { forbidden, DGII_ECF_ERROR_CODES } from './errors.js';
import { normalizeTaxPayerId } from './tax-payer.js';
import type { DgiiEcfOptions } from './types.js';

/**
 * Guard the organization's taxpayer field at its **write** path.
 *
 * The plugin's tenant boundary is "the organization owns this RNC". Declaring the
 * field through `dgiiEcfOrganizationSchema()` makes it part of the organization
 * plugin's input schema, which means an organization admin can set it — so the
 * boundary would be a formality: join any organization, write the RNC you want, and
 * invoice as that taxpayer.
 *
 * The plugin cannot verify ownership itself; only the host can (against DGII's
 * registry, an onboarding record, or a certificate it issued). What the plugin can
 * do is refuse to let the value change without that check, which is what this hook
 * does:
 *
 * - `verifyTaxPayerOwnership` configured and returning `true` → the write proceeds.
 * - returning `false` → `403 DGII_OWNERSHIP_UNVERIFIED`.
 * - not configured → also refused. Failing open here would keep the vulnerability
 *   while presenting the mitigation, which is worse than either extreme.
 *
 * The read path is not re-checked: if every write went through this guard, the
 * stored value is as trustworthy as the host's verification.
 */
export const organizationTaxPayerIdGuard = (
  options: DgiiEcfOptions,
): {
  matcher: (context: { path?: string }) => boolean;
  handler: ReturnType<typeof createAuthMiddleware>;
} => {
  const field = options.organization?.field ?? 'taxPayerId';

  return {
    matcher: (context) =>
      context.path === '/organization/create' ||
      context.path === '/organization/update',
    handler: createAuthMiddleware(async (ctx) => {
      const path = ctx.path ?? '';
      const body = ctx.body as Record<string, unknown> | undefined;
      if (body === undefined) {
        return;
      }

      // `/organization/create` takes the fields at the top level;
      // `/organization/update` nests them under `data`.
      const incoming =
        path === '/organization/update'
          ? (body.data as Record<string, unknown> | undefined)?.[field]
          : body[field];

      if (incoming === undefined || incoming === null) {
        // Clearing the field is a legitimate operation: the organization stops
        // being able to invoice, which is not an escalation.
        return;
      }
      if (typeof incoming !== 'string') {
        throw forbidden(
          DGII_ECF_ERROR_CODES.DGII_OWNERSHIP_UNVERIFIED,
          `The organization field "${field}" must be a string`,
        );
      }

      const session = await getSessionFromCtx(ctx);
      if (session === null) {
        throw forbidden(
          DGII_ECF_ERROR_CODES.DGII_OWNERSHIP_UNVERIFIED,
          'Setting the organization taxpayer id requires an authenticated session',
        );
      }

      const taxPayerId = normalizeTaxPayerId(incoming);
      const verify = options.verifyTaxPayerOwnership;
      if (verify === undefined) {
        throw forbidden(
          DGII_ECF_ERROR_CODES.DGII_OWNERSHIP_UNVERIFIED,
          `Refusing to set "${field}" without a verification: configure \`verifyTaxPayerOwnership\`, or keep the field read-only (\`organization.extendSchema: true\`) and write it from your own verified path.`,
        );
      }

      const organizationId =
        path === '/organization/update'
          ? typeof body.organizationId === 'string'
            ? body.organizationId
            : ((session.session as { activeOrganizationId?: string | null })
                .activeOrganizationId ?? null)
          : null;

      const owned = await verify({
        taxPayerId,
        organizationId,
        user: session.user,
        session: session.session,
      });
      if (!owned) {
        throw forbidden(
          DGII_ECF_ERROR_CODES.DGII_OWNERSHIP_UNVERIFIED,
          `Taxpayer ${taxPayerId} was not confirmed as owned by this organization`,
        );
      }
    }),
  };
};
