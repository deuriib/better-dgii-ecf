# Usage

Everything the plugin exposes, and the reasoning a caller needs to choose between the
options. If you only want the fastest path, the [README](../README.md) has the two quick
starts.

- [Setup](#setup)
  - [Organization mode](#organization-mode-recommended)
  - [Per-call mode](#per-call-mode)
  - [Resolver mode](#resolver-mode)
- [Which taxpayer does a call act for?](#which-taxpayer-does-a-call-act-for)
- [Credentials](#credentials)
- [Environments](#environments)
- [Signing](#signing)
- [Submissions and replay](#submissions-and-replay)
- [Errors](#errors)
- [DGII status endpoints](#dgii-status-endpoints)
- [Audit trail](#audit-trail)
- [Client usage](#client-usage)
- [Configuration reference](#configuration-reference)

## Setup

The plugin is added to `betterAuth({ plugins: [...] })`. Nothing else in the
configuration changes; the endpoints appear under `/api/auth/dgii-ecf/*` and as
`auth.api.dgiiEcf*`.

### Organization mode (recommended)

The taxpayer id lives on the organization, so the RNC a user can invoice under is the
organization they are a member of. This is the mode to use for anything multi-tenant.

```ts
import { organization } from 'better-auth/plugins';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '@deuriib/better-dgii-ecf';

betterAuth({
  plugins: [
    organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),
    dgiiEcf({ credentials: resolveCredentials }),
  ],
});
```

`dgiiEcfOrganizationSchema()` returns the exact `additionalFields` fragment the plugin
expects. Declaring it through the **organization plugin** is what makes the field
writable — `organization.create` and `organization.update` only accept a field their own
schema knows about.

```ts
await authClient.organization.create({
  name: 'Emisor SRL',
  slug: 'emisor-srl',
  taxPayerId: '131-12345-6', // accepted, normalized to 131123456
});
```

If the value is written by another system (a back office, a nightly sync) and you never
want the auth API to accept it, register it from the plugin instead:

```ts
dgiiEcf({ credentials: resolveCredentials, organization: { extendSchema: true } });
```

That mode adds the column so `auth generate` / `auth migrate` creates it, marks it
`input: false`, and reads whatever your system writes. It cannot be set through
`organization.update`.

> The comparison is normalization-stable: an organization storing `1-31-12345-6` matches
> a request sending `131123456`.

### Per-call mode

No organization plugin. Every call names its taxpayer. The plugin accepts it because
there is no tenant model to check it against — this is the documented single-tenant
shape.

```ts
betterAuth({ plugins: [dgiiEcf({ credentials: () => loadCertificate() })] });
```

```ts
await auth.api.dgiiEcfSendDocument({
  body: { xml, sign: true, taxPayerId: '131123456' },
  headers,
});
```

With the organization plugin installed _and_ no organization in scope, a request that
names a taxpayer is refused unless you opt in:

```ts
dgiiEcf({ credentials: resolveCredentials, allowUntrustedTaxPayerId: true });
```

Use it for admin tooling, not for a multi-tenant surface.

### Resolver mode

Map the session to a taxpayer on the server, without an organization:

```ts
dgiiEcf({
  credentials: resolveCredentials,
  resolveTaxPayerId: async ({ user }) => {
    const profile = await db.taxProfile.findByUser(user.id);
    return profile?.rnc ?? null;
  },
});
```

A resolver is trusted configuration: it is applied after the request and the
organization both failed to produce an id, and its result is not re-checked against a
tenant. It is the right tool for "one taxpayer per user".

## Which taxpayer does a call act for?

The order is fixed:

1. `taxPayerId` in the request body/query — the per-call mode.
2. The organization's stored field — for the organization in scope (explicit
   `organizationId`, otherwise the session's active organization).
3. `resolveTaxPayerId` — the server-side mapping.

Then the resolved id is **authorized**:

| Situation                                                                         | Result                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Organization in scope, caller is a member with an allowed role, stored id matches | allowed                                                              |
| Organization in scope, stored id differs from the resolved id                     | `403 DGII_TAXPAYER_ID_FORBIDDEN`                                     |
| Organization in scope, caller is not a member                                     | `403 DGII_NOT_A_MEMBER`                                              |
| Organization in scope, caller's role is not in `roles`                            | `403 DGII_INSUFFICIENT_ROLE`                                         |
| Organization plugin installed, no organization in scope, id from the request      | `400 DGII_ORGANIZATION_REQUIRED` (unless `allowUntrustedTaxPayerId`) |
| Organization plugin installed, no organization in scope, id from the resolver     | allowed                                                              |
| No organization plugin                                                            | allowed (single-tenant mode)                                         |
| `authorize` configured                                                            | its verdict replaces the table above                                 |

`GET /dgii-ecf/taxpayer` reports the outcome — including `source` (`request` |
`organization` | `resolver`) — without calling DGII:

```ts
const { data } = await authClient.dgiiEcf.taxpayer({ query: {} });
// { taxPayerId: '131123456', organizationId: 'org_…', organizationTaxPayerId: '131123456',
//   source: 'organization', environment: 'CerteCF' }
```

### Validation

By default the id must be a DGII RNC (9 digits) or a cédula (11 digits) after
normalization. Change it with:

```ts
dgiiEcf({ validateTaxPayerId: 'off' }); // shape unchecked
dgiiEcf({ validateTaxPayerId: (id) => id.startsWith('1') }); // your rule
dgiiEcf({ validateTaxPayerId: (id) => canonicalRnc(id) }); // rewrite or reject
```

A validator returning a string **replaces** the id — that is how an alias becomes its
canonical RNC.

## Credentials

Two ways to give the plugin a DGII client. Exactly one is required; the plugin throws
when `betterAuth()` is constructed otherwise.

### `credentials` — the plugin builds and caches clients

```ts
dgiiEcf({
  credentials: async ({ taxPayerId, organizationId, userId, environment }) => {
    const record = await certificates.load({ taxPayerId, organizationId });
    if (!record) return null; // → 500 DGII_CREDENTIALS_UNAVAILABLE
    return new P12Reader(record.password)
      .getKeyFromStringBase64(record.base64)
      .unwrapOrThrow();
  },
});
```

The resolver must return a `P12ReaderData` (`key` + `cert` PEM) or `null`. The plugin
caches one `ECF` instance per `(environment, taxPayerId)`:

```ts
dgiiEcf({ credentials, clientCache: { maxSize: 50, ttlMs: 10 * 60_000 } });
```

Rotating a certificate means invalidating its client. The plugin exposes the provider
for that:

```ts
const plugin = dgiiEcf({ credentials });
plugin.clientProvider?.invalidate('131123456'); // one taxpayer
plugin.clientProvider?.invalidate(); // all of them
```

### `getClient` — you own the client lifecycle

```ts
dgiiEcf({
  getClient: async ({ taxPayerId }) => pool.acquire(taxPayerId), // KMS, HSM, sidecar…
});
```

Nothing is cached and `clientCache` is ignored. With this mode the plugin cannot sign
(`sign: true` answers `500 DGII_CREDENTIALS_UNAVAILABLE`), because signing needs the key
material and the key stayed with you.

## Environments

```ts
import { Environment } from '@deuriib/better-dgii-ecf';

dgiiEcf({ environment: Environment.Prod }); // or .Cert / .Dev (default)
```

Or per taxpayer, which is what a certification rollout needs:

```ts
dgiiEcf({
  environment: ({ taxPayerId }) =>
    taxPayerId === PILOT_RNC ? Environment.Cert : Environment.Prod,
});
```

The environment is part of the client cache key and is echoed in every response.

## Signing

`sign: true` signs the XML server-side, with the resolved credentials, using the
document's own root element (`ECF`, `RFCE`, `ACECF`, `ANECF`). The private key never
leaves the process, so a browser can safely submit a document body.

The issuer check runs on the signed document: if `RNCEmisor` (or `RncEmisor` for ANECF)
differs from the authorized taxpayer, the request is refused with
`403 DGII_TAXPAYER_ID_MISMATCH`. Build documents for the taxpayer you are authorized
for.

## Submissions and replay

Fiscal documents are not idempotent at DGII: submitting the same e-NCF twice is a
duplicate. The plugin protects the retry path with a durable row per submission.

```ts
const first = await authClient.dgiiEcf.documents({ xml, sign: true });
// { taxPayerId, organizationId, environment, submissionId, replayed: false, result }

const retry = await authClient.dgiiEcf.documents({ xml, sign: true });
// { …, replayed: true, result: <the original DGII answer> }
```

The replay key is `idempotencyKey` when you send one, otherwise the SHA-256 of the
signed document. Pass a key when the same content must be sendable twice as two
different submissions (rare, and usually a modelling mistake).

Outcomes:

| Stored record   | Next attempt                                                |
| --------------- | ----------------------------------------------------------- |
| none / `failed` | transmitted normally                                        |
| `succeeded`     | replayed from the stored answer, DGII not called            |
| `pending`       | `409 DGII_IDEMPOTENCY_IN_FLIGHT` — reconcile, do not resend |

`pending` is the important one: it means an earlier attempt may have reached DGII and
the outcome is unknown. Resolve it with the document itself:

```ts
const { data } = await authClient.dgiiEcf.documents.reconcile({ xml });
// { result: { inquiry, delivered, canReuseSequence, cleared } }
```

Disable persistence entirely when you already have a durable outbox:

```ts
dgiiEcf({ credentials, persistence: { enabled: false } });
```

You then lose the replay guard and `dgiiEcf.submissions` answers
`501 DGII_PERSISTENCE_UNAVAILABLE`.

## Errors

Every failure is an `APIError` with a machine-readable `code` in the body (also
available client-side as `error.code`).

| Code                           | Status          | Meaning                                      |
| ------------------------------ | --------------- | -------------------------------------------- |
| `DGII_SESSION_REQUIRED`        | 401             | No session                                   |
| `DGII_TAXPAYER_ID_REQUIRED`    | 400             | No source produced a taxpayer id             |
| `DGII_TAXPAYER_ID_INVALID`     | 400             | Shape (or your validator) rejected it        |
| `DGII_TAXPAYER_ID_MISMATCH`    | 403             | Document issuer ≠ authorized taxpayer        |
| `DGII_TAXPAYER_ID_FORBIDDEN`   | 403             | Taxpayer belongs to another organization     |
| `DGII_ORGANIZATION_REQUIRED`   | 400             | Organization plugin installed, none in scope |
| `DGII_ORGANIZATION_NOT_FOUND`  | 404             | Unknown organization id                      |
| `DGII_NOT_A_MEMBER`            | 403             | Caller is not in the organization            |
| `DGII_INSUFFICIENT_ROLE`       | 403             | Caller's role is not allowed                 |
| `DGII_CREDENTIALS_UNAVAILABLE` | 500             | No key material for this taxpayer            |
| `DGII_STATUS_API_KEY_REQUIRED` | 500             | `status.apiKey` not configured               |
| `DGII_DOCUMENT_UNREADABLE`     | 400             | Document carries no issuer                   |
| `DGII_SIGNING_FAILED`          | 400             | The signer rejected the document             |
| `DGII_IDEMPOTENCY_IN_FLIGHT`   | 409             | A previous attempt may have landed           |
| `DGII_PERSISTENCE_UNAVAILABLE` | 501             | Audit listing while persistence is off       |
| `DGII_REQUEST_FAILED`          | 400/409/500/502 | DGII (or the SDK) failed — see below         |

`DGII_REQUEST_FAILED` wraps a DGII failure. The body carries the detail:

```json
{
  "code": "DGII_REQUEST_FAILED",
  "message": "Request timed out",
  "dgii": { "code": "TIMEOUT", "resource": "recepcion/api/FacturasElectronicas" }
}
```

Status mapping: `400` means the request or the document is wrong and resending it
unchanged will fail again; `409` is an idempotency conflict; `500` is a server-side
configuration problem; `502` means DGII or the network to it failed and a retry is worth
attempting. Rejection `mensajes` DGII returned are preserved; the raw body is **not**
forwarded, because on the authentication endpoints it carries a bearer token.

## DGII status endpoints

```ts
dgiiEcf({ credentials, status: { apiKey: process.env.DGII_STATUS_API_KEY } });
```

```ts
await authClient.dgiiEcf.serviceStatus();
await authClient.dgiiEcf.maintenanceWindows();
await authClient.dgiiEcf.serviceAvailability({ query: { environment: 'production' } });
```

These check DGII's own status service. They still need a session (where you expose DGII
health is your decision), and they require the API key unless you supplied your own
client through `getClient` — in that case the key is yours to configure.

## Audit trail

```ts
const { data } = await authClient.dgiiEcf.submissions({
  query: { limit: 20, status: 'failed' },
});
```

Records carry `taxPayerId`, `organizationId`, `operation`, `status`, `encf`, `trackId`,
`documentHash`, `errorCode` and `createdAt`. The signed XML and the key material are
never stored — the hash is enough to prove which document a row is about.

## Client usage

```ts
import { dgiiEcfClient } from '@deuriib/better-dgii-ecf/client';

const authClient = createAuthClient({ plugins: [dgiiEcfClient()] });
```

The client adds no runtime code: Better Auth infers every method from your server
plugin, so a renamed path is a type error rather than a broken invoice. Methods are
namespaced under `dgiiEcf` (`documents`, `inquiries`, `directories`, `serviceStatus`,
`maintenanceWindows`, `serviceAvailability`, `submissions`, `taxpayer`, `authenticate`).

Server-side, the same endpoints are available as `auth.api.dgiiEcfSendDocument`,
`auth.api.dgiiEcfInquiryStatus`, and so on — useful inside a job or a webhook.

## Configuration reference

| Option                          | Type                                                    | Default              | Notes                                    |
| ------------------------------- | ------------------------------------------------------- | -------------------- | ---------------------------------------- |
| `environment`                   | `Environment \| (scope) => Environment`                 | `Environment.Dev`    | Certification environments are opt-in    |
| `credentials`                   | `(scope) => P12ReaderData \| null`                      | —                    | Required unless `getClient`              |
| `getClient`                     | `(scope) => ECF \| null`                                | —                    | Disables caching and signing             |
| `resolveTaxPayerId`             | `({ user, session, organizationId }) => string \| null` | —                    | Last resolution source                   |
| `authorize`                     | `(context) => boolean`                                  | —                    | Replaces the built-in policy             |
| `organization.field`            | `string`                                                | `'taxPayerId'`       | Field read from the organization         |
| `organization.extendSchema`     | `boolean`                                               | `false`              | Read-only field registration             |
| `roles`                         | `string[]`                                              | `['owner', 'admin']` | Roles allowed to invoice                 |
| `allowUntrustedTaxPayerId`      | `boolean`                                               | `false`              | Request-supplied id with no organization |
| `validateTaxPayerId`            | `'format' \| 'off' \| validator`                        | `'format'`           | Shape policy                             |
| `persistence.enabled`           | `boolean`                                               | `true`               | Audit + replay guard                     |
| `persistence.storeResponses`    | `boolean`                                               | `true`               | Keep the DGII answer for replays         |
| `persistence.maxResponseLength` | `number`                                                | `8192`               | Truncation bound                         |
| `clientCache.maxSize`           | `number`                                                | `50`                 | Cached `ECF` instances                   |
| `clientCache.ttlMs`             | `number`                                                | `600000`             | Reuse window                             |
| `status.apiKey`                 | `string`                                                | —                    | DGII status service key                  |
| `timeoutMs`                     | `number`                                                | SDK default          | Forwarded to the SDK                     |
