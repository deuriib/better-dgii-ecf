/**
 * Runtime smoke test for the published artifact.
 *
 * The test suite needs `node:sqlite` (Better Auth's test instance), which only
 * exists from Node 22 on. That is a limitation of the *tests*, not of the package,
 * and `engines.node` claims `>= 20` — so this script is what proves the claim:
 * it imports the built ESM and CJS entrypoints on the minimum supported runtime
 * and exercises the public surface without a database.
 *
 * Run through `mise run smoke`; CI runs it on the oldest supported Node.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const esm = await import('../dist/index.js');

assert.equal(
  typeof esm.dgiiEcf,
  'function',
  'dgiiEcf must be exported from the ESM build',
);
assert.equal(
  typeof esm.dgiiEcfOrganizationSchema,
  'function',
  'the organization schema fragment must be exported',
);
assert.equal(typeof esm.DGII_ECF_ERROR_CODES, 'object', 'error codes must be exported');
assert.equal(typeof esm.normalizeTaxPayerId, 'function', 'helpers must be exported');
assert.equal(
  typeof esm.Environment,
  'object',
  'the DGII environment enum must be re-exported',
);

// The plugin must build, expose its provider and carry its whole surface.
const plugin = esm.dgiiEcf({ credentials: () => ({ key: 'key', cert: 'cert' }) });
assert.equal(plugin.id, 'dgii-ecf');
assert.equal(plugin.clientProvider.constructsClients, true);
assert.ok(
  Object.keys(plugin.endpoints).length >= 18,
  'every endpoint must be registered',
);
assert.ok(
  Object.hasOwn(plugin.schema, 'dgiiEcfSubmission'),
  'the submission table must be declared',
);
assert.equal(plugin.schema.organization, undefined, 'the organization table is opt-in');

// Misconfiguration is rejected at construction, not on the first invoice.
assert.throws(() => esm.dgiiEcf({}), /credentials/i);

// `sign: true` needs the resolver that owns the key.
assert.equal(esm.normalizeTaxPayerId('1-31-12345-6'), '131123456');

// The client entrypoint must stay free of Node built-ins: it runs in a browser.
const client = await import('../dist/client.js');
assert.equal(typeof client.dgiiEcfClient, 'function');

// The CommonJS build must resolve through `require` as well.
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');
assert.equal(typeof cjs.dgiiEcf, 'function');
assert.equal(
  cjs.dgiiEcf({ credentials: () => ({ key: 'k', cert: 'c' }) }).id,
  'dgii-ecf',
);

console.log(`smoke ok on node ${process.version}`);
