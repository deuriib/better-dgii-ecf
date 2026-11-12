import { APIError } from 'better-auth/api';
import { BetterAuthError } from '@better-auth/core/error';
import { ECF } from '@deuriib/dgii-ecf';
import type { DgiiEcfOptions, DgiiEcfScope } from './types.js';
import { DGII_ECF_ERROR_CODES } from './errors.js';
import { normalizeTaxPayerId } from './tax-payer.js';

/**
 * Supplies the DGII client for a resolved scope.
 *
 * The plugin owns no key material of its own: the host resolves it per
 * taxpayer, over a callback that never sees the HTTP request. That is the whole
 * security model — a browser can call these endpoints, but it can never supply,
 * read or influence which certificate signs a document.
 */
export interface DgiiEcfClientProvider {
  /** The client for this scope, or an `APIError` when none can be built. */
  get(scope: DgiiEcfScope): Promise<ECF>;
  /**
   * Drop cached clients, all of them or only one taxpayer's.
   *
   * The id is normalized first, so `invalidate('1-31-12345-6')` drops the
   * entry cached for `131123456`. An id with no cached client is a no-op.
   */
  invalidate(taxPayerId?: string): void;
  /** Number of cached clients; always 0 when `getClient` is configured. */
  readonly size: number;
  /**
   * True when the plugin builds the `ECF` instances (the `credentials` mode).
   *
   * The status endpoints use it to decide whether the plugin's own
   * `status.apiKey` is the authority: a host that supplies its own client kept
   * the status key to itself too, so the plugin must not demand one.
   */
  readonly constructsClients: boolean;
}

const DEFAULT_MAX_SIZE = 50;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const cacheKey = (scope: DgiiEcfScope): string =>
  `${scope.environment}\u0000${scope.taxPayerId}`;

interface CacheEntry {
  readonly client: ECF;
  readonly expiresAt: number;
}

const unavailable = (taxPayerId: string): APIError =>
  new APIError('INTERNAL_SERVER_ERROR', {
    message: `No DGII credentials were resolved for taxpayer ${taxPayerId}`,
    code: DGII_ECF_ERROR_CODES.DGII_CREDENTIALS_UNAVAILABLE.code,
  });

/**
 * Build the provider from the plugin options.
 *
 * `getClient` wins over `credentials` when both are present: a host that already
 * pools clients is the authority on their lifecycle, so the plugin refuses to
 * cache a second copy behind its back.
 *
 * Configuration is validated here rather than per request. A plugin instance
 * that cannot reach DGII at all should fail when `betterAuth()` is constructed,
 * not on the first invoice.
 */
export const createClientProvider = (
  options: DgiiEcfOptions,
  now: () => number = Date.now,
): DgiiEcfClientProvider => {
  const getClient = options.getClient;

  if (getClient !== undefined) {
    return {
      async get(scope) {
        const client = await getClient(scope);
        if (client === null) {
          throw unavailable(scope.taxPayerId);
        }
        return client;
      },
      invalidate() {
        // Nothing is cached here; the resolver owns the instances.
      },
      size: 0,
      constructsClients: false,
    };
  }

  const resolveCredentials = options.credentials;
  if (resolveCredentials === undefined) {
    throw new BetterAuthError(
      '[better-dgii-ecf] Configure `credentials` or `getClient` — the plugin cannot reach DGII without one of them.',
    );
  }

  const maxSize = Math.max(1, options.clientCache?.maxSize ?? DEFAULT_MAX_SIZE);
  const ttlMs = Math.max(0, options.clientCache?.ttlMs ?? DEFAULT_TTL_MS);
  const cache = new Map<string, CacheEntry>();

  const evictExpired = (at: number): void => {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) {
        cache.delete(key);
      }
    }
  };

  return {
    async get(scope) {
      const at = now();
      evictExpired(at);

      const key = cacheKey(scope);
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > at) {
        // Refresh recency so the size cap evicts the least recently used entry.
        cache.delete(key);
        cache.set(key, cached);
        return cached.client;
      }

      const material = await resolveCredentials(scope);
      if (material === null) {
        throw unavailable(scope.taxPayerId);
      }
      if (material.key === undefined || material.cert === undefined) {
        throw new APIError('INTERNAL_SERVER_ERROR', {
          message: `The credentials resolved for taxpayer ${scope.taxPayerId} carry no key/cert PEM pair`,
          code: DGII_ECF_ERROR_CODES.DGII_CREDENTIALS_UNAVAILABLE.code,
        });
      }

      const statusApiKey = options.status?.apiKey;
      const client = new ECF(material, scope.environment, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(statusApiKey === undefined ? {} : { statusApiKey }),
      });

      if (ttlMs > 0) {
        while (cache.size >= maxSize) {
          const oldest = cache.keys().next();
          if (oldest.done === true) {
            break;
          }
          cache.delete(oldest.value);
        }
        cache.set(key, { client, expiresAt: at + ttlMs });
      }
      return client;
    },
    invalidate(taxPayerId) {
      if (taxPayerId === undefined) {
        cache.clear();
        return;
      }
      // Keys carry the id as resolution stored it — normalized. An operator
      // rotating a certificate types the RNC with separators, so normalize
      // both sides before matching (#34).
      const target = normalizeTaxPayerId(taxPayerId);
      for (const key of cache.keys()) {
        const cached = key.slice(key.lastIndexOf('\u0000') + 1);
        if (normalizeTaxPayerId(cached) === target) {
          cache.delete(key);
        }
      }
    },
    get size() {
      return cache.size;
    },
    constructsClients: true,
  };
};
