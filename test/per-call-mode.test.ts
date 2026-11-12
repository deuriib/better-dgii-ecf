import { describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, documentXml, TAXPAYER_A, TAXPAYER_B } from './helpers.js';

/**
 * Without the organization plugin there is no tenant model, so the documented
 * single-tenant mode accepts the taxpayer named by the request. These tests pin
 * that contract down, including the resolver and the "no source at all" case.
 */
describe('per-call mode (no organization plugin)', () => {
  const fake = createFakeEcf();

  const build = (options: Parameters<typeof dgiiEcf>[0] = {}) =>
    getTestInstance({
      plugins: [
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          ...options,
        }),
      ],
    });

  it('uses the requested taxpayer and normalizes it', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfInquiryStatus({
      body: { ncf: 'E310000000001', taxPayerId: '5-31-05844-7' },
      headers,
    });

    expect(response.taxPayerId).toBe(TAXPAYER_A);
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'inquiryStatus',
      args: [TAXPAYER_A, 'E310000000001', undefined, undefined],
    });
  });

  it('requires a taxpayer when the request names none', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    const failure = await auth.api
      .dgiiEcfInquiryStatus({ body: { ncf: 'E310000000001' }, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_TAXPAYER_ID_REQUIRED' },
    });
  });

  it('falls back to the configured resolver', async () => {
    const { auth, signInWithTestUser } = await build({
      resolveTaxPayerId: ({ user }) => (user.email ? TAXPAYER_A : null),
    });
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfResolveTaxPayer({
      query: {},
      headers,
    });

    expect(response.taxPayerId).toBe(TAXPAYER_A);
    expect(response.source).toBe('resolver');
    expect(response.organizationId).toBeNull();
  });

  it('prefers the request over the resolver', async () => {
    const { auth, signInWithTestUser } = await build({
      resolveTaxPayerId: () => TAXPAYER_A,
    });
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: TAXPAYER_B },
      headers,
    });

    expect(response.taxPayerId).toBe(TAXPAYER_B);
    expect(response.source).toBe('request');
  });

  it('lets a custom authorizer deny a request', async () => {
    const { auth, signInWithTestUser } = await build({
      authorize: ({ taxPayerId }) => taxPayerId !== TAXPAYER_B,
    });
    const { headers } = await signInWithTestUser();

    await expect(
      auth.api.dgiiEcfResolveTaxPayer({
        query: { taxPayerId: TAXPAYER_B },
        headers,
      }),
    ).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_TAXPAYER_ID_FORBIDDEN' },
    });
  });

  it('lets a custom authorizer allow a request the default policy would deny', async () => {
    const { auth, signInWithTestUser } = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          authorize: ({ taxPayerId }) => taxPayerId === TAXPAYER_B,
        }),
      ],
    });
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: TAXPAYER_B },
      headers,
    });
    expect(response.taxPayerId).toBe(TAXPAYER_B);
  });

  it('accepts a cédula as the taxpayer shape', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: '026-0132209-8' },
      headers,
    });
    expect(response.taxPayerId).toBe('02601322098');
  });

  it('honours a custom validator that rewrites the id', async () => {
    const { auth, signInWithTestUser } = await build({
      validateTaxPayerId: (value) => `1${value}`,
    });
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: '31123456' },
      headers,
    });
    // The custom validator replaces the id, so no check digit runs on its output.
    expect(response.taxPayerId).toBe('131123456');
  });

  it('accepts unsigned documents that already carry the issuer', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    const response = await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A), taxPayerId: TAXPAYER_A },
      headers,
    });

    expect(response.result).toMatchObject({ trackId: 'track-document' });
    expect(fake.methodNames()).toContain('sendDocument');
  });

  it('derives the multipart file name from the e-NCF', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000042'), taxPayerId: TAXPAYER_A },
      headers,
    });

    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendDocument',
      args: [expect.any(String), 'E310000000042.xml', undefined],
    });
  });

  it('refuses server-side signing when the host owns the client', async () => {
    const { auth, signInWithTestUser } = await build();
    const { headers } = await signInWithTestUser();

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A), taxPayerId: TAXPAYER_A, sign: true },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
      body: { code: 'DGII_CREDENTIALS_UNAVAILABLE' },
    });
  });
});
