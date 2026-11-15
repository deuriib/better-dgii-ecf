# Task List: Upgrade `@deuriib/dgii-ecf` to v0.7.0 and Align `@deuriib/better-dgii-ecf`

Specification reference:
[`project-specs/dgii-ecf-0.7.0-upgrade-setup.md`](../project-specs/dgii-ecf-0.7.0-upgrade-setup.md)
Run Ledger reference:
[`project-tasks/dgii-ecf-0.7.0-upgrade-ledger.md`](dgii-ecf-0.7.0-upgrade-ledger.md)

---

### [x] T0: Spec-to-Tasklist Planning & Task Definition

- **Requirement Reference**: Stage 3 Planning Gate G1.
- **Scope**: Convert `project-specs/dgii-ecf-0.7.0-upgrade-setup.md` into actionable
  tasks quoting exact requirements R1 through R5.
- **Producer**: Senior Project Manager (`senior-project-manager`)
- **Validator**: Agents Orchestrator (`agents-orchestrator`)
- **Success Criteria**: `project-tasks/dgii-ecf-0.7.0-upgrade-tasklist.md` exists,
  quotes requirements verbatim, adds no unauthorized scope, and establishes clean
  traceability.

---

### [x] T1: Dependency & Lockfile Upgrade (Requirement R1)

- **Requirement Reference**: Requirement R1: Dependency & Lockfile Upgrade
  > - Update `package.json` `peerDependencies["@deuriib/dgii-ecf"]` and
  >   `devDependencies["@deuriib/dgii-ecf"]` from `"^0.6.1"` to `"^0.7.0"`.
  > - Run `bun install` to update `bun.lock` to resolve `@deuriib/dgii-ecf@0.7.0`.
  > - Verify supply-chain hygiene: MIT license, no unexpected install scripts, and zero
  >   secret leaks (`mise run secrets`).
- **Files to Modify**: `package.json`, `bun.lock`
- **Producer**: DGII e-CF Expert (`dgii-e-cf-expert`)
- **Validator**: Evidence Collector (`evidence-collector`)
- **Verification Command**: `bun pm ls` and `mise run secrets`

---

### [x] T2: Error Classification, Ambiguous Submissions & Wire Detail Alignment (Requirement R2)

- **Requirement Reference**: Requirement R2: Error Classification, Ambiguous Submissions
  & Wire Detail Alignment
  > - Update `isDefiniteRejection(error: DgiiError)` in `src/errors.ts`:
  >   - `IDEMPOTENCY` must return `false` (`unconfirmed`) unless
  >     `error.cause instanceof DgiiError` and `isDefiniteRejection(error.cause)` is
  >     `true`. Both `PENDING_SUBMISSION_MESSAGE` and `AMBIGUOUS_SUBMISSION_MESSAGE`
  >     mean the submission is in flight or had an ambiguous transport outcome and must
  >     be reconciled rather than retried.
  >   - `VALIDATION` must return `false` (`unconfirmed`) when
  >     `error.message.includes('reconcile')` (the 2xx unreadable submission payload
  >     case in `@deuriib/dgii-ecf` 0.7.0), and `true` (`failed`) for pre-transmission
  >     validation errors.
  >   - `HTTP` must return `true` (`failed`) only for 4xx statuses excluding `408` and
  >     `429`
  >     (`error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429`),
  >     matching the documented contract in `docs/usage.md`.
  > - Handle `@deuriib/dgii-ecf` 0.7.0's `AMBIGUOUS_SUBMISSION_MESSAGE` wrapper
  >   (`error.code === 'IDEMPOTENCY'` with `error.cause instanceof DgiiError`):
  >   - When `ECF.submitIdempotent` wraps a statusless transport `DgiiError` (such as
  >     `TIMEOUT`, `CIRCUIT_OPEN`, or `UNKNOWN`) into an `IDEMPOTENCY` error with
  >     `cause: DgiiError`, unwrap or preserve the underlying `DgiiError` cause for
  >     status mapping (`toApiError`) and `errorCode` recording in `runSubmission` so
  >     callers and audit records still see `TIMEOUT` / `CIRCUIT_OPEN` / `UNKNOWN`
  >     (`502 BAD_GATEWAY`) with its `resource` and `method`, while a direct
  >     `PENDING_SUBMISSION_MESSAGE` (`code: 'IDEMPOTENCY'` without a transport `cause`)
  >     maps to `409 CONFLICT` (`errorCode: 'IDEMPOTENCY'`).
  > - Update `DgiiFailureDetail` and `toFailureDetail` in `src/errors.ts` to include
  >   `retryable: error.retryable` and `retryAfter: error.retryAfter` while continuing
  >   to strip `data` and `baseURL`.
  > - Add unit and integration tests in `test/error-mapping.test.ts` and
  >   `test/replay-state-machine.test.ts` covering:
  >   - `HTTP 408` and `HTTP 429` recorded as `unconfirmed`
  >   - `IDEMPOTENCY` (`PENDING_SUBMISSION_MESSAGE`) and `AMBIGUOUS_SUBMISSION_MESSAGE`
  >     (wrapping `TIMEOUT`) recorded as `unconfirmed`
  >   - Post-2xx `VALIDATION` (`Unexpected DGII response payload; reconcile...`)
  >     recorded as `unconfirmed`
  >   - `retryable` and `retryAfter` forwarded in `dgii` failure detail.
- **Files to Modify**: `src/errors.ts`, `src/endpoints/shared.ts`,
  `test/error-mapping.test.ts`, `test/replay-state-machine.test.ts`
- **Producer**: DGII e-CF Expert (`dgii-e-cf-expert`)
- **Validator**: Reliability Reviewer (`reliability-reviewer`)
- **Verification Command**:
  `bunx vitest run test/error-mapping.test.ts test/replay-state-machine.test.ts`

---

### [x] T3: Linear-Time XML Reader & Buyer-Delivery / Replay / Reconcile Alignment (Requirement R3)

- **Requirement Reference**: Requirement R3: Linear-Time XML Reader & Buyer-Delivery /
  Replay / Reconcile Alignment
  > - In `src/xml.ts`:
  >   - Replace the regex-based `elementPattern`
  >     (`<${prefix}${name}${ATTRIBUTE_SPAN}>([\\s\\S]*?)<\\/${prefix}${name}\\s*>`)
  >     with the `O(len(xml))` single-pass scanner (`readQualifiedName`, `localName`,
  >     `skipAttributes`, `findClosingTag`) operating on `withoutNonElementMarkup(xml)`.
  >   - Preserve all existing comment, processing-instruction, and DOCTYPE stripping
  >     guarantees.
  >   - Add a regression test in `test/xml.test.ts` verifying that an unclosed
  >     `<RNCEmisor>` or `<eNCF>` tag followed by 50 KiB of XML completes in under 50ms
  >     without catastrophic backtracking.
  > - In `src/buyer-delivery.ts`:
  >   - Harden `isHttpsUrl` / `assertBuyerDeliveryConfig` to reject URLs containing
  >     embedded credentials (`url.username !== '' || url.password !== ''`), empty
  >     hostnames, or whitespace (`/\s/.test(value)`), matching `@deuriib/dgii-ecf`
  >     0.7.0's `validateBuyerHost`.
  >   - Add tests in `test/buyer-delivery.test.ts` for embedded credentials and
  >     whitespace in `buyerDelivery.hosts`.
  > - In `src/persistence.ts`, `src/endpoints/shared.ts`, and
  >   `src/endpoints/documents.ts`:
  >   - Scope the replay key by buyer destination when `buyerHost` (or `buyer`) is used
  >     on `sendDocument`, `sendElectronicDocument`, and `sendCommercialApproval`, so
  >     sending a signed document to DGII and then sending the same signed document to a
  >     configured buyer host does not replay the DGII response from the database
  >     instead of delivering to the buyer.
  >   - In `POST /dgii-ecf/documents/reconcile` (`reconcileSubmission` in
  >     `src/endpoints/documents.ts`), accept optional
  >     `buyer: z.string().min(1).optional()` in a `z.strictObject` body, resolve
  >     `buyerHost` via `resolveBuyerHost(deps.options, ctx.body.buyer)`, forward
  >     `buyerHost` to `client.reconcileSubmission(ctx.body.xml, buyerHost)` when
  >     defined, and scope `store.reconcile` accordingly.
  >   - Add tests in `test/buyer-delivery.test.ts`, `test/endpoints.test.ts`, and
  >     `test/replay-state-machine.test.ts` proving:
  >     - Submitting to DGII and then delivering the same XML to `buyer: 'acme'`
  >       transmits both times and stores distinct replay keys.
  >     - `POST /dgii-ecf/documents/reconcile` with `buyer: 'acme'` forwards
  >       `'https://...'` to `client.reconcileSubmission(xml, buyerHost)`.
- **Files to Modify**: `src/xml.ts`, `src/buyer-delivery.ts`, `src/persistence.ts`,
  `src/endpoints/shared.ts`, `src/endpoints/documents.ts`, `test/xml.test.ts`,
  `test/buyer-delivery.test.ts`, `test/endpoints.test.ts`,
  `test/replay-state-machine.test.ts`
- **Producer**: DGII e-CF Expert (`dgii-e-cf-expert`)
- **Validator**: Security Reviewer (`security-reviewer`)
- **Verification Command**:
  `bunx vitest run test/xml.test.ts test/buyer-delivery.test.ts test/endpoints.test.ts test/replay-state-machine.test.ts`

---

### [x] T4: SDK Options & Public Exports Alignment (Requirement R4)

- **Requirement Reference**: Requirement R4: SDK Options & Public Exports Alignment
  > - In `src/types.ts`:
  >   - Add optional SDK pass-through options to `DgiiEcfOptions`:
  >     - `onEvent?: (event: EcfEvent) => void`
  >     - `resilience?: ResilienceOptions`
  >     - `validateBeforeSend?: boolean`
  >     - `xmllintBin?: string`
  >   - Re-export `EcfEvent`, `EcfEventType`, and `ResilienceOptions` from
  >     `src/types.ts` and `src/index.ts`.
  >   - Re-export `AMBIGUOUS_SUBMISSION_MESSAGE`, `PENDING_SUBMISSION_MESSAGE`, and
  >     `isSchemaUnavailableError` from `src/index.ts`.
  > - In `src/client-provider.ts`:
  >   - Forward `onEvent`, `resilience`, `validateBeforeSend`, and `xmllintBin` (when
  >     defined) to `new ECF(material, scope.environment, { ... })`.
  > - Add tests in `test/client-provider.test.ts` verifying that `onEvent`,
  >   `resilience`, `validateBeforeSend`, and `xmllintBin` are forwarded to the
  >   constructed `ECF` instance, and update `scripts/smoke.mjs` to assert the new
  >   re-exports.
- **Files to Modify**: `src/types.ts`, `src/index.ts`, `src/client-provider.ts`,
  `test/client-provider.test.ts`, `scripts/smoke.mjs`
- **Producer**: Backend Architect (`backend-architect`)
- **Validator**: Evidence Collector (`evidence-collector`)
- **Verification Command**:
  `bunx vitest run test/client-provider.test.ts && bun scripts/smoke.mjs`

---

### [x] T5: Documentation Synchronization (Requirement R5)

- **Requirement Reference**: Requirement R5: Documentation Synchronization & Full CI
  Gate
  > - Update `README.md` and `README.es.md` peer dependency references from
  >   `@deuriib/dgii-ecf@^0.6` to `@deuriib/dgii-ecf@^0.7`.
  > - Update `docs/usage.md`, `docs/architecture.md`, and `docs/security.md` to reflect:
  >   - Updated error classification table (`IDEMPOTENCY`, `HTTP` 408/429, and post-2xx
  >     `VALIDATION` recorded as `unconfirmed`; `retryable` and `retryAfter` in error
  >     details).
  >   - Buyer-scoped replay keys and `buyer` option on `/dgii-ecf/documents/reconcile`.
  >   - New `DgiiEcfOptions` fields (`onEvent`, `resilience`, `validateBeforeSend`,
  >     `xmllintBin`).
- **Files to Modify**: `README.md`, `README.es.md`, `docs/usage.md`,
  `docs/architecture.md`, `docs/security.md`
- **Producer**: Technical Writer (`technical-writer`)
- **Validator**: Evidence Collector (`evidence-collector`)
- **Verification Command**: `git diff --stat docs/ README.md README.es.md` and doc
  consistency checks

---

### [x] G4: Final Integration & Reality Check Gate

- **Requirement Reference**: Final Reality Checker Gate per NEXUS Software
  Specialization
- **Scope**: Run full CI test suite, coverage check (90% branches, 90% functions, 85%
  lines, 90% statements), package pack check (`publint` + `attw`), smoke test, and
  secrets scan.
- **Producers**: All Producers
- **Validators**: Code Reviewer (`code-reviewer`) + Security Reviewer
  (`security-reviewer`) + Evidence Collector (`evidence-collector`)
- **Verification Command**: `mise run ci && mise run smoke && mise run secrets`
- **Verdict**: PASS. 217/217 tests passing, 95.76% statement coverage, 0 type errors,
  clean pack-check (`publint` & `attw`), smoke ok on Node 24, 0 secret leaks found.
