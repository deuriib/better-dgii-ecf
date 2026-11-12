import { beforeAll, describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { anecfXml, createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * One pass over every endpoint the plugin exposes, so the surface is proven
 * wired rather than assumed wired — including which DGII SDK method each one
 * calls and with which arguments.
 */
describe('endpoint surface', () => {
  const fake = createFakeEcf();
  // The test instance is invariant in its plugin tuple, so a hoisted variable
  // cannot keep the inferred type. Runtime behaviour is what these tests assert;
  // the typed surface is proven in `client-types.ts` and by `tsc` over `src`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;
  let headers: Headers;

  beforeAll(async () => {
    const instance = await getTestInstance({
      plugins: [
        organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
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
      body: { name: 'Emisor', slug: 'emisor-surface', taxPayerId: TAXPAYER_A },
      headers,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });
  });

  it('reconciles a submission by document', async () => {
    const response = await auth.api.dgiiEcfReconcileSubmission({
      body: { xml: documentXml(TAXPAYER_A) },
      headers,
    });
    expect(response.result).toMatchObject({ delivered: true });
    expect(fake.calls.at(-1)).toMatchObject({ method: 'reconcileSubmission' });
  });

  it('reconciles an ANECF document through the RncEmisor spelling', async () => {
    const response = await auth.api.dgiiEcfReconcileSubmission({
      body: { xml: anecfXml(TAXPAYER_A) },
      headers,
    });
    expect(response.taxPayerId).toBe(TAXPAYER_A);
  });

  it('sends through the pinned electronic reception', async () => {
    const response = await auth.api.dgiiEcfSendElectronicDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000301') },
      headers,
    });
    expect(response.result).toMatchObject({ trackId: 'track-electronic' });
  });

  it('sends a summary invoice', async () => {
    const response = await auth.api.dgiiEcfSendSummary({
      body: {
        xml: documentXml(TAXPAYER_A, 'E320000000001', 'RFCE'),
        fileName: 'rfce.xml',
      },
      headers,
    });
    expect(response.result).toMatchObject({ estado: 'Aceptado' });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendSummary',
      args: [expect.any(String), 'rfce.xml'],
    });
  });

  it('sends a commercial approval to DGII', async () => {
    const response = await auth.api.dgiiEcfSendCommercialApproval({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000302', 'ACECF') },
      headers,
    });
    expect(response.result).toMatchObject({ codigo: '1' });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendCommercialApproval',
      args: [expect.any(String), 'E310000000302.xml'],
    });
  });

  it('sends a commercial approval to a buyer host', async () => {
    const response = await auth.api.dgiiEcfSendCommercialApproval({
      body: {
        xml: documentXml(TAXPAYER_A, 'E310000000303', 'ACECF'),
        buyerHost: 'https://buyer.example.test',
      },
      headers,
    });
    expect(response.result).toBeDefined();
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendCommercialApproval',
      args: [expect.any(String), 'E310000000303.xml', 'https://buyer.example.test'],
    });
  });

  it('delivers a document to a buyer host when one is given', async () => {
    await auth.api.dgiiEcfSendDocument({
      body: {
        xml: documentXml(TAXPAYER_A, 'E310000000304'),
        buyerHost: 'https://buyer.example.test',
      },
      headers,
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'sendDocument',
      args: [expect.any(String), 'E310000000304.xml', 'https://buyer.example.test'],
    });
  });

  it('voids an e-NCF range', async () => {
    const response = await auth.api.dgiiEcfVoidENCF({
      body: { xml: anecfXml(TAXPAYER_A, 'E310000000310') },
      headers,
    });
    expect(response.result).toMatchObject({ nombre: 'Anulación' });
  });

  it('reads a track result', async () => {
    const response = await auth.api.dgiiEcfTrackStatus({
      query: { trackId: 'track-1' },
      headers,
    });
    expect(response.result).toMatchObject({ trackId: 'track-1' });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'statusTrackId',
      args: ['track-1'],
    });
  });

  it('lists every track for an e-NCF', async () => {
    const response = await auth.api.dgiiEcfTrackStatuses({
      body: { encf: 'E310000000001' },
      headers,
    });
    expect(response.result).toHaveLength(1);
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'trackStatuses',
      args: [TAXPAYER_A, 'E310000000001'],
    });
  });

  it('runs an RFCE inquiry', async () => {
    const response = await auth.api.dgiiEcfSummaryInvoiceInquiry({
      body: { encf: 'E320000000001', securityCode: '123456' },
      headers,
    });
    expect(response.result).toMatchObject({ encf: 'E320000000001' });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'getSummaryInvoiceInquiry',
      args: [TAXPAYER_A, 'E320000000001', '123456'],
    });
  });

  it('lists the general receiver directory', async () => {
    const response = await auth.api.dgiiEcfDirectoryListing({
      query: {},
      headers,
    });
    expect(response.result).toEqual([]);
  });

  it('reads the maintenance windows', async () => {
    const response = await auth.api.dgiiEcfMaintenanceWindows({
      query: {},
      headers,
    });
    expect(response.windows).toHaveLength(1);
  });

  it('forwards the buyer tax payer id and security code to the inquiry', async () => {
    await auth.api.dgiiEcfInquiryStatus({
      body: {
        ncf: 'E310000000001',
        buyerTaxPayerId: '101010101',
        securityCode: '654321',
      },
      headers,
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'inquiryStatus',
      args: [TAXPAYER_A, 'E310000000001', '101010101', '654321'],
    });
  });
});
