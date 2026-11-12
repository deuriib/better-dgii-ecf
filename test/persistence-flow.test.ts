import { beforeAll, describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema, SUBMISSION_MODEL } from '../src/index.js';
import { hashDocument } from '../src/persistence.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * Replay safety and the audit trail.
 *
 * The behaviour under test is the one that has fiscal consequences: the second
 * POST of the same document must not reach DGII, and a record left `pending` by
 * an interrupted attempt must block a retry instead of risking a duplicate.
 */
describe('submission persistence', () => {
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
      body: { name: 'Emisor A', slug: 'emisor-persist', taxPayerId: TAXPAYER_A },
      headers,
    });
    organizationId = created.id;
    await auth.api.setActiveOrganization({ body: { organizationId }, headers });
  });

  it('records a submission and replays it instead of resending', async () => {
    const xml = documentXml(TAXPAYER_A, 'E310000000101');

    const first = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(first.replayed).toBe(false);
    expect(first.submissionId).toBeTruthy();

    const sentAfterFirst = fake
      .methodNames()
      .filter((m) => m === 'sendDocument').length;

    const second = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);

    const sentAfterSecond = fake
      .methodNames()
      .filter((m) => m === 'sendDocument').length;
    expect(sentAfterSecond).toBe(sentAfterFirst);
  });

  it('treats a different document as a new submission', async () => {
    const a = await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000102') },
      headers,
    });
    const b = await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000103') },
      headers,
    });

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.submissionId).not.toBe(b.submissionId);
  });

  it('honours an explicit idempotency key over the document hash', async () => {
    const first = await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000104'), idempotencyKey: 'k-1' },
      headers,
    });
    const replay = await auth.api.dgiiEcfSendDocument({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000105'), idempotencyKey: 'k-1' },
      headers,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.submissionId).toBe(first.submissionId);
  });

  it('refuses a retry while an earlier attempt is still pending', async () => {
    const xml = documentXml(TAXPAYER_A, 'E310000000106');
    const context = await auth.$context;
    const hash = hashDocument(xml);

    await context.adapter.create({
      model: SUBMISSION_MODEL,
      data: {
        organizationId,
        taxPayerId: TAXPAYER_A,
        userId: 'user_pending',
        environment: Environment.Dev,
        operation: 'sendDocument',
        status: 'pending',
        idempotencyKey: hash,
        encf: 'E310000000106',
        trackId: null,
        documentHash: hash,
        errorCode: null,
        response: null,
        createdAt: new Date(),
        updatedAt: null,
      },
    });

    const failure = await auth.api
      .dgiiEcfSendDocument({ body: { xml }, headers })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 'CONFLICT',
      body: { code: 'DGII_IDEMPOTENCY_IN_FLIGHT' },
    });
  });

  it('lists the audit trail for the organization', async () => {
    const listing = await auth.api.dgiiEcfListSubmissions({
      query: { limit: 50 },
      headers,
    });

    expect(listing.taxPayerId).toBe(TAXPAYER_A);
    expect(listing.submissions.length).toBeGreaterThan(0);
    expect(listing.submissions[0]).toMatchObject({
      organizationId,
      taxPayerId: TAXPAYER_A,
      status: expect.stringMatching(/pending|succeeded|failed/),
      environment: Environment.Dev,
    });
    // The stored document is a hash, never the document itself.
    for (const record of listing.submissions as { documentHash: string | null }[]) {
      expect(record.documentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('filters the listing by status', async () => {
    const listing = await auth.api.dgiiEcfListSubmissions({
      query: { status: 'succeeded' },
      headers,
    });
    expect(listing.submissions.length).toBeGreaterThan(0);
    expect(
      listing.submissions.every(
        (row: { status: string }) => row.status === 'succeeded',
      ),
    ).toBe(true);
  });

  it('rejects a non-numeric listing limit at the edge', async () => {
    const failure = await auth.api
      .dgiiEcfListSubmissions({ query: { limit: 0 }, headers })
      .catch((error: unknown) => error);
    // Better Auth validates the query schema with Zod and answers 400 itself.
    expect(failure).toMatchObject({ status: 400 });
  });
});
