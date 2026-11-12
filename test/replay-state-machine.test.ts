import { describe, expect, it } from 'vitest';
import { organization } from 'better-auth/plugins';
import { getTestInstance } from 'better-auth/test';
import { DgiiError, Environment, err, ok } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '../src/index.js';
import { replayKeyFor } from '../src/persistence.js';
import { createFakeEcf, documentXml, TAXPAYER_A } from './helpers.js';

/**
 * The replay state machine.
 *
 * These are the tests the mutation review asked for: each one fails if the
 * distinction between "rejected" and "we do not know" collapses, if reconcile
 * stops closing records, or if the key stops carrying environment and
 * organization.
 */
const build = async (
  overrides: Record<string, unknown> = {},
  persistence?: { storeResponses?: boolean },
) => {
  const fake = createFakeEcf({ overrides });
  const instance = await getTestInstance({
    plugins: [
      organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
      dgiiEcf({
        verifyTaxPayerOwnership: () => true,
        environment: Environment.Dev,
        getClient: () => fake,
        ...(persistence === undefined ? {} : { persistence }),
      }),
    ],
  });
  const { headers } = await instance.signInWithTestUser();
  const created = await instance.auth.api.createOrganization({
    body: {
      name: 'Emisor',
      slug: `emisor-${Math.random().toString(36).slice(2, 8)}`,
      taxPayerId: TAXPAYER_A,
    },
    headers,
  });
  await instance.auth.api.setActiveOrganization({
    body: { organizationId: created.id },
    headers,
  });
  return { auth: instance.auth, headers, fake, organizationId: created.id };
};

const timeout = () => err(new DgiiError('DGII did not answer', { code: 'TIMEOUT' }));

describe('ambiguous outcomes', () => {
  it('records a timeout as unconfirmed and refuses the retry', async () => {
    const { auth, headers, fake } = await build({
      sendDocument: async () => timeout(),
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000901');

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({ status: 'BAD_GATEWAY' });

    const listing = await auth.api.dgiiEcfListSubmissions({ query: {}, headers });
    expect(listing.submissions[0]).toMatchObject({
      status: 'unconfirmed',
      errorCode: 'TIMEOUT',
    });

    // The dangerous case: a retry must not transmit again.
    const callsBefore = fake.methodNames().filter((m) => m === 'sendDocument').length;
    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({
      status: 'CONFLICT',
      body: { code: 'DGII_IDEMPOTENCY_IN_FLIGHT' },
    });
    expect(fake.methodNames().filter((m) => m === 'sendDocument').length).toBe(
      callsBefore,
    );
  });

  it('records a definite rejection as failed and allows the retry', async () => {
    let attempt = 0;
    const { auth, headers } = await build({
      sendDocument: async () => {
        attempt += 1;
        return attempt === 1
          ? err(new DgiiError('bad document', { code: 'VALIDATION' }))
          : ok({ trackId: 'track-retried' });
      },
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000902');

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });

    const retry = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(retry).toMatchObject({ replayed: false });
    expect(attempt).toBe(2);
  });

  it('does not record a success when DGII answers with no payload', async () => {
    const { auth, headers } = await build({
      // A 2xx whose body is not an object: something came back, but nothing says
      // the document was accepted.
      sendDocument: async () => ok('accepted'),
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000903');

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({ status: 'BAD_GATEWAY' });

    const listing = await auth.api.dgiiEcfListSubmissions({ query: {}, headers });
    expect(listing.submissions[0]).toMatchObject({
      status: 'unconfirmed',
      errorCode: 'UNRECOGNISED_PAYLOAD',
    });
  });
});

describe('reconcile closes the record it settles', () => {
  it('releases the key when DGII has no record, and the retry then transmits', async () => {
    let phase: 'timeout' | 'ok' = 'timeout';
    const transmissions: string[] = [];
    const { auth, headers } = await build({
      sendDocument: async () => {
        if (phase === 'timeout') {
          return timeout();
        }
        transmissions.push('sent');
        return ok({ trackId: 'track-after-reconcile' });
      },
      reconcileSubmission: async () =>
        ok({
          inquiry: { codigo: 0, estado: 'No encontrado' },
          delivered: false,
          canReuseSequence: false,
          cleared: true,
        }),
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000904');

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({ status: 'BAD_GATEWAY' });

    const reconciled = await auth.api.dgiiEcfReconcileSubmission({
      body: { xml },
      headers,
    });
    expect(reconciled.closedRecords).toBe(1);

    phase = 'ok';
    const retry = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(retry).toMatchObject({ replayed: false });
    expect(transmissions).toHaveLength(1);
  });

  it('marks the record succeeded when DGII has the document, so no retry re-sends it', async () => {
    let transmissions = 0;
    const { auth, headers } = await build({
      sendDocument: async () => {
        transmissions += 1;
        return timeout();
      },
      reconcileSubmission: async () =>
        ok({
          inquiry: { codigo: 1, estado: 'Aceptado' },
          delivered: true,
          canReuseSequence: false,
          cleared: false,
        }),
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000905');

    await expect(
      auth.api.dgiiEcfSendDocument({ body: { xml }, headers }),
    ).rejects.toMatchObject({ status: 'BAD_GATEWAY' });

    await auth.api.dgiiEcfReconcileSubmission({ body: { xml }, headers });

    const replay = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    expect(replay).toMatchObject({ replayed: true });
    // The reconciled row has a stored response, so the replay can return it.
    expect(replay.result).toMatchObject({ delivered: true });
    expect(transmissions).toBe(1);
  });

  it('reports zero closed records when nothing was open', async () => {
    const { auth, headers } = await build();
    const reconciled = await auth.api.dgiiEcfReconcileSubmission({
      body: { xml: documentXml(TAXPAYER_A, 'E310000000906') },
      headers,
    });
    expect(reconciled.closedRecords).toBe(0);
  });
});

describe('the replay key carries the scope', () => {
  it('derives the key from environment and organization, not just the taxpayer', () => {
    const base = {
      environment: Environment.Dev,
      organizationId: 'org_1',
      taxPayerId: TAXPAYER_A,
      idempotencyKey: 'k',
    };
    const key = replayKeyFor(base);

    // Without these two, a certification run could replay a production invoice
    // and two organizations sharing an RNC could read each other's submissions.
    expect(replayKeyFor({ ...base, environment: Environment.Prod })).not.toBe(key);
    expect(replayKeyFor({ ...base, organizationId: 'org_2' })).not.toBe(key);
    expect(replayKeyFor({ ...base, organizationId: null })).not.toBe(key);
    expect(replayKeyFor({ ...base, taxPayerId: '505074758' })).not.toBe(key);
    // Same inputs, same key: the guard must be stable across processes.
    expect(replayKeyFor(base)).toBe(key);
  });

  it('keeps two organizations with the same RNC apart', async () => {
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
    const slugs = ['emisor-uno', 'emisor-dos'];
    const ids: string[] = [];
    for (const slug of slugs) {
      const created = await instance.auth.api.createOrganization({
        body: { name: slug, slug, taxPayerId: TAXPAYER_A },
        headers,
      });
      ids.push(created.id);
    }

    const xml = documentXml(TAXPAYER_A, 'E310000000908');
    const results = [];
    for (const organizationId of ids) {
      const scoped = await instance.auth.api.dgiiEcfSendDocument({
        body: { xml, organizationId },
        headers,
      });
      results.push(scoped);
    }

    expect(results.every((result) => result.replayed === false)).toBe(true);
    expect(results[0]?.submissionId).not.toBe(results[1]?.submissionId);
  });
});

describe('concurrency', () => {
  it('transmits once when two requests race on the same document', async () => {
    let transmissions = 0;
    const { auth, headers } = await build({
      sendDocument: async () => {
        transmissions += 1;
        return ok({ trackId: 'track-race' });
      },
    });
    const xml = documentXml(TAXPAYER_A, 'E310000000909');
    const body = { xml };
    const outcomes = await Promise.allSettled([
      auth.api.dgiiEcfSendDocument({ body, headers }),
      auth.api.dgiiEcfSendDocument({ body, headers }),
    ]);

    // The invariant that matters is one transmission. The loser is either
    // refused (it lost the race for the key) or answered from the stored record
    // (it arrived after the winner finished) — never a second POST.
    expect(transmissions).toBe(1);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    ) as PromiseFulfilledResult<{ replayed: boolean }>[];
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    ) as PromiseRejectedResult[];
    // Exactly one request transmitted; the other either replayed the stored
    // answer or was refused for losing the race. Both are acceptable; a second
    // transmission is not.
    const transmitted = fulfilled.filter((outcome) => !outcome.value.replayed);
    const replayed = fulfilled.filter((outcome) => outcome.value.replayed);
    expect(transmitted).toHaveLength(1);
    expect(replayed.length + rejected.length).toBe(1);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ status: 'CONFLICT' });
    }
  });
});

describe('stored responses', () => {
  it('replays without a body when responses are not retained', async () => {
    const { auth, headers } = await build({}, { storeResponses: false });
    const xml = documentXml(TAXPAYER_A, 'E310000000910');

    await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });
    const replay = await auth.api.dgiiEcfSendDocument({ body: { xml }, headers });

    expect(replay.replayed).toBe(true);
    expect(replay.result).toBeNull();
  });
});
