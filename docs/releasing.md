# Releasing

Two things have to be true for a release: the package must be bootstrapped on npm, and
the repository must be allowed to publish it. After that, a merge is the only step.

## One-time bootstrap

npm cannot perform a package's **first** publish over OIDC: the trusted publisher is
configured _on the package_, so the package must exist first. Pick one path.

### Option A — configure a trusted publisher without a placeholder (npm ≥ 11.10)

```bash
npm login
npm trust github @deuriib/better-dgii-ecf \
  --file .github/workflows/publish.yml \
  --repo deuriib/better-dgii-ecf
```

Then dispatch `publish.yml` once for the first release. Nothing else is needed: no token
is ever stored.

### Option B — placeholder publish, then revoke the token

```bash
# 1. Publish a throwaway version with a granular token (write access, 2FA on).
mise run build
npm publish --access public          # publishes 0.0.0
npm token revoke <token-id>

# 2. On npmjs.com → package → Settings → Trusted publishing:
#      Publisher:        GitHub Actions
#      Organization:     deuriib
#      Repository:       better-dgii-ecf
#      Workflow name:    publish.yml
#      Environment:      (leave empty)
```

The placeholder version is permanent history; Option A avoids it.

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
