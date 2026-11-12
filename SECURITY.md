# Security Policy

## Supported versions

| Version | Supported       |
| ------- | --------------- |
| `0.x`   | ✅ current line |
| `< 0.1` | ❌ pre-release  |

While the package is `0.x`, security fixes ship as patch releases on the latest minor.
Pin a minor (`~0.1`) if you need stability across an audit.

## What is in scope

- Credential handling: anything that could leak key material, certificate passwords or a
  DGII bearer token.
- Authorization: any way for a session to act on behalf of a taxpayer it should not, or
  to widen the scope of a request.
- Replay safety: any path that can submit the same fiscal document twice.
- Injection and parsing: the XML readers, the audit response serialization.
- Dependency and supply-chain issues in the published artifact.

## What is not in scope

- DGII's own services, their availability or their responses.
- The `@deuriib/dgii-ecf` SDK's XMLDSig implementation — report those
  [upstream](https://github.com/deuriib/dgii-ecf/security).
- Business correctness of a document (taxes, totals, NCF sequences).
- Vulnerabilities that require a compromised host, a modified `node_modules` or
  database-level write access.

## Reporting a vulnerability

**Do not open a public issue.**

Email **deuriib@gmail.com** with:

- a description of the issue and its impact,
- the affected version,
- a reproduction (code, request, or a failing test),
- and whether you intend to publish.

You will receive an acknowledgement within **72 hours** and an assessment within **7
days**. If the report is valid, a fix ships as a patch release with provenance
attestation, and you are credited unless you ask otherwise. Please give the project **90
days** before public disclosure, or less if a fix and an advisory are ready earlier.

## How the package protects itself

- **npm trusted publishing (OIDC).** Releases are published by a GitHub Actions workflow
  exchanging a short-lived OIDC token; there is no long-lived npm token in the
  repository. Every release carries a provenance attestation you can verify with
  `npm audit signatures`.
- **`gitleaks` in pre-commit** and secret scanning in CI, so a certificate or token
  committed by accident fails before it reaches a branch.
- **CodeQL** on every push and pull request, plus grouped Dependabot updates for the
  toolchain and the workflow actions.
- **No runtime secrets in the artifact.** The published tarball contains compiled code,
  types and the README — nothing else. `mise run pack-check` validates the packed
  contents on every CI run.

## Hardening checklist for deployers

See [docs/security.md](docs/security.md#deployment-checklist). The short version: keep
certificates in a secret manager, install the organization plugin for any multi-tenant
surface, keep persistence enabled, and treat a `409` as "reconcile", never "retry".
