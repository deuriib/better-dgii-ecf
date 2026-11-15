# DGII e-CF v0.8.0 JSON Invoice Methods Task List

- [x] ### [x] Task 1: Dependency Upgrade & Verification (R1)
  - [x] Upgrade `@deuriib/dgii-ecf` in `package.json` to `^0.8.0` (`peerDependencies` &
        `devDependencies`).
  - [x] Run `bun install` to update `bun.lock`.
  - [x] Verify clean resolution with `bun pm ls`.
  - Producer: Developer / Stack Specialist
  - Validator: Evidence Collector (Verified package.json, bun.lock, bun pm ls)

- [x] ### [x] Task 2: Core JSON Transformation & Document Endpoints Integration (R2 &
      R3)
  - [x] Implement
        `resolveDocumentXml(body: { xml?: string; json?: object | string; round?: boolean })`
        helper in `src/endpoints/shared.ts`.
  - [x] Support both `xml` and `json` in `documentShape` Zod validation schema across
        endpoints.
  - [x] Update endpoints (`/dgii-ecf/documents`, `/dgii-ecf/documents/electronic`,
        `/dgii-ecf/documents/summary`, `/dgii-ecf/documents/commercial-approval`,
        `/dgii-ecf/documents/void-range`, `/dgii-ecf/documents/reconcile`).
  - [x] Re-export `Transformer` from `@deuriib/dgii-ecf` in `src/index.ts`.
  - Producer: Backend Architect / Senior Developer
  - Validator: Code Reviewer & API Tester

- [x] ### [x] Task 3: Unit & Integration Tests for JSON Invoices (R4)
  - [x] Add tests in `test/document-validation.test.ts` for JSON payload submissions.
  - [x] Test JSON with `sign: true` in `test/credentials-mode.test.ts`.
  - [x] Test `round: true` (monetary rounding) vs `round: false`.
  - [x] Test rejection on malformed JSON (`DGII_JSON_TRANSFORMATION_FAILED`).
  - [x] Test reconcile with JSON input in `test/endpoints.test.ts`.
  - [x] Update `scripts/smoke.mjs` to exercise JSON conversion and transmission.
  - Producer: Test Automation Engineer
  - Validator: Evidence Collector (Test run & coverage report: 224/224 passed)

- [x] ### [x] Task 4: Documentation Synchronization (R5)
  - [x] Update `README.md` and `README.es.md` with JSON invoice example.
  - [x] Update `docs/usage.md` with "Working with JSON invoices" guide.
  - [x] Update `docs/architecture.md` describing the JSON-to-XML pipeline stage.
  - Producer: Technical Writer
  - Validator: Brand Guardian & Evidence Collector

- [x] ### [x] Task 5: Final Quality Gate (G1–G6)
  - [x] Run `mise run ci` (lint-format, lint-types, vitest coverage: 95.92% stmts,
        pack-check: publint/attw).
  - [x] Run `mise run smoke` on Node 24.
  - [x] Run `mise run secrets` (gitleaks 0 leaks).
  - Producer: Orchestrator / Evidence Collector
  - Validator: Reality Checker
