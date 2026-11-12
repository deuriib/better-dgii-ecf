# Releasing

Two things have to be true for a release: the package must be bootstrapped on npm, and
the repository must be allowed to publish it. After that, a merge is the only step.

## One-time bootstrap

npm cannot configure trusted publishing for a package that does not exist yet, and it
cannot perform a package's **first** publish over OIDC either — the publisher is
configured _on the package_. Both halves are verified, not assumed:

```console
$ npm trust github "@deuriib/better-dgii-ecf" --file publish.yml --repo deuriib/better-dgii-ecf
npm error code E404
npm error 404 Not Found - POST https://registry.npmjs.org/-/package/@deuriib%2fbetter-dgii-ecf/trust - Package not found
```

So the order is: publish once by hand, configure the publisher, then release normally.

### Step 1 — publish once with your own npm login

```bash
npm login
mise run publish-bootstrap   # build + `npm publish --access public`, no OIDC, no token stored
npm logout
```

`publish-bootstrap` exists as a task of its own precisely because it is the one publish
that must _not_ go through CI: it carries no provenance, and it should never run again.
Publishing the real `0.0.0` of the package is preferable to a throwaway placeholder — it
is a version nobody installs, not a stranger's package name.

### Step 2 — trust this repository's publish workflow

```bash
npm login   # 2FA is required for this operation
npm trust github "@deuriib/better-dgii-ecf" \
  --file publish.yml \
  --repo deuriib/better-dgii-ecf \
  --allow-publish
npm logout
```

`--file` takes the workflow **filename**, not a path — `.github/workflows/publish.yml`
is rejected as a file name. `--allow-publish` grants the workflow publish permission
instead of only provenance signing.

The equivalent UI path is npmjs.com → the package → Settings → Trusted publishing:

| Field         | Value             |
| ------------- | ----------------- |
| Publisher     | GitHub Actions    |
| Organization  | `deuriib`         |
| Repository    | `better-dgii-ecf` |
| Workflow name | `publish.yml`     |
| Environment   | _(empty)_         |

Either way, from then on the workflow exchanges a short-lived OIDC token for a publish
credential: there is no long-lived npm token anywhere.

## Before the first release

Do the bootstrap **first**, then merge the release pull request. If the release PR is
merged before the trusted publisher exists, `publish.yml` fails with a 404 from the
registry — nothing is corrupted, the tag simply exists without a published package, and
the workflow can be re-dispatched once the publisher is configured. Doing it in the
other order avoids the noise.

## Why the release pull request has no checks

release-please runs with `secrets.GITHUB_TOKEN`, and GitHub does not start workflow runs
for events created with that token. The release PR therefore looks like a PR with no CI
— not because the checks were skipped by configuration, but because no `pull_request`
event was ever emitted for it.

That is tolerable precisely because the publish job re-runs the suite before it uploads:
the artifact that reaches the registry has always been tested from the commit it was
built from. `docs/decisions.md` records the same reasoning for why a tag is not treated
as evidence.

## The release flow

1. Merge a pull request whose title is a Conventional Commit onto `main`.
2. `release-please.yml` opens (or updates) a release PR with the version bump and the
   changelog entry, derived from the commit types.
3. Merge that release PR. release-please tags `v<version>` and creates the GitHub
   release.
4. GitHub suppresses the `push` events it creates with `GITHUB_TOKEN`, so the release
   workflow **dispatches** `publish.yml` explicitly — no personal access token involved.
5. `publish.yml` re-runs the tests, builds, and runs `npm publish --provenance`.

`bump-minor-pre-major` is on: while the package is `0.x`, a `feat` produces a minor bump
and a `fix` a patch, which is what a `0.x` contract expects.

## Verifying a release

```bash
npm audit signatures @deuriib/better-dgii-ecf
npm view @deuriib/better-dgii-ecf@<version> dist.integrity
```

`npm audit signatures` checks the provenance attestation against the Sigstore
transparency log — it is the only way to know the tarball came from this repository's
workflow and not from a stolen token.

## Hotfix

Cut from the tag, not from `main`:

```bash
git switch -c fix/<slug> v<version>
# commit the fix with a `fix:` subject
```

Merge to `main` as usual; release-please bumps the patch. A fix merged only into a tag
exists nowhere in history and will be lost by the next release.

## Manual publish (break-glass)

Only when the workflow is unavailable:

```bash
mise run publish-dry-run   # prove the artifact first
mise run publish           # requires a token in the environment
```

Record why in the release notes: a release without provenance is a release nobody can
verify.
