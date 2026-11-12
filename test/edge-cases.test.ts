import { describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, documentXml, fakeCredentials, TAXPAYER_A } from './helpers.js';

/**
 * Residual branches: per-scope environments, resolver failures, response
 * truncation and the audit filters. Small behaviours, but each one decides what a
 * caller sees when something is configured in an unexpected way.
 */
describe('edge cases', () => {
  it('resolves the environment per call when configured as a function', async () => {
    const fake = createFakeEcf();
    const instance = await getTestInstance({
      plugins: [
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: () => Environment.Cert,
          getClient: () => fake,
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    const resolved = await instance.auth.api.dgiiEcfResolveTaxPayer({
      query: { taxPayerId: TAXPAYER_A },
      headers,
    });
    expect(resolved.environment).toBe(Environment.Cert);
  });

  it('propagates a validator failure that is not a validation verdict', async () => {
    const fake = createFakeEcf();
    const instance = await getTestInstance({
      plugins: [
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
          validateTaxPayerId: () => {
            throw new Error('validator exploded');
          },
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    await expect(
      instance.auth.api.dgiiEcfResolveTaxPayer({
        query: { taxPayerId: TAXPAYER_A },
        headers,
      }),
    ).rejects.toThrow(/validator exploded/);
  });

  it('reports a resolver that returns no credentials at signing time', async () => {
    const instance = await getTestInstance({
      plugins: [
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          credentials: () => null,
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    const failure = await instance.auth.api
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

  it('truncates a stored response and replays it as unknown', async () => {
    const fake = createFakeEcf();
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
          persistence: { maxResponseLength: 4 },
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-trunc', taxPayerId: TAXPAYER_A },
      headers,
    });
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    const xml = documentXml(TAXPAYER_A, 'E310000000501');
    await instance.auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    const replay = await instance.auth.api.dgiiEcfSendDocument({
      body: { xml },
      headers,
    });

    expect(replay.replayed).toBe(true);
    // The stored body was cut at four characters, so it is not valid JSON: the
    // replay reports "known submission, unknown answer" rather than guessing.
    expect(replay.result).toBeNull();
  });

  it('limits the audit listing to the documented default', async () => {
    const fake = createFakeEcf();
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();
    const created = await instance.auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-limit', taxPayerId: TAXPAYER_A },
      headers,
    });
    await instance.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });

    for (let index = 0; index < 3; index += 1) {
      await instance.auth.api.dgiiEcfSendDocument({
        body: { xml: documentXml(TAXPAYER_A, `E31000000060${index}`) },
        headers,
      });
    }

    const listing = await instance.auth.api.dgiiEcfListSubmissions({
      query: {},
      headers,
    });
    expect(listing.submissions).toHaveLength(3);
  });

  it('reports a signing failure for a document with no root element', async () => {
    const instance = await getTestInstance({
      plugins: [
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          credentials: () => fakeCredentials,
        }),
      ],
    });
    const { headers } = await instance.signInWithTestUser();

    const failure = await instance.auth.api
      .dgiiEcfSendDocument({
        body: { xml: `${TAXPAYER_A}`, taxPayerId: TAXPAYER_A, sign: true },
        headers,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 'BAD_REQUEST' });
  });
});
