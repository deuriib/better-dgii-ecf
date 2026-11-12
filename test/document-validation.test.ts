import { describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { createFakeEcf, TAXPAYER_A } from './helpers.js';

/**
 * The document gate: an e-NCF DGII's own format rejects must not be transmitted,
 * and must not occupy a replay key either (the row is written after this check).
 */
const build = async () => {
  const fake = createFakeEcf();
  const instance = await getTestInstance({
    plugins: [
      organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
      dgiiEcf({ environment: Environment.Dev, getClient: () => fake }),
    ],
  });
  const { headers } = await instance.signInWithTestUser();
  const created = await instance.auth.api.createOrganization({
    body: {
      name: 'Emisor',
      slug: `emisor-encf-${Math.random().toString(36).slice(2, 8)}`,
      taxPayerId: TAXPAYER_A,
    },
    headers,
  });
  await instance.auth.api.setActiveOrganization({
    body: { organizationId: created.id },
    headers,
  });
  return { auth: instance.auth, headers, fake };
};

const xmlWith = (encf: string, root = 'ECF') =>
  `<?xml version="1.0" encoding="UTF-8"?><${root}><Encabezado><Emisor><RNCEmisor>${TAXPAYER_A}</RNCEmisor></Emisor><IdDoc><eNCF>${encf}</eNCF></IdDoc></Encabezado></${root}>`;

describe('e-NCF validation', () => {
  it('refuses an e-NCF whose type does not exist', async () => {
    const { auth, headers, fake } = await build();

    await expect(
      auth.api.dgiiEcfSendDocument({
        body: { xml: xmlWith('E990000000001') },
        headers,
      }),
    ).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_ENCF_INVALID' },
    });

    // Nothing was transmitted and nothing was recorded: the document cannot claim
    // the replay key of a document that will never be valid.
    expect(fake.methodNames()).not.toContain('sendDocument');
    const listing = await auth.api.dgiiEcfListSubmissions({ query: {}, headers });
    expect(listing.submissions).toHaveLength(0);
  });

  it('refuses an e-NCF with the wrong length', async () => {
    const { auth, headers } = await build();

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml: xmlWith('E3100000000') }, headers }),
    ).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'DGII_ENCF_INVALID' },
    });
  });

  it('accepts every documented e-NCF type', async () => {
    const { auth, headers } = await build();
    // 31 crédito fiscal, 32 consumo, 44 regímenes especiales, 41 compras.
    for (const encf of [
      'E310000000001',
      'E320000000002',
      'E440000000003',
      'E410000000004',
    ]) {
      const response = await auth.api.dgiiEcfSendDocument({
        body: { xml: xmlWith(encf) },
        headers,
      });
      expect(response.replayed).toBe(false);
    }
  });

  it('accepts an ANECF range whose starting e-NCF is valid', async () => {
    const { auth, headers } = await build();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ANECF><RncEmisor>${TAXPAYER_A}</RncEmisor><SecuenciaeNCFDesde>E310000000010</SecuenciaeNCFDesde></ANECF>`;

    const response = await auth.api.dgiiEcfVoidENCF({ body: { xml }, headers });
    expect(response.result).toBeDefined();
  });

  it('refuses an ANECF range whose starting e-NCF is invalid', async () => {
    const { auth, headers } = await build();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ANECF><RncEmisor>${TAXPAYER_A}</RncEmisor><SecuenciaeNCFDesde>E990000000010</SecuenciaeNCFDesde></ANECF>`;

    await expect(
      auth.api.dgiiEcfVoidENCF({ body: { xml }, headers }),
    ).rejects.toMatchObject({ body: { code: 'DGII_ENCF_INVALID' } });
  });

  it('leaves a document with no e-NCF to DGII', async () => {
    // Hand-built documents may carry no e-NCF at all; inventing a rule there would
    // refuse documents DGII accepts. The SDK and DGII own that judgement.
    const { auth, headers } = await build();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ECF><Encabezado><Emisor><RNCEmisor>${TAXPAYER_A}</RNCEmisor></Emisor></Encabezado></ECF>`;

    const response = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(response.replayed).toBe(false);
  });
});
