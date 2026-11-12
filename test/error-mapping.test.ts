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
    const mapped = toApiError(error);
    expect(mapped.status).toBe('BAD_REQUEST');
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body?.dgii).toMatchObject({
      status: 400,
      mensajes: [{ valor: 'El RNC no corresponde', codigo: 'RNC-001' }],
    });
  });

  /**
   * Every row of the upstream-status table in `docs/usage.md`.
   * `403`, `404`, `415` and `451` are the "other 4xx" row; `500`–`504` are
   * the "any 5xx" row. `408` and `429` stay retryable.
   */
  it.each<[string, string, number, number | undefined]>([
    ['400', 'BAD_REQUEST', 400, 400],
    ['409', 'CONFLICT', 409, 409],
    ['422', 'UNPROCESSABLE_ENTITY', 422, 422],
    ['403', 'BAD_REQUEST', 400, 403],
    ['404', 'BAD_REQUEST', 400, 404],
    ['415', 'BAD_REQUEST', 400, 415],
    ['451', 'BAD_REQUEST', 400, 451],
    ['408', 'BAD_GATEWAY', 502, 408],
    ['429', 'BAD_GATEWAY', 502, 429],
    ['500', 'BAD_GATEWAY', 502, 500],
    ['501', 'BAD_GATEWAY', 502, 501],
    ['502', 'BAD_GATEWAY', 502, 502],
    ['503', 'BAD_GATEWAY', 502, 503],
    ['504', 'BAD_GATEWAY', 502, 504],
    ['no status', 'BAD_GATEWAY', 502, undefined],
  ])(
    'maps upstream HTTP %s to %s (%i) and keeps status and mensajes',
    (label, status, statusCode, upstream) => {
      const mensajes = [{ valor: 'El e-NCF ya fue utilizado', codigo: 1200 }];
      const mapped = toApiError(
        new DgiiError(`rejected (${label})`, {
          code: 'HTTP',
          ...(upstream === undefined ? {} : { status: upstream }),
          mensajes,
        }),
      );
      expect(mapped.status).toBe(status);
      expect(mapped.statusCode).toBe(statusCode);
      expect(mapped.body).toMatchObject({
        code: 'DGII_REQUEST_FAILED',
        dgii: { code: 'HTTP', status: upstream, mensajes },
      });
    },
  );

  it('does not reclassify a non-HTTP SDK code from the upstream status', () => {
    // A DGII 401 is SDK code AUTH, not HTTP. It stays a retryable 502.
    const auth = toApiError(
      new DgiiError('unauthorized', { code: 'AUTH', status: 401 }),
    );
    expect(auth.status).toBe('BAD_GATEWAY');
    expect(auth.statusCode).toBe(502);
    expect(auth.body).toMatchObject({ dgii: { code: 'AUTH', status: 401 } });

    const validation = toApiError(
      new DgiiError('invalid', { code: 'VALIDATION', status: 422 }),
    );
    expect(validation.status).toBe('BAD_REQUEST');
    expect(validation.statusCode).toBe(400);
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
        dgiiEcf({
          verifyTaxPayerOwnership: () => true,
          environment: Environment.Dev,
          getClient: () => fake,
        }),
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

  it('records a timeout as unconfirmed, not failed', async () => {
    // "failed" would allow a retry, and a timeout may have delivered the document.
    const listing = await auth.api.dgiiEcfListSubmissions({ query: {}, headers });
    expect(
      listing.submissions.some(
        (record: { status: string; errorCode: string | null }) =>
          record.status === 'unconfirmed' && record.errorCode === 'TIMEOUT',
      ),
    ).toBe(true);
  });

  it('refuses to retry a document whose outcome is unconfirmed', async () => {
    const failure = await auth.api
      .dgiiEcfSendDocument({ body: { xml: documentXml(TAXPAYER_A) }, headers })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      status: 'CONFLICT',
      body: { code: 'DGII_IDEMPOTENCY_IN_FLIGHT' },
    });
  });
});
