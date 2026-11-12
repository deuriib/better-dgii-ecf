import { beforeAll, describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { dgiiEcfClient } from '../src/client.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * The client plugin adds no code of its own — it makes Better Auth infer the
 * methods from the server plugin. That inference is only worth anything if the
 * inferred path, method and payload actually reach the endpoint, so it is tested
 * against the real handler rather than against a type assertion.
 */
describe('client plugin', () => {
  const fake = createFakeEcf();
  // The test instance is invariant in its plugin tuple, so a hoisted variable
  // cannot keep the inferred type. Runtime behaviour is what these tests assert;
  // the typed surface is proven in `client-types.ts` and by `tsc` over `src`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let headers: Headers;

  beforeAll(async () => {
    const instance = await getTestInstance(
      {
        plugins: [
          organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
          dgiiEcf({ environment: Environment.Dev, getClient: () => fake }),
        ],
      },
      { clientOptions: { plugins: [dgiiEcfClient()] } },
    );
    client = instance.client;

    const signedIn = await instance.signInWithTestUser();
    headers = signedIn.headers;
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-client', taxPayerId: TAXPAYER_A },
      headers,
    });
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });
  });

  it('exposes the taxpayer lookup under the dgiiEcf namespace', async () => {
    const { data, error } = await client.dgiiEcf.taxpayer({
      query: {},
      fetchOptions: { headers },
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ taxPayerId: TAXPAYER_A, source: 'organization' });
  });

  it('sends a document through the inferred POST endpoint', async () => {
    const { data, error } = await client.dgiiEcf.documents({
      xml: documentXml(TAXPAYER_A, 'E310000000201'),
      fetchOptions: { headers },
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ taxPayerId: TAXPAYER_A, replayed: false });
    expect(fake.methodNames()).toContain('sendDocument');
  });

  it('reaches the nested inquiry endpoints', async () => {
    const { data, error } = await client.dgiiEcf.inquiries.status({
      ncf: 'E310000000001',
      fetchOptions: { headers },
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ result: { estado: 'Aceptado' } });
  });

  it('surfaces a plugin error code to the client', async () => {
    const { data, error } = await client.dgiiEcf.inquiries.status({
      ncf: 'E310000000001',
      taxPayerId: '101010101',
      fetchOptions: { headers },
    });

    expect(data).toBeNull();
    expect(error?.code).toBe('DGII_TAXPAYER_ID_FORBIDDEN');
  });
});
