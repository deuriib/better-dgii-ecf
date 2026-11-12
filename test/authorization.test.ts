import { beforeAll, describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, TAXPAYER_A, TAXPAYER_B } from './helpers.js';

/**
 * The authorization policy is the plugin's security boundary, so it is tested
 * from the outside: real sessions, real memberships, real roles.
 */
describe('authorization', () => {
  const fake = createFakeEcf();
  // Better Auth's test instance is invariant in its plugin tuple, so a hoisted
  // variable cannot keep the inferred type. These tests assert runtime policy,
  // not type inference: the typed surface is covered by `tsc` elsewhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let signInWithUser: any;
  let ownerHeaders: Headers;
  let memberHeaders: Headers;
  let outsiderHeaders: Headers;
  let memberId: string;
  let organizationId: string;

  beforeAll(async () => {
    instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({ environment: Environment.Dev, getClient: () => fake }),
      ],
    });
    auth = instance.auth;
    signInWithUser = instance.signInWithUser;

    const owner = await instance.signInWithTestUser();
    ownerHeaders = owner.headers;
    const created = await auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-authz', taxPayerId: TAXPAYER_A },
      headers: ownerHeaders,
    });
    organizationId = created.id;
    await auth.api.setActiveOrganization({
      body: { organizationId },
      headers: ownerHeaders,
    });

    const member = await auth.api.signUpEmail({
      body: { email: 'member@example.test', password: 'password-1234', name: 'Member' },
    });
    memberId = member.user.id;
    memberHeaders = (await signInWithUser('member@example.test', 'password-1234'))
      .headers;

    await auth.api.signUpEmail({
      body: {
        email: 'outsider@example.test',
        password: 'password-1234',
        name: 'Outsider',
      },
    });
    outsiderHeaders = (await signInWithUser('outsider@example.test', 'password-1234'))
      .headers;
  });

  it('refuses a session that is not a member of the organization', async () => {
    await auth.api
      .setActiveOrganization({
        body: { organizationId },
        headers: outsiderHeaders,
      })
      .catch(() => undefined);

    const failure = await auth.api
      .dgiiEcfResolveTaxPayer({ query: { organizationId }, headers: outsiderHeaders })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_NOT_A_MEMBER' },
    });
  });

  it('refuses a member whose role is not allowed', async () => {
    await auth.api.addMember({
      body: { organizationId, userId: memberId, role: 'member' },
      headers: ownerHeaders,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId },
      headers: memberHeaders,
    });

    const failure = await auth.api
      .dgiiEcfResolveTaxPayer({ query: {}, headers: memberHeaders })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_INSUFFICIENT_ROLE' },
    });
  });

  it('allows a member whose role is configured', async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          roles: ['member'],
        }),
      ],
    });
    const owner = await instance.signInWithTestUser();
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Contable', slug: 'contable', taxPayerId: TAXPAYER_A },
      headers: owner.headers,
    });
    const member = await instance.auth.api.signUpEmail({
      body: {
        email: 'member-role@example.test',
        password: 'password-1234',
        name: 'Member role',
      },
    });
    await instance.auth.api.addMember({
      body: {
        organizationId: created.id,
        userId: member.user.id,
        role: 'member',
      },
      headers: owner.headers,
    });
    const memberHeaders = (
      await instance.signInWithUser('member-role@example.test', 'password-1234')
    ).headers;
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers: memberHeaders,
    });

    const resolved = await instance.auth.api.dgiiEcfResolveTaxPayer({
      query: {},
      headers: memberHeaders,
    });
    expect(resolved.taxPayerId).toBe(TAXPAYER_A);
    expect(resolved.source).toBe('organization');
  });

  it('requires an organization when the plugin is installed and the request names none', async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({ environment: Environment.Dev, getClient: () => fake }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    const failure = await instance.auth.api
      .dgiiEcfResolveTaxPayer({ query: { taxPayerId: TAXPAYER_B }, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_ORGANIZATION_REQUIRED' },
    });
  });

  it('accepts an untrusted taxpayer only when explicitly allowed', async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          allowUntrustedTaxPayerId: true,
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    const response = await instance.auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: TAXPAYER_B },
      headers,
    });
    expect(response.taxPayerId).toBe(TAXPAYER_B);
    expect(response.organizationId).toBeNull();
  });

  it('reads a taxpayer id that another system wrote into the organization', async () => {
    const instance = await getTestInstance({
      plugins: [
        organization(),
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          organization: { extendSchema: true },
        }),
      ],
    });
    const { auth: readOnlyAuth, signInWithTestUser } = instance;
    const { headers } = await signInWithTestUser();

    const created = await readOnlyAuth.api.createOrganization({
      body: { name: 'Read only', slug: 'read-only' },
      headers,
    });
    await readOnlyAuth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    // `organization.extendSchema` is the read-only mode: the value is written by
    // another system (a back office, a sync job), never through the auth API.
    const context = await readOnlyAuth.$context;
    await context.adapter.update({
      model: 'organization',
      where: [{ field: 'id', value: created.id }],
      update: { taxPayerId: TAXPAYER_B },
    });

    const resolved = await readOnlyAuth.api.dgiiEcfResolveTaxPayer({
      query: {},
      headers,
    });
    expect(resolved.taxPayerId).toBe(TAXPAYER_B);
    expect(resolved.source).toBe('organization');
  });
});
