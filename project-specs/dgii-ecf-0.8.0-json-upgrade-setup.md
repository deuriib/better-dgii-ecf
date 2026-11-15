# DGII e-CF v0.8.0 JSON Invoice Methods Pipeline Setup

## Executive Summary

Upgrade `@deuriib/dgii-ecf` from `^0.7.0` to `^0.8.0`, integrating the newly introduced
JSON invoice transformation and rounding capabilities (`Transformer.json2xml`,
`Transformer.xml2json`) directly into the `@deuriib/better-dgii-ecf` server and client
workflows.

## Objectives

1. **R1: Dependency & Lockfile**: Upgrade `@deuriib/dgii-ecf` to `^0.8.0` in
   `package.json` (`peerDependencies` and `devDependencies`) and sync `bun.lock`.
2. **R2: JSON Document Support in Endpoints**:
   - Allow document submission endpoints (`/dgii-ecf/documents`,
     `/dgii-ecf/documents/electronic`, `/dgii-ecf/documents/summary`,
     `/dgii-ecf/documents/commercial-approval`, `/dgii-ecf/documents/void-range`) and
     reconcile endpoint (`/dgii-ecf/documents/reconcile`) to accept either `xml: string`
     OR `json: object | string` (with an optional `round?: boolean` flag defaulting to
     `true` for monetary decimal round-half-up).
   - In `resolveDocumentXml`, if `json` is provided, automatically convert to XML using
     `Transformer.json2xml(json, round ?? true)`. If conversion fails, return a
     formatted `400 BAD_REQUEST` with clear error details.
   - When `sign: true` is provided with `json`, the transformed XML is signed with the
     organization's PKCS#12 credentials.
3. **R3: Transformer Re-export & Utilities**:
   - Re-export `Transformer` in `src/index.ts` so library consumers can convert and
     round JSON documents directly without installing extra dependencies.
4. **R4: Comprehensive Testing**:
   - Unit tests covering JSON invoice submission with and without `sign: true`.
   - Unit tests validating `round: true` (ROUND_HALF_UP) vs `round: false`.
   - Unit tests checking error handling when malformed JSON is supplied.
   - Replay state machine and reconcile tests with JSON input.
   - Smoke tests on Node 24 checking JSON-to-XML transmission flow.
5. **R5: Documentation Synchronization**:
   - Update `README.md`, `README.es.md`, `docs/usage.md`, and `docs/architecture.md`
     with JSON invoice usage examples (`json` payload, `round: true/false`,
     `sign: true`).

## Verification Gates

- G1: `bun pm ls` reports `@deuriib/dgii-ecf@0.8.0`.
- G2: `tsc --noEmit` clean.
- G3: `vitest run --coverage` all tests pass, >=95% coverage.
- G4: `publint` and `attw` clean.
- G5: `mise run smoke` on Node 24 passes.
- G6: `mise run secrets` clean.
