import { beforeAll, describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import {
  dgiiEcf,
  dgiiEcfOrganizationSchema,
  normalizeTaxPayerId,
} from '../src/index.js';
import { createFakeEcf, documentXml, TAXPAYER_A, TAXPAYER_B } from './helpers.js';

/**
 * Organization-mode integration: the taxpayer comes from the organization the
 * session is acting for, and a request that names a different taxpayer is
 * refused.
 */
describe('organization mode', () => {
  const fake = createFakeEcf();
  // The test instance is invariant in its plugin tuple, so a hoisted variable
  // cannot keep the inferred type. Runtime behaviour is what these tests assert;
  // the typed surface is proven in `client-types.ts` and by `tsc` over `src`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;
  let headers: Headers;
  let organizationId: string;

  beforeAll(async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({
          schema: { organization: dgiiEcfOrganizationSchema() },
        }),
        dgiiEcf({
          environment: Environment.Dev,
          getClient: () => fake,
          status: { apiKey: 'status-key' },
        }),
      ],
    });
    auth = instance.auth;

    const signedIn = await instance.signInWithTestUser();
    headers = signedIn.headers;

    const created = await auth.api.createOrganization({
      body: {
        name: 'Emisor A',
        slug: 'emisor-a',
        taxPayerId: '5-31-05844-7',
      },
      headers,
    });
    organizationId = created.id;

    await auth.api.setActiveOrganization({
      body: { organizationId },
      headers,
    });
  });

  it('resolves the taxpayer from the organization field, normalized', async () => {
    const resolved = await auth.api.dgiiEcfResolveTaxPayer({
      query: {},
      headers,
    });
    expect(resolved.taxPayerId).toBe(normalizeTaxPayerId(TAXPAYER_A));
    expect(resolved.organizationId).toBe(organizationId);
    expect(resolved.organizationTaxPayerId).toBe(TAXPAYER_A);
    expect(resolved.source).toBe('organization');
    expect(resolved.environment).toBe(Environment.Dev);
  });

  it('scopes an inquiry to the organization taxpayer', async () => {
    const response = await auth.api.dgiiEcfInquiryStatus({
      body: { ncf: 'E310000000001' },
      headers,
    });

    expect(response.taxPayerId).toBe(TAXPAYER_A);
    expect(response.result).toMatchObject({ estado: 'Aceptado' });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'inquiryStatus',
      args: [TAXPAYER_A, 'E310000000001', undefined, undefined],
    });
  });

  it('refuses a request that names another tenant taxpayer', async () => {
    const failure = await auth.api
      .dgiiEcfInquiryStatus({
        body: { ncf: 'E310000000001', taxPayerId: TAXPAYER_B },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_TAXPAYER_ID_FORBIDDEN' },
    });
  });

  it('accepts a request that repeats the organization taxpayer', async () => {
    const response = await auth.api.dgiiEcfInquiryStatus({
      body: { ncf: 'E310000000001', taxPayerId: '531-058-447' },
      headers,
    });
    expect(response.taxPayerId).toBe(TAXPAYER_A);
  });

  it('refuses an unknown organization', async () => {
    const failure = await auth.api
      .dgiiEcfResolveTaxPayer({
        query: { organizationId: 'org_does_not_exist' },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'NOT_FOUND',
      body: { code: 'DGII_ORGANIZATION_NOT_FOUND' },
    });
  });

  it('rejects a malformed taxpayer id with a 400', async () => {
    const failure = await auth.api
      .dgiiEcfInquiryStatus({
        body: { ncf: 'E310000000001', taxPayerId: '123' },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_TAXPAYER_ID_INVALID' },
    });
  });

  it('never returns the DGII bearer token', async () => {
    const response = await auth.api.dgiiEcfAuthenticate({
      body: {},
      headers,
    });

    expect(response).toMatchObject({
      taxPayerId: TAXPAYER_A,
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T01:00:00Z',
    });
    expect(JSON.stringify(response)).not.toContain(
      'dgii-token-that-must-never-be-returned',
    );
  });

  it('refuses a document issued by a different taxpayer', async () => {
    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_B) },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'DGII_TAXPAYER_ID_MISMATCH' },
    });
  });

  it('refuses a document with no issuer at all', async () => {
    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: '<ECF><Encabezado/></ECF>' },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_DOCUMENT_UNREADABLE' },
    });
  });

  it('serves the DGII service status', async () => {
    const response = await auth.api.dgiiEcfServiceStatus({
      query: {},
      headers,
    });
    expect(response.services).toEqual([
      { servicio: 'recepcion', estatus: 'Disponible', ambiente: 'TesteCF' },
    ]);
  });

  it('maps the status environment names to DGII codes', async () => {
    await auth.api.dgiiEcfServiceAvailability({
      query: { environment: 'production' },
      headers,
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'checkServiceAvailability',
      args: [2],
    });
  });

  it('defaults the customer directory to the resolved taxpayer', async () => {
    await auth.api.dgiiEcfCustomerDirectory({ query: {}, headers });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'getCustomerDirectory',
      args: [TAXPAYER_A],
    });
  });

  it('requires a session', async () => {
    const failure = await auth.api
      .dgiiEcfResolveTaxPayer({ query: {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 'UNAUTHORIZED' });
  });
});
