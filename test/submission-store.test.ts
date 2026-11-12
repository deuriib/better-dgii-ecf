import { describe, expect, it } from 'vitest';
import type { GenericEndpointContext } from '@better-auth/core';
import {
  createSubmissionStore,
  replayKeyFor,
  type SubmissionRecord,
} from '../src/persistence.js';

/**
 * Unit tests for the store's compare-and-set, using an adapter double.
 *
 * The interesting branches are the races: "the row appeared between my read and
 * my write", "another process claimed the failed row first". They are the reason
 * the guard is safe, and they are almost impossible to hit on purpose through
 * HTTP — so they are driven here directly.
 */
const ctxWith = (adapter: unknown) =>
  ({ context: { adapter } }) as unknown as GenericEndpointContext;

const matches = (
  row: SubmissionRecord,
  where: readonly { field: string; value: string }[],
): boolean =>
  where.every(
    (clause) => (row as Record<string, unknown>)[clause.field] === clause.value,
  );

interface DoubleOptions {
  /** Rows already present. */
  rows?: SubmissionRecord[];
  /** Make `updateMany` report that it changed nothing (lost the claim). */
  loseClaim?: boolean;
  /** Make `create` fail as the unique index would. */
  rejectCreate?: boolean;
}

const adapterDouble = (options: DoubleOptions = {}) => {
  const rows: SubmissionRecord[] = [...(options.rows ?? [])];
  return {
    rows,
    async findMany({
      where,
      limit,
    }: {
      where?: { field: string; value: string }[];
      limit?: number;
    }) {
      const found = rows.filter((row) =>
        where === undefined ? true : matches(row, where),
      );
      return limit === undefined ? found : found.slice(0, limit);
    },
    async create({ data }: { data: Record<string, unknown> }) {
      if (
        options.rejectCreate === true ||
        rows.some((row) => row.replayKey === data.replayKey)
      ) {
        throw new Error('UNIQUE constraint failed: dgiiEcfSubmission.replayKey');
      }
      const row = { id: `row_${rows.length + 1}`, ...data } as SubmissionRecord;
      rows.push(row);
      return row;
    },
    async update({
      where,
      update,
    }: {
      where: { field: string; value: string }[];
      update: Record<string, unknown>;
    }) {
      const hit = rows.find((row) => matches(row, where));
      if (hit === undefined) {
        return null;
      }
      Object.assign(hit, update);
      return hit;
    },
    async updateMany({
      where,
      update,
    }: {
      where: { field: string; value: string }[];
      update: Record<string, unknown>;
    }) {
      if (options.loseClaim === true) {
        return 0;
      }
      const hits = rows.filter((row) => matches(row, where));
      for (const hit of hits) {
        Object.assign(hit, update);
      }
      return hits.length;
    },
  };
};

const keyInput = {
  environment: 'TesteCF',
  organizationId: 'org_1',
  taxPayerId: '131123456',
  idempotencyKey: 'k-1',
};

const beginInput = {
  ...keyInput,
  userId: 'user_1',
  operation: 'sendDocument',
  encf: 'E310000000001',
  documentHash: 'hash-1',
};

describe('createSubmissionStore.begin', () => {
  it('starts a fresh attempt', async () => {
    const adapter = adapterDouble();
    const store = createSubmissionStore(ctxWith(adapter), undefined);
    const outcome = await store.begin(beginInput);

    expect(outcome).toMatchObject({ status: 'started' });
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0]).toMatchObject({
      status: 'pending',
      replayKey: replayKeyFor(keyInput),
    });
  });

  it('reports a conflict when an open record already holds the key', async () => {
    const adapter = adapterDouble({
      rows: [
        {
          id: 'row_open',
          ...keyInput,
          organizationId: keyInput.organizationId,
          userId: 'user_1',
          operation: 'sendDocument',
          status: 'unconfirmed',
          replayKey: replayKeyFor(keyInput),
        } as SubmissionRecord,
      ],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const outcome = await store.begin(beginInput);
    expect(outcome).toMatchObject({ status: 'conflict' });
    expect(adapter.rows).toHaveLength(1);
  });

  it('reuses a failed row instead of duplicating it', async () => {
    const adapter = adapterDouble({
      rows: [
        {
          id: 'row_failed',
          ...keyInput,
          userId: 'user_1',
          operation: 'sendDocument',
          status: 'failed',
          errorCode: 'VALIDATION',
          response: '{"old":true}',
          replayKey: replayKeyFor(keyInput),
        } as SubmissionRecord,
      ],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const outcome = await store.begin(beginInput);
    expect(outcome).toMatchObject({ status: 'started', id: 'row_failed' });
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0]).toMatchObject({
      status: 'pending',
      errorCode: null,
      response: null,
    });
  });

  it('reports a conflict when another process claimed the failed row first', async () => {
    const adapter = adapterDouble({
      loseClaim: true,
      rows: [
        {
          id: 'row_failed',
          ...keyInput,
          userId: 'user_1',
          operation: 'sendDocument',
          status: 'failed',
          replayKey: replayKeyFor(keyInput),
        } as SubmissionRecord,
      ],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const outcome = await store.begin(beginInput);
    expect(outcome).toMatchObject({ status: 'conflict', record: { id: 'row_failed' } });
  });

  it('surfaces an insert failure that is not a key collision', async () => {
    // A database that is down must not be reported as an idempotency conflict.
    const adapter = adapterDouble({ rejectCreate: true });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    await expect(store.begin(beginInput)).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe('createSubmissionStore.reconcile', () => {
  const open = (id: string, status: SubmissionRecord['status']): SubmissionRecord =>
    ({
      id,
      ...keyInput,
      userId: 'user_1',
      operation: 'sendDocument',
      encf: 'E310000000001',
      status,
      replayKey: `key-${id}`,
    }) as SubmissionRecord;

  it('closes every open record for the document', async () => {
    const adapter = adapterDouble({
      rows: [open('a', 'pending'), open('b', 'unconfirmed'), open('c', 'succeeded')],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const closed = await store.reconcile({
      environment: keyInput.environment,
      organizationId: keyInput.organizationId,
      taxPayerId: keyInput.taxPayerId,
      encf: 'E310000000001',
      delivered: false,
      response: { delivered: false },
    });

    expect(closed).toBe(2);
    expect(adapter.rows.map((row) => row.status)).toEqual([
      'failed',
      'failed',
      'succeeded',
    ]);
    expect(adapter.rows[0]).toMatchObject({ errorCode: 'RECONCILED_NOT_DELIVERED' });
  });

  it('marks a delivered document succeeded', async () => {
    const adapter = adapterDouble({ rows: [open('a', 'pending')] });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    await store.reconcile({
      environment: keyInput.environment,
      organizationId: keyInput.organizationId,
      taxPayerId: keyInput.taxPayerId,
      encf: 'E310000000001',
      delivered: true,
      response: { delivered: true },
    });

    expect(adapter.rows[0]).toMatchObject({ status: 'succeeded', errorCode: null });
  });

  it('matches the single-tenant scope when there is no organization', async () => {
    const adapter = adapterDouble({
      rows: [
        { ...open('a', 'pending'), organizationId: null } as SubmissionRecord,
        { ...open('b', 'pending'), organizationId: 'other' } as SubmissionRecord,
      ],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const closed = await store.reconcile({
      environment: keyInput.environment,
      organizationId: null,
      taxPayerId: keyInput.taxPayerId,
      encf: 'E310000000001',
      delivered: false,
      response: null,
    });

    expect(closed).toBe(1);
    expect(adapter.rows[1]?.status).toBe('pending');
  });

  it('does nothing for a document with no e-NCF', async () => {
    const adapter = adapterDouble({ rows: [open('a', 'pending')] });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const closed = await store.reconcile({
      environment: keyInput.environment,
      organizationId: keyInput.organizationId,
      taxPayerId: keyInput.taxPayerId,
      encf: null,
      delivered: true,
      response: null,
    });

    expect(closed).toBe(0);
    expect(adapter.rows[0]?.status).toBe('pending');
  });
});

describe('createSubmissionStore without persistence', () => {
  it('is inert', async () => {
    const adapter = adapterDouble();
    const store = createSubmissionStore(ctxWith(adapter), { enabled: false });

    expect(store.enabled).toBe(false);
    await expect(store.begin(beginInput)).resolves.toEqual({ status: 'disabled' });
    await store.complete(null, { status: 'succeeded' });
    await expect(
      store.reconcile({
        environment: keyInput.environment,
        organizationId: null,
        taxPayerId: keyInput.taxPayerId,
        encf: 'E310000000001',
        delivered: true,
        response: null,
      }),
    ).resolves.toBe(0);
    expect(adapter.rows).toHaveLength(0);
  });
});

describe('createSubmissionStore.list', () => {
  it('filters by taxpayer when there is no organization', async () => {
    const adapter = adapterDouble({
      rows: [
        {
          id: 'a',
          ...keyInput,
          userId: 'u',
          operation: 'x',
          status: 'succeeded',
          organizationId: null,
        } as SubmissionRecord,
        {
          id: 'b',
          ...keyInput,
          taxPayerId: '999',
          userId: 'u',
          operation: 'x',
          status: 'succeeded',
          organizationId: null,
        } as SubmissionRecord,
      ],
    });
    const store = createSubmissionStore(ctxWith(adapter), undefined);

    const rows = await store.list({
      organizationId: null,
      taxPayerId: keyInput.taxPayerId,
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('a');
  });
});
