import { beforeAll, describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_SUBMISSION_MESSAGE,
  DgiiError,
  PENDING_SUBMISSION_MESSAGE,
} from '@deuriib/dgii-ecf';
import type { DgiiErrorCode } from '@deuriib/dgii-ecf';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { isDefiniteRejection, toApiError, toFailureDetail } from '../src/errors.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

describe('isDefiniteRejection', () => {
  it('treats pre-transmission errors as definite rejections', () => {
    expect(isDefiniteRejection(new DgiiError('invalid', { code: 'INVALID_XML' }))).toBe(
      true,
    );
    expect(isDefiniteRejection(new DgiiError('signing', { code: 'SIGNING' }))).toBe(
      true,
    );
    expect(isDefiniteRejection(new DgiiError('cert', { code: 'CERTIFICATE' }))).toBe(
      true,
    );
    expect(isDefiniteRejection(new DgiiError('auth', { code: 'AUTH' }))).toBe(true);
    expect(
      isDefiniteRejection(new DgiiError('schema error', { code: 'VALIDATION' })),
    ).toBe(true);
  });

  it('treats post-2xx unreadable validation error as unconfirmed outcome', () => {
    const error = new DgiiError(
      'Unexpected DGII response payload; reconcile via a status lookup before retrying',
      { code: 'VALIDATION' },
    );
    expect(isDefiniteRejection(error)).toBe(false);
  });

  it('treats idempotency markers without definite cause as unconfirmed outcome', () => {
    const pending = new DgiiError(PENDING_SUBMISSION_MESSAGE, { code: 'IDEMPOTENCY' });
    expect(isDefiniteRejection(pending)).toBe(false);

    const ambiguous = new DgiiError(AMBIGUOUS_SUBMISSION_MESSAGE, {
      code: 'IDEMPOTENCY',
      cause: new DgiiError('timeout', { code: 'TIMEOUT' }),
    });
    expect(isDefiniteRejection(ambiguous)).toBe(false);
  });

  it('allows definite rejection through idempotency cause when wrapped', () => {
    const wrappedValidation = new DgiiError('idempotent validation failure', {
      code: 'IDEMPOTENCY',
      cause: new DgiiError('schema failure', { code: 'VALIDATION' }),
    });
    expect(isDefiniteRejection(wrappedValidation)).toBe(true);
  });

  it('treats HTTP 408 and 429 as unconfirmed, other 4xx as definite rejections, and 5xx as unconfirmed', () => {
    expect(
      isDefiniteRejection(new DgiiError('bad request', { code: 'HTTP', status: 400 })),
    ).toBe(true);
    expect(
      isDefiniteRejection(new DgiiError('unauthorized', { code: 'HTTP', status: 401 })),
    ).toBe(true);
    expect(
      isDefiniteRejection(new DgiiError('forbidden', { code: 'HTTP', status: 403 })),
    ).toBe(true);
    expect(
      isDefiniteRejection(new DgiiError('not found', { code: 'HTTP', status: 404 })),
    ).toBe(true);
    expect(
      isDefiniteRejection(
        new DgiiError('unprocessable', { code: 'HTTP', status: 422 }),
      ),
    ).toBe(true);

    expect(
      isDefiniteRejection(new DgiiError('timeout', { code: 'HTTP', status: 408 })),
    ).toBe(false);
    expect(
      isDefiniteRejection(new DgiiError('rate limited', { code: 'HTTP', status: 429 })),
    ).toBe(false);
    expect(
      isDefiniteRejection(new DgiiError('server error', { code: 'HTTP', status: 500 })),
    ).toBe(false);
    expect(
      isDefiniteRejection(new DgiiError('bad gateway', { code: 'HTTP', status: 502 })),
    ).toBe(false);
    expect(
      isDefiniteRejection(
        new DgiiError('service unavailable', { code: 'HTTP', status: 503 }),
      ),
    ).toBe(false);
  });

  it('treats timeouts, open circuits, and unknown errors as unconfirmed', () => {
    expect(isDefiniteRejection(new DgiiError('timeout', { code: 'TIMEOUT' }))).toBe(
      false,
    );
    expect(
      isDefiniteRejection(new DgiiError('circuit', { code: 'CIRCUIT_OPEN' })),
    ).toBe(false);
    expect(isDefiniteRejection(new DgiiError('unknown', { code: 'UNKNOWN' }))).toBe(
      false,
    );
  });
});

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

  it('forwards retryable and retryAfter in failure detail when present', () => {
    const error = new DgiiError('too many requests', {
      code: 'HTTP',
      status: 429,
      retryable: true,
      retryAfter: 60,
    });
    const detail = toFailureDetail(error);
    expect(detail).toMatchObject({
      code: 'HTTP',
      status: 429,
      retryable: true,
      retryAfter: 60,
    });
    expect(toApiError(error).body?.dgii).toMatchObject({
      retryable: true,
      retryAfter: 60,
    });
  });

  it('unwraps ambiguous submission cause in toApiError', () => {
    const cause = new DgiiError('connection timeout', {
      code: 'TIMEOUT',
      resource: 'recepcion/api/FacturasElectronicas',
      method: 'POST',
      retryable: true,
      retryAfter: 15,
    });
    const ambiguous = new DgiiError(AMBIGUOUS_SUBMISSION_MESSAGE, {
      code: 'IDEMPOTENCY',
      cause,
    });
    const mapped = toApiError(ambiguous);
    expect(mapped.status).toBe('BAD_GATEWAY');
    expect(mapped.body).toMatchObject({
      code: 'DGII_REQUEST_FAILED',
      message: AMBIGUOUS_SUBMISSION_MESSAGE,
      dgii: {
        code: 'TIMEOUT',
        resource: 'recepcion/api/FacturasElectronicas',
        method: 'POST',
        retryable: true,
        retryAfter: 15,
      },
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
