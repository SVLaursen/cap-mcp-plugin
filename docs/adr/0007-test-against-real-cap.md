# 0007 — Test against real CAP; never mock `@sap/cds`

Status: accepted · 2026-11-10

## Context

v1's 900+ tests ran against a hand-built fake of CAP (`mockCdsEnvironment`, a stub
`global.cds`, hand-written CSN). The fake agreed with the code, so the bugs in
docs/v1-reference.md passed every test.

## Decision

- Contract tests compile real CDS snippets with `cds.compile` (`test/helpers/snippet.ts`).
- Behaviour tests boot the demo app with `cds.test` (SQLite in memory, mocked auth).
- `jest.mock("@sap/cds")` is banned by ESLint. Third-party auth libraries are exercised with
  local token issuers, not stubs (docs/testing.md).
- Development is test-first: every behaviour starts as a failing test.

## Consequences

- Tests prove behaviour CAP users will see, including CAP's own enforcement.
- Behaviour tests are slower than mocks (milliseconds after a ~1 s boot per file), so pure
  logic stays in contract tests.
