import { describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, documentXml, fakeCredentials, TAXPAYER_A } from './helpers.js';

/**
 * Credential mode and the configuration edges around it.
 *
 * This is the mode where the plugin builds `ECF` instances itself, so these
 * tests are the ones that prove the plugin refuses clearly instead of failing
 * deep inside the SDK.
 */
describe('credential mode', () => {
  const signOnly = (options: Parameters<typeof dgiiEcf>[0] = {}) =>
    getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          credentials: () => fakeCredentials,
          ...options,
        }),
      ],
    });

  it('refuses the status endpoints without a status API key', async () => {
    const { auth, signInWithTestUser } = await signOnly();
    const { headers } = await signInWithTestUser();
    const created = await auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-cred', taxPayerId: TAXPAYER_A },
      headers,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    const failure = await auth.api
      .dgiiEcfServiceStatus({ query: {}, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
      body: { code: 'DGII_STATUS_API_KEY_REQUIRED' },
    });
  });

  it('reports a signing failure instead of throwing from the SDK', async () => {
    const { auth, signInWithTestUser } = await signOnly();
    const { headers } = await signInWithTestUser();
    const created = await auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-cred-2', taxPayerId: TAXPAYER_A },
      headers,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A), sign: true },
        headers,
      })
      .catch((error: unknown) => error);

    // `fakeCredentials` is not a real PEM pair, so the signer rejects it and the
    // endpoint answers with the plugin's own signing error code.
    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_SIGNING_FAILED' },
    });
  });

  it('reports missing key material before attempting to sign', async () => {
    const { auth, signInWithTestUser } = await signOnly({
      credentials: () => ({}),
    });
    const { headers } = await signInWithTestUser();
    const created = await auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-cred-3', taxPayerId: TAXPAYER_A },
      headers,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A), sign: true },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
      body: { code: 'DGII_CREDENTIALS_UNAVAILABLE' },
    });
  });

  it('refuses to build at all with neither credentials nor a client', () => {
    expect(() =>
      dgiiEcf({ verifyTaxPayerOwnership: () => true, environment: Environment.Dev }),
    ).toThrow(/credentials.*getClient|getClient.*credentials/);
  });
});

describe('persistence disabled', () => {
  const fake = createFakeEcf();

  const build = async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
          persistence: { enabled: false },
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-nopersist', taxPayerId: TAXPAYER_A },
      headers,
    });
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });
    return { auth: instance.auth, headers };
  };

  it('transmits without recording anything', async () => {
    const { auth, headers } = await build();
    const xml = documentXml(TAXPAYER_A, 'E310000000401');

    const first = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(first.replayed).toBe(false);
    expect(first.submissionId).toBeNull();

    // With persistence off there is no replay guard: the same document is sent
    // again. That is the documented cost of disabling it.
    const second = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(second.replayed).toBe(false);
    expect(second.submissionId).toBeNull();
  });

  it('answers NOT_IMPLEMENTED for the audit listing', async () => {
    const { auth, headers } = await build();
    const failure = await auth.api
      .dgiiEcfListSubmissions({ query: {}, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'NOT_IMPLEMENTED',
      body: { code: 'DGII_PERSISTENCE_UNAVAILABLE' },
    });
  });

  it('replays without a stored response when responses are not retained', async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
          persistence: { storeResponses: false },
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-noresp', taxPayerId: TAXPAYER_A },
      headers,
    });
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    const xml = documentXml(TAXPAYER_A, 'E310000000402');
    await instance.auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    const replay = await instance.auth.api.dgiiEcfSendDocument({
      body: { xml },
      headers,
    });

    expect(replay.replayed).toBe(true);
    // Nothing was retained, so the caller learns the document is known but not
    // what DGII answered — the honest answer when responses are not stored.
    expect(replay.result).toBeNull();
  });
});

describe('plugin contract', () => {
  it('declares the submission table and its indexes', () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
    });
    const table = plugin.schema?.dgiiEcfSubmission;
    expect(table?.fields).toMatchObject({
      taxPayerId: { type: 'string', required: true },
      userId: { type: 'string', required: true },
      status: { type: 'string', required: true },
      createdAt: { type: 'date', required: true },
    });
    expect(table?.fields).toMatchObject({
      replayKey: { type: 'string', required: true, unique: true },
    });
    expect(table?.indexes).toEqual([
      { fields: ['taxPayerId', 'environment', 'encf'] },
      { fields: ['organizationId', 'createdAt'] },
    ]);
  });

  it('does not touch the organization table by default', () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
    });
    expect(plugin.schema?.organization).toBeUndefined();
  });

  it('adds only a read-only organization field when asked to', () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
      organization: { extendSchema: true, field: 'rnc' },
    });
    expect(plugin.schema?.organization?.fields).toMatchObject({
      rnc: { type: 'string', required: false, input: false },
    });
  });

  it('rate limits the whole plugin surface', () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
    });
    const rule = plugin.rateLimit?.[0];
    expect(rule?.pathMatcher('/dgii-ecf/documents')).toBe(true);
    expect(rule?.pathMatcher('/organization/create')).toBe(false);
    expect(rule).toMatchObject({ window: 60, max: 60 });
  });

  it('exposes the client provider so a rotated certificate can be dropped', async () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
    });
    await plugin.clientProvider.get({
      taxPayerId: TAXPAYER_A,
      organizationId: null,
      userId: 'user_1',
      environment: Environment.Dev,
    });
    expect(plugin.clientProvider.size).toBe(1);
    plugin.clientProvider.invalidate(TAXPAYER_A);
    expect(plugin.clientProvider.size).toBe(0);
  });

  it('publishes its error codes', () => {
    const plugin = dgiiEcf({
      verifyTaxPayerOwnership: () => true,
      environment: Environment.Dev,
      credentials: () => fakeCredentials,
    });
    expect(Object.keys(plugin.$ERROR_CODES ?? {})).toContain(
      'DGII_TAXPAYER_ID_REQUIRED',
    );
  });
});
