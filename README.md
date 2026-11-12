# better-dgii-ecf

[English](README.md) · [Español](README.es.md)

> A [Better Auth](https://better-auth.com) plugin for the Dominican Republic's **DGII**
> electronic invoicing (e-CF) services, built on
> [`@deuriib/dgii-ecf`](https://www.npmjs.com/package/@deuriib/dgii-ecf).

[![npm](https://img.shields.io/npm/v/@deuriib/better-dgii-ecf.svg?label=npm)](https://www.npmjs.com/package/@deuriib/better-dgii-ecf)
[![CI](https://github.com/deuriib/better-dgii-ecf/actions/workflows/ci.yml/badge.svg)](https://github.com/deuriib/better-dgii-ecf/actions/workflows/ci.yml)
[![CodeQL](https://github.com/deuriib/better-dgii-ecf/actions/workflows/codeql.yml/badge.svg)](https://github.com/deuriib/better-dgii-ecf/actions/workflows/codeql.yml)
[![npm provenance](https://img.shields.io/badge/provenance-OIDC-blue)](https://docs.npmjs.com/trusted-publishers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/)

`better-dgii-ecf` turns the DGII SDK into an authenticated API surface. It decides
**which taxpayer** a request acts for, resolves that taxpayer's certificate
**server-side**, and records every transmission so a retry can never issue the same
fiscal document twice.

It is a plugin, not a document builder: your application owns the invoice model, the
plugin owns identity, credentials, replay safety and the audit trail.

## ✨ Why this plugin exists

A DGII integration has three problems that authentication frameworks do not solve:

| Problem                              | What goes wrong without it                                               | What the plugin does                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Who is invoicing?**                | The RNC comes from the browser, so any user can invoice as any taxpayer. | Resolves the taxpayer from the organization, the request, or a server-side mapping — then authorizes it. |
| **Where does the certificate live?** | The `.p12` ends up in the client, or in every request body.              | Resolves key material through a server-only callback; signs server-side; never returns a DGII token.     |
| **Did the invoice land?**            | A timeout plus a retry issues the same e-NCF twice.                      | Persists a pending row before transmitting and replays a known submission instead of re-sending it.      |

## 📦 Install

```bash
bun add @deuriib/better-dgii-ecf @deuriib/dgii-ecf better-auth
# or: npm install @deuriib/better-dgii-ecf @deuriib/dgii-ecf better-auth
```

Peer dependencies: `better-auth@^1.7`, `@deuriib/dgii-ecf@^0.6`.

## 🚀 Quick start — organization mode

The recommended setup. `taxPayerId` lives on the organization, so the RNC a user can
invoice under is the organization they belong to.

```ts
// auth.ts
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { P12Reader, Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '@deuriib/better-dgii-ecf';

export const auth = betterAuth({
  plugins: [
    organization({
      // Makes `taxPayerId` writable on the organization (create + update).
      schema: { organization: dgiiEcfOrganizationSchema() },
    }),
    dgiiEcf({
      environment: Environment.Cert,
      // The only place a certificate is ever read. Called server-side, once per
      // taxpayer, never from a request body.
      credentials: async ({ taxPayerId }) => {
        const p12 = await certificates.for(taxPayerId); // your storage
        const parsed = new P12Reader(p12.password).getKeyFromStringBase64(p12.base64);
        if (parsed.isErr()) {
          throw parsed.error;
        }
        return parsed.value;
      },
      status: { apiKey: process.env.DGII_STATUS_API_KEY! },
    }),
  ],
});
```

```ts
// auth-client.ts
import { createAuthClient } from 'better-auth/client';
import { organizationClient } from 'better-auth/client/plugins';
import { dgiiEcfClient } from '@deuriib/better-dgii-ecf/client';

export const authClient = createAuthClient({
  plugins: [organizationClient(), dgiiEcfClient()],
});
```

```ts
const { data, error } = await authClient.dgiiEcf.documents({
  xml: invoiceXml, // built by your application
  sign: true, // signed here, with the organization's key
});
```

## 🚀 Quick start — per-call mode

No organization plugin: every call names its taxpayer. This is the single-tenant shape,
and it works because there is no tenant model to check the id against.

```ts
dgiiEcf({
  environment: Environment.Dev,
  credentials: async () => loadSingleTenantCertificate(),
});
```

```ts
await auth.api.dgiiEcfSendDocument({
  body: { xml, sign: true, taxPayerId: '131123456' },
  headers,
});
```

Both modes are first class;
[the resolution order](docs/usage.md#which-taxpayer-does-a-call-act-for) is fixed and
reported back by `GET /dgii-ecf/taxpayer`, so a UI never has to guess.

## 🔌 What you get

| Method                                 | Path                                           | Purpose                                                           |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `dgiiEcf.taxpayer`                     | `GET /dgii-ecf/taxpayer`                       | Resolve which taxpayer the next call uses, and why                |
| `dgiiEcf.authenticate`                 | `POST /dgii-ecf/authenticate`                  | Warm the DGII token; returns the validity window, never the token |
| `dgiiEcf.documents`                    | `POST /dgii-ecf/documents`                     | Submit an e-CF, routing on the document's own content             |
| `dgiiEcf.documents.electronic`         | `POST /dgii-ecf/documents/electronic`          | Submit to the general e-CF reception only                         |
| `dgiiEcf.documents.summary`            | `POST /dgii-ecf/documents/summary`             | Submit an RFCE summary invoice                                    |
| `dgiiEcf.documents.commercialApproval` | `POST /dgii-ecf/documents/commercial-approval` | Submit an ACECF                                                   |
| `dgiiEcf.documents.voidRange`          | `POST /dgii-ecf/documents/void-range`          | Void an e-NCF range (ANECF)                                       |
| `dgiiEcf.documents.reconcile`          | `POST /dgii-ecf/documents/reconcile`           | Resolve a submission whose outcome is unknown                     |
| `dgiiEcf.tracks`                       | `GET /dgii-ecf/tracks`                         | Read a track result                                               |
| `dgiiEcf.inquiries.status`             | `POST /dgii-ecf/inquiries/status`              | Existence check by e-NCF                                          |
| `dgiiEcf.inquiries.tracks`             | `POST /dgii-ecf/inquiries/tracks`              | Every track DGII holds for an e-NCF                               |
| `dgiiEcf.inquiries.summary`            | `POST /dgii-ecf/inquiries/summary`             | RFCE inquiry (production only)                                    |
| `dgiiEcf.directories.customers`        | `GET /dgii-ecf/directories/customers`          | Receiver service directory                                        |
| `dgiiEcf.directories.all`              | `GET /dgii-ecf/directories/all`                | Every receiver that publishes URLs                                |
| `dgiiEcf.serviceStatus`                | `GET /dgii-ecf/service-status`                 | DGII service status                                               |
| `dgiiEcf.maintenanceWindows`           | `GET /dgii-ecf/maintenance-windows`            | DGII maintenance windows                                          |
| `dgiiEcf.serviceAvailability`          | `GET /dgii-ecf/service-availability`           | Is one environment inside a window                                |
| `dgiiEcf.submissions`                  | `GET /dgii-ecf/submissions`                    | The submission audit trail                                        |

Every response echoes `taxPayerId`, `organizationId` and `environment`, so a caller can
always tell which identity acted.

## 🔐 Security posture

- **No certificate in a browser.** Key material is resolved through a server-only
  callback; `sign: true` signs inside the process that holds it.
- **No DGII token on the wire.** `authenticate` returns `issuedAt` / `expiresAt`; the
  bearer token never leaves the server, not even in an error body.
- **The issuer must match.** A document whose `RNCEmisor` differs from the authorized
  taxpayer is refused, so a member of organization A cannot submit a document for RNC B.
- **Replay safe by construction.** The replay key defaults to the SHA-256 of the
  document, and the pending row is written before transmission.
- **No fiscal content in the audit table.** Only a hash, the e-NCF, the track id and the
  operation.

Read [docs/security.md](docs/security.md) for the threat model, including what the
plugin deliberately does **not** protect against.

## 🧪 Development

Everything runs through [mise](https://mise.jdx.dev) — locally and in CI, with the same
pinned toolchain.

```bash
mise install            # provision Node, Bun, pre-commit, gitleaks
mise run bootstrap      # dependencies + git hooks
mise run ci             # format check + typecheck + coverage + build + pack checks
mise tasks              # list every task
```

| Task                  | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `mise run lint`       | Prettier check + `tsc --noEmit`                         |
| `mise run test`       | Vitest                                                  |
| `mise run coverage`   | Vitest with thresholds enforced                         |
| `mise run build`      | ESM + CJS + declarations                                |
| `mise run pack-check` | `publint` + `are-the-types-wrong` on the packed tarball |
| `mise run publish`    | OIDC trusted publish (no token on disk)                 |

## 📚 Documentation

- [Usage guide](docs/usage.md) — modes, endpoints, replay, errors
- [Architecture](docs/architecture.md) — request lifecycle and data model
- [Security](docs/security.md) — threat model and guarantees
- [Decision record](docs/decisions.md) — why the defaults are what they are
- [Releasing](docs/releasing.md) — trusted publishing, provenance, hotfixes
- [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## ⚖️ License

[MIT](LICENSE) © 2026 Deuri Vasquez.

> Not affiliated with the DGII. This is an independent implementation of the publicly
> documented e-CF specification (Ley 32-23, Decreto 587-24). Always validate against the
> official
> [DGII documentation](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/default.aspx).
