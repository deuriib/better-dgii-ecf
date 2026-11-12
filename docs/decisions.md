# Decision record

Why the defaults are what they are. Each entry states the decision, the forces behind
it, and what it costs.

## ADR-1 — Resolve the taxpayer first, authorize second

**Decision.** Resolution (which taxpayer) and authorization (may this caller act for it)
are separate steps, and authorization runs after resolution.

**Why.** The per-call mode is a requirement, and it is only safe if naming a taxpayer is
a request rather than a grant. Splitting the two also keeps the policy readable: the
resolution order never changes, while the authorization table can be replaced wholesale
by `authorize`.

**Cost.** Two concepts instead of one, and two error families
(`DGII_TAXPAYER_ID_REQUIRED` vs `DGII_TAXPAYER_ID_FORBIDDEN`). Worth it: the second
error is the one a security review looks for.

## ADR-2 — Strict by default with the organization plugin, permissive without it

**Decision.** When the organization plugin is installed, an organization is mandatory
for a request-supplied taxpayer id (unless `allowUntrustedTaxPayerId`). When it is not
installed, the request-supplied id is accepted.

**Why.** With a tenant model present, ignoring it would be a hole. Without one, there is
nothing to compare against, and refusing would make the documented single-tenant
deployment impossible. Failing closed _and_ supporting both shapes requires the policy
to be conditional on the tenant model's presence.

**Cost.** Two behaviours to document, chosen by configuration rather than a flag.
`docs/security.md` states the consequence explicitly so nobody discovers it in
production.

## ADR-3 — Key material only through a server-side callback

**Decision.** Credentials arrive via `credentials(scope)` or `getClient(scope)`. There
is no endpoint that accepts a key or a password, and no option to inline one in the
plugin configuration.

**Why.** A configuration-inlined key ends up in a repository, a container image or a
log. A callback makes the key the host's responsibility, at the moment it is needed,
scoped to an already-authorized taxpayer.

**Cost.** The plugin cannot be used without writing a resolver — a deliberate friction,
because the alternative is a footgun.

## ADR-4 — A database-backed replay guard, not an in-memory one

**Decision.** The replay decision reads and writes a `dgiiEcfSubmission` row; the
pending row is written before transmission.

**Why.** The SDK's idempotency store is in memory. A restart, a second replica or a
serverless cold start loses it, and a retried POST can issue the same fiscal document
twice. The row is the only place where "I already sent this" survives.

**Cost.** A migration and one table. The plugin registers its own schema so
`auth generate` handles it, and `persistence.enabled: false` exists for hosts that
already run a durable outbox.

## ADR-5 — XML in, XML out

**Decision.** Submissions take XML. The plugin reads two facts from a document (the
issuer and the root element) and never builds one.

**Why.** Invoice models are domain decisions: taxes, retention, NCF sequences, rounding
rules. A plugin that modeled them would need a migration for every DGII schema revision
and would still be wrong for half its users. Reading only what it must refuse keeps the
surface honest.

**Cost.** Callers need a document builder. `sign: true` removes the hard part (the
private key) from the client, which is the trade the plugin cares about.

## ADR-6 — The organization field is writable only through the organization plugin

**Decision.** `organization.extendSchema` registers a read-only column (`input: false`);
`dgiiEcfOrganizationSchema()` is the supported way to make the field writable.

**Why.** The organization plugin builds its create/update input schema from its own
`additionalFields`. A field declared only by this plugin is readable but not accepted by
`organization.update` — verified against Better Auth 1.7, not assumed. Shipping a mode
that silently drops writes would be worse than a slightly more verbose setup.

**Cost.** Two setup shapes. Both are documented with the reason, and the default
(`extendSchema: false`) never surprises anyone.

## ADR-7 — Never return the DGII token

**Decision.** `authenticate` returns the validity window only.

**Why.** The token is a bearer credential for DGII, derived from the taxpayer's
certificate. Returning it would move the certificate's authority into the browser, which
is exactly what this plugin exists to prevent. The same reasoning removes `data` from
error bodies.

**Cost.** A client cannot make its own DGII calls. That is the point.

## ADR-8 — mise is the only runner

**Decision.** Every task — locally, in git hooks and in CI — runs through
`mise run <task>`, with tool versions pinned in `mise.toml`.

**Why.** "Works on my machine" in a package that signs fiscal documents is a release
blocker. A single runner means the Node version, the Bun version, the formatter and the
test command cannot drift between a laptop and CI, and a new contributor runs one
command to reproduce a failure.

**Cost.** mise must be installed (one line, documented), and CI runs through
`jdx/mise-action`, reading the same `mise.toml`. The alternative — duplicating version
pins across workflows — is a known source of drift.

## ADR-9 — tsup, dual ESM + CJS, no bundling of peers

**Decision.** Ship ESM and CJS with separate declarations per condition, and keep
`better-auth`, `@better-auth/core`, `@deuriib/dgii-ecf` and `zod` external.

**Why.** Better Auth plugins rely on module identity for type augmentation: two copies
of `better-auth` would produce two registry types and inference would fail. The DGII SDK
and zod are peer/runtime decisions the host must control. `attw` (`node16` profile)
enforces that the published types resolve under both module systems, which caught the
initial `Masquerading as ESM` defect.

**Cost.** A more verbose `exports` map and a `pack-check` step in CI.
