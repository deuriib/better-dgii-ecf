import type { BetterAuthClientPlugin } from 'better-auth/client';
import type { DgiiEcfPlugin } from './plugin.js';

/**
 * Client plugin for {@link import('./plugin.js').dgiiEcf}.
 *
 * It adds no runtime code: Better Auth infers every method from the server
 * plugin's endpoints, so the client cannot drift from the server — a renamed
 * path breaks the build instead of the invoice. Methods are namespaced under
 * `dgiiEcf`:
 *
 * ```ts
 * await authClient.dgiiEcf.documents({ xml, sign: true });
 * await authClient.dgiiEcf.inquiries.status({ ncf, taxPayerId });
 * await authClient.dgiiEcf.serviceStatus();
 * ```
 *
 * The `id` must match the server plugin's `id` so Better Auth can pair them.
 * Importing this module pulls only types, which is what makes it safe to use
 * from a browser bundle.
 */
export const dgiiEcfClient = () =>
  ({
    id: 'dgii-ecf',
    $InferServerPlugin: {} as DgiiEcfPlugin,
  }) satisfies BetterAuthClientPlugin;

export type DgiiEcfClientPlugin = ReturnType<typeof dgiiEcfClient>;
