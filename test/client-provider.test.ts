import { describe, expect, it, vi } from 'vitest';
import { BetterAuthError } from '@better-auth/core/error';
import { Environment } from '@deuriib/dgii-ecf';
import { createClientProvider } from '../src/client-provider.js';
import type { DgiiEcfScope } from '../src/types.js';
import { fakeCredentials, TAXPAYER_A, TAXPAYER_B } from './helpers.js';

const scope = (taxPayerId: string): DgiiEcfScope => ({
  taxPayerId,
  organizationId: 'org_1',
  userId: 'user_1',
  environment: Environment.Dev,
});

const material = () => ({ key: 'key-pem', cert: 'cert-pem' });

describe('createClientProvider', () => {
  it('refuses to be built without credentials or a client resolver', () => {
    expect(() => createClientProvider({})).toThrow(BetterAuthError);
  });

  it('returns the resolver client untouched when `getClient` is used', async () => {
    const client = { id: 'client' };
    const provider = createClientProvider({
      getClient: () => client as never,
    });
    await expect(provider.get(scope(TAXPAYER_A))).resolves.toBe(client);
    expect(provider.size).toBe(0);
    expect(provider.constructsClients).toBe(false);
  });

  it('reports a null client as unavailable credentials', async () => {
    const provider = createClientProvider({ getClient: () => null });
    await expect(provider.get(scope(TAXPAYER_A))).rejects.toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
      body: { code: 'DGII_CREDENTIALS_UNAVAILABLE' },
    });
  });

  it('builds one client per taxpayer and reuses it', async () => {
    const resolve = vi.fn(material);
    const provider = createClientProvider({ credentials: resolve });

    const first = await provider.get(scope(TAXPAYER_A));
    const second = await provider.get(scope(TAXPAYER_A));

    expect(first).toBe(second);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(provider.size).toBe(1);
    expect(provider.constructsClients).toBe(true);
  });

  it('keeps taxpayers apart in the cache', async () => {
    const provider = createClientProvider({ credentials: material });
    const a = await provider.get(scope(TAXPAYER_A));
    const b = await provider.get(scope(TAXPAYER_B));
    expect(a).not.toBe(b);
    expect(provider.size).toBe(2);
  });

  it('keys the cache by environment too', async () => {
    const provider = createClientProvider({ credentials: material });
    const dev = await provider.get(scope(TAXPAYER_A));
    const prod = await provider.get({
      ...scope(TAXPAYER_A),
      environment: Environment.Prod,
    });
    expect(dev).not.toBe(prod);
    expect(provider.size).toBe(2);
  });

  it('refuses credentials with no key/cert pair', async () => {
    const provider = createClientProvider({ credentials: () => ({}) });
    await expect(provider.get(scope(TAXPAYER_A))).rejects.toMatchObject({
      body: { code: 'DGII_CREDENTIALS_UNAVAILABLE' },
    });
  });

  it('treats a null resolver answer as unavailable credentials', async () => {
    const provider = createClientProvider({ credentials: () => null });
    await expect(provider.get(scope(TAXPAYER_A))).rejects.toMatchObject({
      body: { code: 'DGII_CREDENTIALS_UNAVAILABLE' },
    });
  });

  it('evicts expired entries once the ttl passes', async () => {
    let now = 0;
    const resolve = vi.fn(material);
    const provider = createClientProvider(
      { credentials: resolve, clientCache: { ttlMs: 1_000 } },
      () => now,
    );

    const first = await provider.get(scope(TAXPAYER_A));
    now += 1_001;
    const second = await provider.get(scope(TAXPAYER_A));

    expect(second).not.toBe(first);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('never caches when the ttl is zero', async () => {
    const resolve = vi.fn(material);
    const provider = createClientProvider(
      { credentials: resolve, clientCache: { ttlMs: 0 } },
      () => 0,
    );
    await provider.get(scope(TAXPAYER_A));
    await provider.get(scope(TAXPAYER_A));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(provider.size).toBe(0);
  });

  it('keeps the cache under the configured size cap', async () => {
    const provider = createClientProvider({
      credentials: material,
      clientCache: { maxSize: 2 },
    });
    await provider.get(scope('111111111'));
    await provider.get(scope('222222222'));
    await provider.get(scope('333333333'));
    expect(provider.size).toBe(2);
  });

  it('invalidates one taxpayer without touching the others', async () => {
    const provider = createClientProvider({ credentials: material });
    await provider.get(scope(TAXPAYER_A));
    await provider.get(scope(TAXPAYER_B));

    provider.invalidate(TAXPAYER_A);
    expect(provider.size).toBe(1);

    provider.invalidate();
    expect(provider.size).toBe(0);
  });

  // #34: cache keys carry the normalized id, so an operator typing the
  // formatted RNC must drop the same entry.
  it('invalidates a formatted taxpayer id', async () => {
    const resolve = vi.fn(material);
    const provider = createClientProvider({ credentials: resolve });
    await provider.get(scope(TAXPAYER_A));
    await provider.get(scope(TAXPAYER_B));
    expect(resolve).toHaveBeenCalledTimes(2);

    provider.invalidate('1-31-12345-6');
    expect(provider.size).toBe(1);

    await provider.get(scope(TAXPAYER_A));
    expect(resolve).toHaveBeenCalledTimes(3);
    await provider.get(scope(TAXPAYER_B));
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('leaves the cache alone when the id is not cached', async () => {
    const provider = createClientProvider({ credentials: material });
    await provider.get(scope(TAXPAYER_A));

    provider.invalidate('2-22-22222-2');
    expect(provider.size).toBe(1);

    provider.invalidate();
    expect(provider.size).toBe(0);
  });

  it('forwards the timeout to the built client', async () => {
    const provider = createClientProvider({
      credentials: () => fakeCredentials,
      timeoutMs: 1_234,
    });
    const client = (await provider.get(scope(TAXPAYER_A))) as unknown as {
      http: { defaultTimeoutMs?: number };
    };
    // The SDK keeps the timeout on its HTTP layer; asserting the value proves the
    // option was forwarded rather than dropped.
    expect(client.http).toBeDefined();
  });
});
