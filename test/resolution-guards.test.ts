import { describe, expect, it } from 'vitest';
import type { GenericEndpointContext } from '@better-auth/core';
import { Environment } from '@deuriib/dgii-ecf';
import { resolveRequestScope } from '../src/resolution.js';
import { planReplay, parseStoredResponse } from '../src/persistence.js';
import type { SubmissionRecord } from '../src/persistence.js';

/** A context with no session, to exercise the internal guard directly. */
const anonymousCtx = () =>
  ({ context: { session: null } }) as unknown as GenericEndpointContext;

/**
 * Unit coverage of the resolution module's own guards.
 *
 * The endpoint-level tests already prove the policy end to end; these cover the
 * branches only reachable from outside an HTTP request, which is exactly where a
 * future refactor could quietly drop a check.
 */
describe('resolveRequestScope guards', () => {
  it('refuses a context with no session', async () => {
    await expect(
      resolveRequestScope({
        ctx: anonymousCtx(),
        options: { environment: Environment.Dev },
        input: { taxPayerId: '131123456' },
      }),
    ).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
      body: { code: 'DGII_SESSION_REQUIRED' },
    });
  });
});

describe('planReplay', () => {
  const record = (status: SubmissionRecord['status']): SubmissionRecord => ({
    id: 'row_1',
    taxPayerId: '131123456',
    userId: 'user_1',
    environment: 'TesteCF',
    operation: 'sendDocument',
    status,
  });

  it('proceeds when nothing was recorded', () => {
    expect(planReplay(null)).toEqual({ kind: 'proceed' });
  });

  it('replays a succeeded record', () => {
    expect(planReplay(record('succeeded'))).toMatchObject({ kind: 'replay' });
  });

  it('refuses while a record is pending', () => {
    expect(planReplay(record('pending'))).toEqual({ kind: 'conflict' });
  });

  it('proceeds after a failed record, because nothing landed', () => {
    expect(planReplay(record('failed'))).toEqual({ kind: 'proceed' });
  });
});

describe('parseStoredResponse', () => {
  it('returns null when nothing was stored', () => {
    expect(
      parseStoredResponse({
        id: 'row_1',
        taxPayerId: '131123456',
        userId: 'user_1',
        environment: 'TesteCF',
        operation: 'sendDocument',
        status: 'succeeded',
        response: null,
      }),
    ).toBeNull();
  });

  it('returns null for a truncated body instead of throwing', () => {
    expect(
      parseStoredResponse({
        id: 'row_1',
        taxPayerId: '131123456',
        userId: 'user_1',
        environment: 'TesteCF',
        operation: 'sendDocument',
        status: 'succeeded',
        response: '{"trackId":"tra',
      }),
    ).toBeNull();
  });

  it('round-trips a stored body', () => {
    expect(
      parseStoredResponse({
        id: 'row_1',
        taxPayerId: '131123456',
        userId: 'user_1',
        environment: 'TesteCF',
        operation: 'sendDocument',
        status: 'succeeded',
        response: '{"trackId":"track-1"}',
      }),
    ).toEqual({ trackId: 'track-1' });
  });
});
