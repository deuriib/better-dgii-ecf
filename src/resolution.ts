import { APIError } from 'better-auth/api';
import { Environment } from '@deuriib/dgii-ecf';
import type { Session, User } from 'better-auth';
import type { GenericEndpointContext } from '@better-auth/core';
import { badRequest, DGII_ECF_ERROR_CODES, forbidden } from './errors.js';
import {
  applyTaxPayerIdValidation,
  normalizeTaxPayerId,
  TaxPayerIdError,
} from './tax-payer.js';
import type {
  DgiiEcfOptions,
  DgiiEcfScope,
  DgiiEcfTaxPayerIdSource,
  DgiiEcfTaxPayerIdResolver,
  TaxPayerIdValidation,
} from './types.js';

/** Organization model key used by the Better Auth organization plugin. */
const ORGANIZATION_MODEL = 'organization';
/** Membership model key used by the Better Auth organization plugin. */
const MEMBER_MODEL = 'member';

const DEFAULT_ROLES = ['owner', 'admin'];

/** The identity behind a call, resolved once per request. */
export interface DgiiEcfRequestScope extends DgiiEcfScope {
  readonly organizationTaxPayerId: string | null;
  readonly source: DgiiEcfTaxPayerIdSource;
  readonly user: User;
  readonly session: Session;
}

export interface DgiiEcfEndpointInput {
  taxPayerId?: string | undefined;
  organizationId?: string | undefined;
}

interface OrganizationRow extends Record<string, unknown> {
  id?: string;
}

interface MemberRow extends Record<string, unknown> {
  role?: unknown;
}

/**
 * True when the organization plugin is part of this Better Auth instance.
 *
 * The plugin never assumes it: without it there is no tenant model, and the
 * authorization policy degrades to the documented single-tenant mode instead of
 * silently failing every call.
 */
export const hasOrganizationPlugin = (ctx: GenericEndpointContext): boolean =>
  (ctx.context.options.plugins ?? []).some((plugin) => plugin.id === 'organization');

const readOrganizationField = (row: OrganizationRow, field: string): string | null => {
  // The declared field name wins; the snake_case spelling is accepted because a
  // host may map the column with `fieldName`.
  const raw = row[field] ?? row.taxPayerId ?? row.tax_payer_id;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = normalizeTaxPayerId(raw);
  return normalized === '' ? null : normalized;
};

const readActiveOrganizationId = (session: Session): string | null => {
  const raw = (session as { activeOrganizationId?: unknown }).activeOrganizationId;
  return typeof raw === 'string' && raw !== '' ? raw : null;
};

const rolesOf = (member: MemberRow): string[] =>
  String(member.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');

export interface ResolveScopeContext {
  readonly ctx: GenericEndpointContext;
  readonly options: DgiiEcfOptions;
  readonly input: DgiiEcfEndpointInput;
}

const environmentOf = async (
  options: DgiiEcfOptions,
  scope: Omit<DgiiEcfRequestScope, 'environment'>,
): Promise<Environment> => {
  const configured = options.environment ?? Environment.Dev;
  if (typeof configured === 'function') {
    return configured({
      taxPayerId: scope.taxPayerId,
      organizationId: scope.organizationId,
      userId: scope.user.id,
    });
  }
  return configured;
};

/**
 * Resolve (and authorize) the taxpayer a call acts for.
 *
 * Resolution order is fixed and observable to callers through the `source`
 * field returned by `GET /dgii-ecf/taxpayer`:
 *
 * 1. `taxPayerId` in the request — the per-call mode.
 * 2. The organization's stored field — the organization-plugin mode.
 * 3. The configured `resolveTaxPayerId` resolver — the user/tenant mapping mode.
 *
 * Authorization happens after resolution, never before — with the organization
 * plugin installed, a request-supplied id is checked against the organization's
 * stored id and the caller's role, so naming a taxpayer in the body cannot grant
 * access to it. Without the plugin there is no tenant model to check against,
 * and request-supplied ids are accepted (the documented single-tenant mode; see
 * `allowUntrustedTaxPayerId`).
 */
export const resolveRequestScope = async ({
  ctx,
  options,
  input,
}: ResolveScopeContext): Promise<DgiiEcfRequestScope> => {
  const authenticated = ctx.context.session;
  if (authenticated === null) {
    throw new APIError('UNAUTHORIZED', {
      message: DGII_ECF_ERROR_CODES.DGII_SESSION_REQUIRED.message,
      code: DGII_ECF_ERROR_CODES.DGII_SESSION_REQUIRED.code,
    });
  }
  const { user, session } = authenticated;

  const withOrganization = hasOrganizationPlugin(ctx);
  const organizationId =
    input.organizationId ??
    (withOrganization ? readActiveOrganizationId(session) : null);

  let organization: OrganizationRow | null = null;
  let organizationTaxPayerId: string | null = null;
  if (withOrganization && organizationId !== null) {
    organization = await ctx.context.adapter.findOne<OrganizationRow>({
      model: ORGANIZATION_MODEL,
      where: [{ field: 'id', value: organizationId }],
    });
    if (organization === null) {
      throw new APIError('NOT_FOUND', {
        message: DGII_ECF_ERROR_CODES.DGII_ORGANIZATION_NOT_FOUND.message,
        code: DGII_ECF_ERROR_CODES.DGII_ORGANIZATION_NOT_FOUND.code,
      });
    }
    organizationTaxPayerId = readOrganizationField(
      organization,
      options.organization?.field ?? 'taxPayerId',
    );
  }

  const validation: TaxPayerIdValidation = options.validateTaxPayerId ?? 'format';
  const toCanonical = async (raw: string): Promise<string> => {
    try {
      return await applyTaxPayerIdValidation(raw, validation);
    } catch (error) {
      if (error instanceof TaxPayerIdError) {
        throw badRequest(DGII_ECF_ERROR_CODES.DGII_TAXPAYER_ID_INVALID, error.message);
      }
      throw error;
    }
  };

  let taxPayerId: string | null = null;
  let source: DgiiEcfTaxPayerIdSource = 'request';

  if (input.taxPayerId !== undefined) {
    taxPayerId = await toCanonical(input.taxPayerId);
  } else if (organizationTaxPayerId !== null) {
    taxPayerId = await toCanonical(organizationTaxPayerId);
    source = 'organization';
  } else {
    const resolver: DgiiEcfTaxPayerIdResolver | undefined = options.resolveTaxPayerId;
    const fromResolver =
      resolver === undefined ? null : await resolver({ user, session, organizationId });
    if (fromResolver !== null) {
      taxPayerId = await toCanonical(fromResolver);
      source = 'resolver';
    }
  }

  if (taxPayerId === null) {
    throw badRequest(DGII_ECF_ERROR_CODES.DGII_TAXPAYER_ID_REQUIRED);
  }

  await authorize({
    ctx,
    options,
    user,
    session,
    taxPayerId,
    organizationId: withOrganization ? organizationId : null,
    organization,
    organizationTaxPayerId,
    source,
    withOrganization,
  });

  const resolved: Omit<DgiiEcfRequestScope, 'environment'> = {
    taxPayerId,
    organizationId: withOrganization ? organizationId : null,
    organizationTaxPayerId,
    source,
    userId: user.id,
    user,
    session,
  };

  return { ...resolved, environment: await environmentOf(options, resolved) };
};

interface AuthorizeInput {
  readonly ctx: GenericEndpointContext;
  readonly options: DgiiEcfOptions;
  readonly user: User;
  readonly session: Session;
  readonly taxPayerId: string;
  readonly organizationId: string | null;
  readonly organization: OrganizationRow | null;
  readonly organizationTaxPayerId: string | null;
  readonly source: DgiiEcfTaxPayerIdSource;
  readonly withOrganization: boolean;
}

/**
 * The built-in policy.
 *
 * With the organization plugin installed the tenant is the unit of trust: the
 * caller must be a member of the organization in scope, hold an allowed role,
 * and — when the organization stores a taxpayer id — the resolved id must be
 * that one. A request may name a taxpayer, but it cannot name one that the
 * organization does not own.
 *
 * Without the organization plugin there is nothing to check against, so the
 * request-supplied id is accepted: this is the single-tenant mode documented in
 * SECURITY.md. Installing the organization plugin is what turns the strict
 * policy on.
 */
const authorize = async (input: AuthorizeInput): Promise<void> => {
  const custom = input.options.authorize;
  if (custom !== undefined) {
    const allowed = await custom({
      user: input.user,
      session: input.session,
      taxPayerId: input.taxPayerId,
      organizationId: input.organizationId,
      organizationTaxPayerId: input.organizationTaxPayerId,
      source: input.source,
    });
    if (!allowed) {
      throw forbidden(DGII_ECF_ERROR_CODES.DGII_TAXPAYER_ID_FORBIDDEN);
    }
    return;
  }

  if (!input.withOrganization) {
    return;
  }

  if (input.organizationId === null || input.organization === null) {
    if (input.source === 'request' && input.options.allowUntrustedTaxPayerId === true) {
      return;
    }
    if (input.source === 'resolver') {
      // A resolver is server-side configuration: the host decided this mapping.
      return;
    }
    throw badRequest(DGII_ECF_ERROR_CODES.DGII_ORGANIZATION_REQUIRED);
  }

  const member = await input.ctx.context.adapter.findOne<MemberRow>({
    model: MEMBER_MODEL,
    where: [
      { field: 'organizationId', value: input.organizationId },
      { field: 'userId', value: input.user.id },
    ],
  });
  if (member === null) {
    throw forbidden(DGII_ECF_ERROR_CODES.DGII_NOT_A_MEMBER);
  }

  const allowedRoles = input.options.roles ?? DEFAULT_ROLES;
  const memberRoles = rolesOf(member);
  if (!memberRoles.some((role) => allowedRoles.includes(role))) {
    throw forbidden(
      DGII_ECF_ERROR_CODES.DGII_INSUFFICIENT_ROLE,
      `${DGII_ECF_ERROR_CODES.DGII_INSUFFICIENT_ROLE.message} (required one of: ${allowedRoles.join(', ')})`,
    );
  }

  if (
    input.organizationTaxPayerId !== null &&
    input.organizationTaxPayerId !== input.taxPayerId
  ) {
    throw forbidden(
      DGII_ECF_ERROR_CODES.DGII_TAXPAYER_ID_FORBIDDEN,
      `Organization ${input.organizationId} issues under ${input.organizationTaxPayerId}, not ${input.taxPayerId}`,
    );
  }
};
