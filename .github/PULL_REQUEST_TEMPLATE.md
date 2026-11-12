## Description

<!-- What changes, and why? Link the issue if there is one. -->

## Type of change

- [ ] `feat` — new capability (minor)
- [ ] `fix` — bug fix (patch)
- [ ] `docs` — documentation only
- [ ] `refactor` / `perf` — behaviour preserved
- [ ] `test` — tests only
- [ ] `build` / `ci` / `chore` — toolchain

## Checklist

- [ ] `mise run ci` passes locally (format, types, coverage, build, pack checks)
- [ ] New behaviour is covered by a test that fails without the change
- [ ] The commit subject is a Conventional Commit, because release-please derives the
      version from it
- [ ] A new endpoint is registered in `src/plugin.ts`, listed in `test/client-types.ts`,
      and documented in the README + `docs/usage.md`
- [ ] A new error code is declared in `src/errors.ts` and added to the error table in
      `docs/usage.md`
- [ ] No certificate, private key, DGII token, password or real taxpayer data is
      included — not even as a "test" fixture
- [ ] Security-relevant behaviour is described in the description (what an attacker
      could do before/after)

## Behaviour under failure

<!-- For anything that transmits a document: what happens on timeout, on retry, and on a 409? -->

---

> 🔐 Never commit a `.p12`, `.pem`, DGII API key or a production RNC.
