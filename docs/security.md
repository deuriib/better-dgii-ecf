# Security

What the plugin guarantees, what it assumes, and what it deliberately leaves to you.

- [Assets](#assets)
- [Guarantees](#guarantees)
- [The multi-tenant boundary](#the-multi-tenant-boundary)
- [Non-goals](#non-goals)
- [Deployment checklist](#deployment-checklist)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## Assets

| Asset                              | Where it lives                       | Boundary                                                  |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| Private key + certificate (`.p12`) | Your storage, resolved by a callback | Never accepted over HTTP, never logged, never returned    |
| DGII bearer token                  | The cached `ECF` instance            | Never returned by any endpoint, not even in an error body |
| Certificate password               | Your secret store                    | Never seen by this plugin                                 |
| Fiscal documents                   | Your application                     | Only a SHA-256 is stored by the plugin                    |
| Taxpayer id (RNC)                  | Organization field or request        | Authorized before use                                     |

## Guarantees

### The certificate never reaches a browser

Key material enters the plugin only through `credentials(scope)` — a server-side
callback invoked after authorization. There is no endpoint that accepts a key, a
certificate, a password or a `.p12`. `sign: true` performs the signature inside the
server process, which is why a browser can submit a document body safely.

### The DGII token is never on the wire

`POST /dgii-ecf/authenticate` returns `issuedAt` / `expiresAt` and nothing else. The
token is a bearer credential for DGII, minted from the certificate; handing it to a
client would hand over the ability to submit documents as that taxpayer. The same rule
applies to failures: the error mapping strips `data`, which on the authentication
endpoints is the body that carries the token.

### The tenant id cannot be forged by editing the organization

The field that binds a tenant to a taxpayer is writable — the organization plugin owns
its input schema — so the plugin guards the write: setting it requires
`verifyTaxPayerOwnership`, and a write without a verification is refused. That closes
the escalation where an organization admin claims any RNC and invoices as that taxpayer.

### A request cannot choose where the certificate is sent

Direct buyer delivery authenticates against a buyer host by posting a signature made
with the organization's private key. The URL therefore comes from `buyerDelivery.hosts`,
never from a request: a request selects a configured name. Accepts HTTPS only, validates
the configuration at construction, and never echoes the configured URLs back.

### The document issuer must match the authorized taxpayer

Submitting a document whose `RNCEmisor` differs from the resolved taxpayer is refused
(`403 DGII_TAXPAYER_ID_MISMATCH`). Without this check, a signing key would be mistaken
for an authorization: any member of any organization could build a valid document for
another taxpayer, have it signed with their own certificate, and submit it.

### Retries cannot double-issue

The replay key defaults to the SHA-256 of the signed document; the pending row is
written before transmission. A `pending` record blocks a retry with `409` rather than
guessing, because a duplicate fiscal document is worse than a failed request. The guard
is in the database, not in memory, so it survives a restart and covers every replica.

### Authorization happens before credential resolution

An unauthorized caller never triggers a credential lookup, so response time and error
shape do not reveal whether a taxpayer has credentials configured.

### Errors carry codes, not payloads

Every failure is an `APIError` with a stable `code`. The DGII detail forwarded is
`code`, `status`, `statusText`, `resource`, `method` and DGII's `mensajes` — never the
upstream body.

## The multi-tenant boundary

**With the organization plugin installed**, the tenant is the unit of trust: the caller
must be a member of the organization in scope, hold a role from `roles` (default
`owner`, `admin`), and — when the organization stores a taxpayer id — the resolved id
must be that one. A request may name a taxpayer, but it cannot name one the organization
does not own.

**Without the organization plugin**, there is no tenant model to check a
request-supplied taxpayer id against, so the plugin accepts it. This is the
single-tenant mode: correct for an application that invoices as one taxpayer, and the
reason `credentials` should then be bound to that taxpayer regardless of the id in the
request.

If you need a middle ground — an organization-aware app that also lets an admin act for
a taxpayer outside their memberships — use `authorize`:

```ts
dgiiEcf({
  credentials,
  authorize: async ({ user, taxPayerId, organizationTaxPayerId }) => {
    if (organizationTaxPayerId === taxPayerId) return true;
    return isPlatformAdmin(user.id);
  },
});
```

## Non-goals

Stated plainly, because a security document that only lists wins is marketing:

- **It does not validate document content.** XML Schema validation is an SDK option
  (`validateBeforeSend`); business correctness (taxes, totals, NCF sequences) is yours.
- **It does not protect the certificate at rest.** Where the `.p12` lives, how its
  password is stored and who can read it are your infrastructure's problem. KMS, an HSM
  or a signing sidecar is a better home than an application row — that is what
  `getClient` is for.
- **It does not guarantee DGII accepted the document.** `Aceptado` and `Rechazado` are
  business outcomes; the plugin transmits and records, it does not decide.
- **It does not stop a determined insider with database access** from editing submission
  rows. The audit trail is evidence of what the application did, not a tamper-proof
  ledger.
- **It does not implement DGII rate limits or quotas.** The plugin rate limits its own
  surface (60 requests/minute by default); DGII's own limits still apply.
- **It is not safe in a browser or an edge runtime.** The server entrypoint depends on
  Node cryptography and the SDK's `.p12` handling. Use `/client` in the browser.

## Deployment checklist

- [ ] `environment: Environment.Prod` only where real fiscal documents are expected;
      keep certification and production deployments separate.
- [ ] Certificates in a secret store or KMS, not in the application database.
- [ ] The organization plugin installed for any multi-tenant surface, with `taxPayerId`
      declared through `dgiiEcfOrganizationSchema()`.
- [ ] `roles` narrowed to the roles that actually invoice (default is owner+admin).
- [ ] HTTPS only; Better Auth's session cookies already require it.
- [ ] `status.apiKey` configured if you expose the status endpoints.
- [ ] Persistence left **on**, unless a durable outbox already guarantees exactly-once
      submission.
- [ ] Logs reviewed: never log `xml`, `key`, `cert`, `password` or a session token.
- [ ] Rate limit tuned to the traffic DGII expects from the taxpayer.
- [ ] A reconciliation runbook: on `409`, reconcile by e-NCF before retrying.

## Reporting a vulnerability

Please do not open a public issue. Email **deuriib@gmail.com** with a description and a
reproduction; you will get an acknowledgement within 72 hours. See
[SECURITY.md](../SECURITY.md) for the supported versions and the disclosure timeline.
