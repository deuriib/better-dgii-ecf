import { defineConfig } from 'tsup';

/**
 * Two public entrypoints, each shipped as ESM + CJS with its own declarations:
 *
 * - `.`        the server plugin (Node-only: it handles DGII credentials).
 * - `./client` the isomorphic client plugin — import-safe in a browser.
 *
 * `better-auth`, `@better-auth/core` and `@deuriib/dgii-ecf` stay external:
 * every copy of Better Auth must be the app's copy (plugins rely on module
 * identity for type augmentation), and the DGII SDK is a peer dependency so the
 * app pins its own version.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: 'node20',
  external: [
    'better-auth',
    '@better-auth/core',
    '@better-auth/utils',
    '@deuriib/dgii-ecf',
    'zod',
  ],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
