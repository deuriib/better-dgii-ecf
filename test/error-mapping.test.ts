import { beforeAll, describe, expect, it } from 'vitest';
import { DgiiError } from '@deuriib/dgii-ecf';
import type { DgiiErrorCode } from '@deuriib/dgii-ecf';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { toApiError } from '../src/errors.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * DGII failures must reach the caller with a status that says who is at fault,
 * and without echoing anything sensitive from the upstream response.
 */
describe('DGII failure mapping', () => {
  it.each<[DgiiErrorCode, string]>([
    ['INVALID_XML', 'BAD_REQUEST'],
    ['SIGNING', 'BAD_REQUEST'],
    ['VALIDATION', 'BAD_REQUEST'],
    ['IDEMPOTENCY', 'CONFLICT'],
    ['CERTIFICATE', 'INTERNAL_SERVER_ERROR'],
    ['AUTH', 'BAD_GATEWAY'],
    ['HTTP', 'BAD_GATEWAY'],
    ['TIMEOUT', 'BAD_GATEWAY'],
    ['CIRCUIT_OPEN', 'BAD_GATEWAY'],
    ['UNKNOWN', 'BAD_GATEWAY'],
  ])('maps %s to %s', (code, status) => {
    const mapped = toApiError(new DgiiError('failure', { code, status: 503 }));
    expect(mapped.status).toBe(status);
    expect(mapped.body).toMatchObject({
      code: 'DGII_REQUEST_FAILED',
      dgii: { code, status: 503 },
    });
  });

  it('never carries the upstream payload, which may hold a bearer token', () => {
    const error = new DgiiError('auth failed', {
      code: 'AUTH',
      resource: 'ValidarSemilla',
      data: { token: 'dgii-token-must-not-leak' },
    });
    const mapped = toApiError(error);
    expect(JSON.stringify(mapped.body)).not.toContain('dgii-token-must-not-leak');
    expect(JSON.stringify(mapped.body)).toContain('ValidarSemilla');
  });

  it('keeps the DGII rejection messages', () => {
    const error = new DgiiError('rejected', {
      code: 'HTTP',
      status: 400,
      mensajes: [{ valor: 'El RNC no corresponde', codigo: 'RNC-001' }],
    });
    expect(toApiError(error).body?.dgii).toMatchObject({
      mensajes: [{ valor: 'El RNC no corresponde', codigo: 'RNC-001' }],
    });
  });
});

describe('DGII failure mapping over HTTP', () => {
  const failing = new DgiiError('DGII is not answering', {
    code: 'TIMEOUT',
    resource: 'recepcion/api/FacturasElectronicas',
    data: { token: 'dgii-token-must-not-leak' },
  });
  const fake = createFakeEcf({ failWith: failing });
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
        dgiiEcf({ environment: Environment.Dev, getClient: () => fake }),
      ],
    });
    auth = instance.auth;
    const signedIn = await instance.signInWithTestUser();
    headers = signedIn.headers;
    const created = await auth.api.createOrganization({
      body: { name: 'Emisor', slug: 'emisor-errors', taxPayerId: TAXPAYER_A },
      headers,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers,
    });
  });

  it('answers 502 for an upstream timeout and leaks nothing', async () => {
    const failure = await auth.api
      .dgiiEcfSendDocument({ body: { xml: documentXml(TAXPAYER_A) }, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'BAD_GATEWAY',
      body: {
        code: 'DGII_REQUEST_FAILED',
        dgii: { code: 'TIMEOUT', resource: 'recepcion/api/FacturasElectronicas' },
      },
    });
    expect(JSON.stringify(failure)).not.toContain('dgii-token-must-not-leak');
  });

  it('records the failed attempt so the audit trail shows it', async () => {
    const listing = await auth.api.dgiiEcfListSubmissions({ query: {}, headers });
    expect(
      listing.submissions.some(
        (record: { status: string; errorCode: string | null }) =>
          record.status === 'failed' && record.errorCode === 'DGII_REQUEST_FAILED',
      ),
    ).toBe(true);
  });

  it('lets the caller retry the same document after a failure', async () => {
    // The earlier attempt failed, which is not a replay: a failed record must not
    // block the corrected retry.
    const failure = await auth.api
      .dgiiEcfSendDocument({ body: { xml: documentXml(TAXPAYER_A) }, headers })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 'BAD_GATEWAY' });
  });
});
