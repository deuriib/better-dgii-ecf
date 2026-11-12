import { BetterAuthError } from '@better-auth/core/error';
import { badRequest, DGII_ECF_ERROR_CODES } from './errors.js';
import type { DgiiEcfOptions } from './types.js';

/**
 * Direct buyer delivery (DGII's Emisor↔Receptor flow), without letting a request
 * choose a URL.
 *
 * The DGII SDK authenticates against a buyer host by fetching its seed and posting
 * a **signature by the organization's private key** back to it. Accepting that host
 * from a request body therefore hands any authenticated caller two things at once:
 * an outbound request to a URL of their choosing (SSRF, including internal
 * addresses), and a signature oracle over a seed they selected.
 *
 * So the caller selects a **name**, and the URL comes from the operator:
 *
 * ```ts
 * dgiiEcf({ credentials, buyerDelivery: { hosts: { acme: 'https://fe.acme.com' } } })
 * ```
 *
 * A name that is not configured is refused, and a plugin with no configured hosts
 * refuses every request that asks for one — the default is closed.
 */

/** An absolute HTTPS URL, which is the only thing a buyer host can be. */
const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Validate the configured hosts once, at plugin construction.
 *
 * A malformed host is a deployment mistake, and learning about it on the first
 * invoice instead of at startup is how a bad configuration reaches production.
 */
export const assertBuyerDeliveryConfig = (options: DgiiEcfOptions): void => {
  const delivery = options.buyerDelivery;
  if (delivery === undefined) {
    return;
  }
  const entries = Object.entries(delivery.hosts ?? {});
  if (entries.length === 0) {
    throw new BetterAuthError(
      '[better-dgii-ecf] `buyerDelivery.hosts` is empty — omit the option instead of configuring it with no hosts.',
    );
  }
  for (const [name, url] of entries) {
    if (!isHttpsUrl(url)) {
      throw new BetterAuthError(
        `[better-dgii-ecf] buyerDelivery.hosts["${name}"] must be an absolute https URL, got "${url}".`,
      );
    }
  }
};

/**
 * Resolve the buyer host a request asked for, by name.
 *
 * Returns `undefined` when the request did not ask for one (the normal DGII path).
 */
export const resolveBuyerHost = (
  options: DgiiEcfOptions,
  buyer: string | undefined,
): string | undefined => {
  if (buyer === undefined) {
    return undefined;
  }
  const hosts = options.buyerDelivery?.hosts;
  if (hosts === undefined) {
    throw badRequest(
      DGII_ECF_ERROR_CODES.DGII_BUYER_HOST_NOT_ALLOWED,
      'Direct buyer delivery is not configured. Configure `buyerDelivery.hosts` on the server; a request cannot supply a delivery URL.',
    );
  }
  const host = hosts[buyer];
  if (host === undefined) {
    // Only the configured names are echoed: the URLs stay server-side.
    const known = Object.keys(hosts).sort().join(', ');
    throw badRequest(
      DGII_ECF_ERROR_CODES.DGII_BUYER_HOST_NOT_ALLOWED,
      `"${buyer}" is not a configured buyer host${known === '' ? '' : ` (configured: ${known})`}`,
    );
  }
  return host;
};
