# Architecture

How a request travels through the plugin, what it writes, and why the seams are where
they are.

- [Module map](#module-map)
- [Request lifecycle](#request-lifecycle)
- [Resolution and authorization](#resolution-and-authorization)
- [Client cache](#client-cache)
- [Data model](#data-model)
- [Why XML in, XML out](#why-xml-in-xml-out)
- [Testing strategy](#testing-strategy)

## Module map

```text
src/
├── index.ts             server entrypoint (Node only)
├── client.ts            client entrypoint (types only, browser safe)
├── plugin.ts            plugin assembly: schema, endpoints, rate limit
├── resolution.ts        who the call acts for + the authorization policy
├── client-provider.ts   credential resolution + ECF cache
├── persistence.ts       submission records, replay decisions
├── tax-payer.ts         normalization and validation policy
├── xml.ts               minimal readers (issuer, root element)
├── errors.ts            error codes and DGII → HTTP mapping
├── types.ts             public option/scope types
└── endpoints/
    ├── shared.ts        scope+client preparation, submission runner, signing
    ├── documents.ts     send / summary / approval / void / reconcile
    ├── inquiries.ts     tracking, existence checks, directories
    ├── status.ts        DGII operational status
    └── audit.ts         taxpayer resolution and the audit listing
```

The split is by responsibility, not by layer: `resolution.ts` owns identity,
`persistence.ts` owns durability, and no endpoint module re-implements either.

## Request lifecycle

A `POST /dgii-ecf/documents` with `sign: true`:

1. **Session middleware.** Better Auth requires an authenticated session; the plugin
   adds nothing to that contract.
2. **Scope resolution** (`resolveRequestScope`). The organization in scope is read
   (explicit `organizationId`, else the session's active organization), its taxpayer id
   is read and normalized, and the resolution order decides the id: request →
   organization → resolver. A missing id is a `400`.
3. **Authorization.** Membership, role and the stored-id equality check run here,
   _before_ any credential is touched. A caller who may not act for a taxpayer cannot
   learn whether credentials exist for it.
4. **Client resolution.** `clientProvider.get(scope)` returns a cached `ECF` or builds
   one from the resolved key material.
5. **Signing** (when requested). The document's root element is read, the key material
   is resolved again for the signer, and `Signature.signXml` produces the signed
   document. A signer failure is a `400 DGII_SIGNING_FAILED`.
6. **Issuer check.** `RNCEmisor`/`RncEmisor` in the document must equal the resolved
   taxpayer, otherwise `403 DGII_TAXPAYER_ID_MISMATCH`.
7. **Replay decision.** With persistence on, the record for
   `(taxPayerId, idempotencyKey ?? sha256(xml))` is read: `succeeded` replays, `pending`
   conflicts, anything else proceeds.
8. **Pending record.** Written before transmission, so an interrupted send leaves
   evidence instead of silence.
9. **Transmission.** The DGII SDK performs the request with its own retry, circuit
   breaker and timeout policies. A `Result` failure is mapped to an `APIError` and the
   record is closed as `failed`; a success closes it as `succeeded` with the track id
   and (optionally) the serialized answer.
10. **Response.** The DGII payload plus the scope echo: `taxPayerId`, `organizationId`,
    `environment`, `submissionId`, `replayed`.

Read-only endpoints run steps 1–4 and return. Status endpoints additionally require the
configured API key.

## Resolution and authorization

Resolution answers _which_ taxpayer; authorization answers _may this caller act for it_.
Keeping them separate is what makes the per-call mode safe: naming a taxpayer in a body
is a request, not a grant.

```text
                 ┌─────────────────────────┐
body.taxPayerId ─┤                         │
                 │  1. normalize           │
organization ────┤  2. validate shape      ├──► authorized id
                 │  3. authorize           │
resolver ────────┤                         │
                 └─────────────────────────┘
```

The policy itself is a function of four facts: whether the organization plugin is
installed, whether an organization is in scope, the caller's membership and role, and
whether the organization stores a taxpayer id. The table in
[usage.md](usage.md#which-taxpayer-does-a-call-act-for) is the contract; `authorize`
replaces it in one line when a host has its own model.

Two decisions are worth calling out:

- **No organization plugin → per-request id is accepted.** There is no tenant to check
  it against, so refusing would make single-tenant deployments impossible. This is why
  the plugin recommends the organization plugin for anything multi-tenant, and why
  `SECURITY.md` states it plainly.
- **`extendSchema` is read-only.** A field registered only by this plugin is visible to
  Better Auth's output schema but is not part of the organization plugin's input schema,
  so `organization.update` will not accept it. Rather than pretend otherwise, the plugin
  marks it `input: false` and documents the writable path: `dgiiEcfOrganizationSchema()`
  inside the organization plugin's options.

## Client cache

`ECF` instances hold a DGII bearer token and the key material, so they are cached per
`(environment, taxPayerId)`:

| Concern          | Decision                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| Key              | `environment` + `taxPayerId` — two environments must never share a token |
| Size             | `clientCache.maxSize` (default 50), least-recently-used eviction         |
| Lifetime         | `clientCache.ttlMs` (default 10 min); a hit refreshes recency            |
| Rotation         | `plugin.clientProvider.invalidate(taxPayerId)`                           |
| `getClient` mode | No cache — the host owns the lifecycle                                   |

Caching is a correctness feature, not just speed: the DGII token is minted from the
certificate and refreshed by the SDK, so reusing the instance reuses the session instead
of minting a new one per request.

## Data model

One table, `dgiiEcfSubmission` (registered by the plugin schema, so `auth generate` /
`auth migrate` creates it):

| Field                     | Type                                                  | Why                                                             |
| ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `id`                      | string                                                | Row id (Better Auth)                                            |
| `organizationId`          | string?                                               | Tenant scope; null in single-tenant mode                        |
| `taxPayerId`              | string                                                | Replay keys are per taxpayer                                    |
| `userId`                  | string                                                | Who submitted it                                                |
| `environment`             | string                                                | A certification run is not production traffic                   |
| `operation`               | string                                                | Which endpoint produced it                                      |
| `status`                  | `pending` \| `succeeded` \| `failed` \| `unconfirmed` | Drives the replay decision                                      |
| `replayKey`               | string, unique                                        | Environment + organization + taxpayer + idempotency key, joined |
| `idempotencyKey`          | string?                                               | Caller key, else the document hash                              |
| `encf`                    | string?                                               | The fiscal identifier                                           |
| `trackId`                 | string?                                               | DGII's tracking id                                              |
| `documentHash`            | string?                                               | SHA-256, so the XML is never stored                             |
| `errorCode`               | string?                                               | What failed                                                     |
| `response`                | string?                                               | Serialized answer, bounded by `maxResponseLength`               |
| `createdAt` / `updatedAt` | date                                                  | Ordering for replay lookup and audit                            |

The status is a state machine, because "failed" and "we do not know" have opposite
consequences for a retry:

```text
           begin
            │
            ▼
         pending ──definite rejection──► failed ──retry──► pending
            │
            └──may have been delivered──► unconfirmed ──reconcile──► succeeded | failed
            │
            └──────────DGII accepted─────► succeeded ──► replay
```

`replayKey` is unique, which is what makes the guard safe under concurrency: two
requests that read "no record" both try to insert, and the database lets exactly one
win. A `failed` row is reused rather than duplicated, so a legitimate retry does not
need a new row.

Indexes: unique on `replayKey` for the guard, `(taxPayerId, environment, encf)` for
reconcile (it closes open records by document), and `(organizationId, createdAt)` for
the audit listing.

> Adding `replayKey` to an existing deployment needs a migration: the column is required
> and unique, so existing rows must be backfilled as
> `environment ‖ organizationId ‖ taxPayerId ‖ idempotencyKey` before the index is
> created.

Nothing sensitive is stored: no XML, no key material, no token, no certificate password.

## Why XML in, XML out

The DGII SDK signs and transmits XML; it does not model invoices. The plugin keeps that
boundary: building an e-CF from a domain model is an application decision (taxes, items,
totals, NCF sequences, retention rules) and belongs where the domain lives.

The plugin reads exactly two things from a document — the issuer and the root element —
with a tolerant, namespace-aware reader. Both reads exist to _refuse_ something: a
document for another taxpayer, and a signing call on a document with no root. Neither
reads is used to build a response.

## Testing strategy

| Layer                                        | What it proves                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `test/xml.test.ts`, `test/tax-payer.test.ts` | The readers and the validation policy, including the cases that must return `undefined` |
| `test/client-provider.test.ts`               | Caching, TTL, eviction, invalidation, credential failures                               |
| `test/resolution-guards.test.ts`             | Replay decisions and the resolution guard                                               |
| `test/organization-mode.test.ts`             | The organization path end to end, including cross-tenant refusal                        |
| `test/per-call-mode.test.ts`                 | Both non-organization shapes, resolver precedence, authorizer override                  |
| `test/authorization.test.ts`                 | Membership, roles, `allowUntrustedTaxPayerId`, read-only schema mode                    |
| `test/persistence-flow.test.ts`              | Replay, conflict on `pending`, audit listing                                            |
| `test/error-mapping.test.ts`                 | Status mapping for every DGII code, and no payload leak                                 |
| `test/endpoints.test.ts`                     | Every endpoint wired to the right SDK method with the right arguments                   |
| `test/client-types.ts`                       | The inferred client surface (type-level, compiled by `tsc`)                             |

The DGII SDK is replaced by a recording double in the integration tests: the plugin's
responsibility is wiring, authorization and durability, while the protocol itself is the
SDK's own test suite. The one thing this split cannot prove is real XMLDSig output —
that stays with `@deuriib/dgii-ecf`, which verifies signatures against `libxmlsec1` in
its own pipeline.
