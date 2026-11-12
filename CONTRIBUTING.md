# Contributing

Thanks for taking the time. This package signs and transmits fiscal documents, so the
bar is deliberately high — but the workflow is short.

- [Toolchain](#toolchain)
- [The loop](#the-loop)
- [What CI runs](#what-ci-runs)
- [Commits and releases](#commits-and-releases)
- [Adding an endpoint](#adding-an-endpoint)
- [Adding an error code](#adding-an-error-code)
- [Never commit](#never-commit)

## Toolchain

Everything runs through [mise](https://mise.jdx.dev). Install it, then:

```bash
mise install          # Node, Bun, pre-commit, gitleaks — pinned in mise.toml
mise run bootstrap    # dependencies + git hooks
```

You do not need Node or Bun installed globally, and you should not call `npm`, `bun` or
`tsc` directly: the tasks exist so your machine and CI run the same commands with the
same versions.

## The loop

```bash
mise run test          # Vitest
mise run lint          # Prettier check + tsc --noEmit
mise run coverage      # thresholds enforced
mise run ci            # everything CI runs
```

`mise tasks` lists every task, including `format`, `build`, `pack` and `pack-check`.

## What CI runs

`.github/workflows/ci.yml` runs `mise run ci` on Node 24 with the toolchain read from
`mise.toml`. That is: format check, typecheck, coverage with thresholds, build, and
`publint` + `are-the-types-wrong` on the packed tarball. A pull request that changes the
`exports` map without a passing `pack-check` will be rejected — `attw` is what catches a
package that resolves in your editor but not in a consumer's CommonJS build.

Coverage thresholds are 90% lines/functions/statements and 85% branches. New behaviour
needs a test that would fail if the behaviour were removed; a test that only executes
the lines is not enough.

## Commits and releases

[Conventional Commits](https://www.conventionalcommits.org) are parsed by
release-please:

| Prefix                                                            | Release                        |
| ----------------------------------------------------------------- | ------------------------------ |
| `feat:`                                                           | minor                          |
| `fix:`                                                            | patch                          |
| `feat!:` / `BREAKING CHANGE:`                                     | minor while `0.x`, major after |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `perf:`, `build:` | no release                     |

Merge the release-please pull request to publish. The publish workflow exchanges a
GitHub OIDC token for a short-lived npm credential — there is no `NPM_TOKEN` to
configure, and a release never needs a human holding a secret.

### What the squash commit message becomes

With squash merging, the pull request **title and body become the commit message**, and
that message is what release-please parses. Two things in it fail silently: the run
reports success, the release pull request is never opened, and the version stops
advancing while `main` keeps moving.

**Fenced code blocks break the parser.** `@conventional-commits/parser` rejects a body
containing one, with a message that names a position inside the commit rather than the
cause:

```text
commit could not be parsed: 6b4c7a8 fix(security)!: ...
error message: Error: unexpected token '
' at 55:10, valid tokens [)]
commits: 0  →  Would open 0 pull requests
```

Line 55 was `dgiiEcf({` inside a `ts` fence: an unclosed parenthesis to that grammar.
Keep code out of pull request bodies and point at the file or test instead; if a commit
has to carry one, expect to amend the message afterwards.

**One `Closes` per line.** GitHub honours only the first reference in a comma-separated
list, so `Closes #21, #22` closes #21 and leaves #22 open — which happened twice here
before it was noticed. Write:

```text
Closes #21
Closes #22
```

To diagnose without pushing, run the same parser locally:

```bash
gh auth token | xargs -I{} npx release-please@17 release-pr --dry-run \
  --token {} --repo-url https://github.com/$OWNER/$REPO --target-branch main --debug
```

Look for `commit could not be parsed`. Everything else release-please reports — the
version bump, the changelog entry — is derived from messages it could parse, so a
skipped commit is a changelog omission too, not just a delay.

## Releasing

Releases are automated through release-please and published over npm OIDC trusted
publishing — no `NPM_TOKEN` exists in this repository. The one-time bootstrap (npm
cannot do a _first_ publish over OIDC) and the provenance verification steps are in
[docs/releasing.md](docs/releasing.md).

## Adding an endpoint

1. Add the handler in the right module under `src/endpoints/` using `createAuthEndpoint`
   and `sessionMiddleware`.
2. Resolve the scope with `prepare(deps, ctx, input)` — never read the taxpayer from the
   request inline. `prepare` is where authorization happens.
3. If it transmits a document, wrap it in `runSubmission` (replay guard + audit).
4. Register it in `src/plugin.ts` with a `dgiiEcf*` key.
5. Add it to `test/client-types.ts` so the inferred client surface is checked, and cover
   the endpoint in `test/endpoints.test.ts`.
6. Document it in the table in `docs/usage.md` and in the README.

The client plugin needs no change: it infers methods from the server plugin. That is the
reason a covering type test is mandatory — a missing entry in `test/client-types.ts` is
how a client break would slip through.

## Adding an error code

Codes are declared once, in `src/errors.ts`, via `defineErrorCodes`:

```ts
export const DGII_ECF_ERROR_CODES = defineErrorCodes({
  DGII_SOMETHING_BROKEN: 'A sentence a caller can act on',
});
```

Then throw it through a helper (`badRequest`, `forbidden`, `conflict`, `serverError`) so
the HTTP status is decided next to the code, and add it to the error table in
`docs/usage.md`. Keys must be `UPPER_SNAKE_CASE` and prefixed with `DGII_` — the prefix
keeps the namespace unique when several plugins report errors through the same client.

## Never commit

- A `.p12`, `.pem`, private key or certificate of any kind — including a "test" one.
  Tests use PEM-shaped placeholders and assert the failure paths instead.
- A DGII token, API key, RNC password or certificate password.
- A production taxpayer id in a fixture. Use the documented example ids.

`gitleaks` runs in pre-commit and in CI, but it is a net, not a licence.

## Questions

Open a discussion or an issue. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
