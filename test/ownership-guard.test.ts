import { describe, expect, it, vi } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, TAXPAYER_A, TAXPAYER_B } from './helpers.js';

/**
 * The organization taxpayer id is the tenant boundary, so its write path is
 * guarded: whoever sets it must be confirmed as owning that RNC, by the host.
 *
 * Without this, an organization admin writes any RNC through
 * `organization.update` and then invoices as that taxpayer.
 */
const build = async (
  verify?: (context: { taxPayerId: string; organizationId: string | null }) => boolean,
) => {
  const fake = createFakeEcf();
  const instance = await getTestInstance({
    plugins: [
      organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
      dgiiEcf({
        environment: Environment.Dev,
        getClient: () => fake,
        ...(verify === undefined ? {} : { verifyTaxPayerOwnership: verify }),
      }),
    ],
  });
  const { headers } = await instance.signInWithTestUser();
  return { auth: instance.auth, headers, fake, instance };
};

const createOrg = (
  auth: Awaited<ReturnType<typeof build>>['auth'],
  headers: Headers,
  taxPayerId?: string,
) =>
  auth.api.createOrganization({
    body: {
      name: 'Emisor',
      slug: `emisor-${Math.random().toString(36).slice(2, 8)}`,
      ...(taxPayerId === undefined ? {} : { taxPayerId }),
    },
    headers,
  });

describe('organization taxpayer id', () => {
  it('refuses a write when no verification is configured', async () => {
    const { auth, headers } = await build();

    const failure = await createOrg(auth, headers, TAXPAYER_A).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_OWNERSHIP_UNVERIFIED' },
    });

    // The organization is not created with an unverified taxpayer id.
    const organizations = await auth.api.listOrganizations({ headers });
    expect(organizations).toHaveLength(0);
  });

  it('refuses a write the host does not confirm', async () => {
    const verify = vi.fn(() => false);
    const { auth, headers } = await build(verify);

    const failure = await createOrg(auth, headers, TAXPAYER_A).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ body: { code: 'DGII_OWNERSHIP_UNVERIFIED' } });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ taxPayerId: TAXPAYER_A, organizationId: null }),
    );
  });

  it('allows a write the host confirms, and the id then authorizes invoices', async () => {
    const verify = vi.fn(() => true);
    const { auth, headers } = await build(verify);

    const created = await createOrg(auth, headers, '5-31-05844-7');
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    // The hook sees the canonical id, not the formatted one.
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ taxPayerId: TAXPAYER_A }),
    );

    const resolved = await auth.api.dgiiEcfResolveTaxPayer({ query: {}, headers });
    expect(resolved.taxPayerId).toBe(TAXPAYER_A);
    expect(resolved.source).toBe('organization');
  });

  it('guards the update path too, with the organization in scope', async () => {
    const verify = vi.fn(() => true);
    const { auth, headers } = await build(verify);
    const created = await createOrg(auth, headers, TAXPAYER_A);

    verify.mockReturnValueOnce(false);
    const failure = await auth.api
      .updateOrganization({
        body: { organizationId: created.id, data: { taxPayerId: TAXPAYER_B } },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ body: { code: 'DGII_OWNERSHIP_UNVERIFIED' } });
    expect(verify).toHaveBeenLastCalledWith(
      expect.objectContaining({ taxPayerId: TAXPAYER_B, organizationId: created.id }),
    );
  });

  it('does not consult the hook when the field is not being written', async () => {
    const verify = vi.fn(() => true);
    const { auth, headers } = await build(verify);
    const created = await createOrg(auth, headers, TAXPAYER_A);
    verify.mockClear();

    await auth.api.updateOrganization({
      body: { organizationId: created.id, data: { name: 'Renamed' } },
      headers,
    });

    expect(verify).not.toHaveBeenCalled();
  });

  it('allows clearing the field, which removes the ability to invoice', async () => {
    const { auth, headers } = await build(() => true);
    const created = await createOrg(auth, headers, TAXPAYER_A);
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    // Better Auth's generated type does not model a nullable additional field;
    // clearing is a real operation (the organization stops being able to invoice).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clearBody: any = {
      organizationId: created.id,
      data: { taxPayerId: null },
    };
    await auth.api.updateOrganization({ body: clearBody, headers });

    const failure = await auth.api
      .dgiiEcfResolveTaxPayer({ query: {}, headers })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      body: { code: 'DGII_TAXPAYER_ID_REQUIRED' },
    });
  });
});
