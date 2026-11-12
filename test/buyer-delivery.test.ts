import { describe, expect, it } from 'vitest';
import { BetterAuthError } from '@better-auth/core/error';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * Direct buyer delivery, closed by default.
 *
 * The DGII SDK authenticates against a buyer host by posting a signature made with
 * the organization's private key. Accepting that host from a request body is an
 * SSRF primitive *and* a signature oracle, so a request may only name a host the
 * operator configured.
 */
const build = async (buyerDelivery?: { hosts: Record<string, string> }) => {
  const fake = createFakeEcf();
  const instance = await getTestInstance({
    plugins: [
      organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
      dgiiEcf({
        verifyTaxPayerOwnership: () => true,
        environment: Environment.Dev,
        getClient: () => fake,
        ...(buyerDelivery === undefined ? {} : { buyerDelivery }),
      }),
    ],
  });
  const { headers } = await instance.signInWithTestUser();
  const created = await instance.auth.api.createOrganization({
    body: { name: 'Emisor', slug: 'emisor-buyer', taxPayerId: TAXPAYER_A },
    headers,
  });
  await instance.auth.api.setActiveOrganization({
    body: { organizationId: created.id },
    headers,
  });
  return { auth: instance.auth, headers, fake };
};

describe('buyer delivery', () => {
  it('resolves a configured name to its URL', async () => {
    const { auth, headers, fake } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });

    await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000801'), buyer: 'acme' },
      headers,
    });

    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendDocument',
      args: [expect.any(String), expect.any(String), 'https://fe.acme.example'],
    });
  });

  it('refuses a name that is not configured', async () => {
    const { auth, headers, fake } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });
    const callsBefore = fake.calls.length;

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A, 'E310000000802'), buyer: 'attacker' },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_BUYER_HOST_NOT_ALLOWED' },
    });
    // The refusal happens before anything is transmitted.
    expect(fake.calls.length).toBe(callsBefore);
  });

  it('refuses a buyer when the plugin has none configured', async () => {
    const { auth, headers, fake } = await build();
    const callsBefore = fake.calls.length;

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A, 'E310000000803'), buyer: 'acme' },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_BUYER_HOST_NOT_ALLOWED' },
    });
    expect(fake.calls.length).toBe(callsBefore);
  });

  it('rejects a URL in the body instead of ignoring it', async () => {
    // The previous contract accepted `buyerHost`. Silently dropping it would
    // deliver to DGII while the caller believes it went to its buyer.
    const { auth, headers } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });

    // A caller written against the old contract still sends the URL. `any` models
    // that stale client honestly: the request must be refused at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyBody: any = {
      xml: documentXml(TAXPAYER_A, 'E310000000804'),
      buyerHost: 'https://evil.example',
    };

    const failure = await auth.api
      .dgiiEcfSendDocument({ body: legacyBody, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 400 });
  });

  it('keeps the buyer host server-side when refusing', async () => {
    const { auth, headers } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });

    const failure = await auth.api
      .dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A, 'E310000000805'), buyer: 'nope' },
        headers,
      })
      .catch((error: unknown) => error);

    // The configured URLs are not echoed back to the caller.
    expect(JSON.stringify(failure)).not.toContain('fe.acme.example');
    expect(JSON.stringify(failure)).toContain('acme');
  });

  it('delivers a commercial approval to a configured host', async () => {
    const { auth, headers, fake } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });

    await auth.api.dgiiEcfSendCommercialApproval({
      body: {
        xml: documentXml(TAXPAYER_A, 'E310000000806', 'ACECF'),
        buyer: 'acme',
      },
      headers,
    });

    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendCommercialApproval',
      args: [expect.any(String), expect.any(String), 'https://fe.acme.example'],
    });
  });

  it('authenticates against a configured host rather than a URL', async () => {
    const { auth, headers, fake } = await build({
      hosts: { acme: 'https://fe.acme.example' },
    });

    await auth.api.dgiiEcfAuthenticate({ body: { buyer: 'acme' }, headers });

    expect(fake.calls.at(-1)).toMatchObject({
      method: 'authenticate',
      args: ['https://fe.acme.example'],
    });
  });
});

describe('buyer delivery configuration', () => {
  const base = {
    verifyTaxPayerOwnership: () => true,
    credentials: () => ({ key: 'k', cert: 'c' }),
  };

  it('rejects a non-HTTPS host at construction', () => {
    expect(() =>
      dgiiEcf({
        ...base,
        buyerDelivery: { hosts: { acme: 'http://fe.acme.example' } },
      }),
    ).toThrow(BetterAuthError);
  });

  it('rejects a host that is not a URL at construction', () => {
    expect(() =>
      dgiiEcf({ ...base, buyerDelivery: { hosts: { acme: 'fe.acme.example' } } }),
    ).toThrow(/https URL/);
  });

  it('rejects an empty host map at construction', () => {
    expect(() => dgiiEcf({ ...base, buyerDelivery: { hosts: {} } })).toThrow(
      /hosts\` is empty/,
    );
  });

  it('accepts a valid map', () => {
    expect(() =>
      dgiiEcf({
        ...base,
        buyerDelivery: { hosts: { acme: 'https://fe.acme.example' } },
      }),
    ).not.toThrow();
  });
});
