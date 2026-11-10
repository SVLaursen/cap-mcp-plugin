# 0005 — No `global.cds`; dependencies are passed in

Status: accepted · 2026-11-10

## Context

v1 modules did `const cds = global.cds || require("@sap/cds")` and read `(global as any).cds`
again at call time. Tests then mocked `@sap/cds` while the code read the global, so 43 tests
failed on a clean run depending on setup order. The singleton plugin class made it worse.

## Decision

`cds-plugin.js` passes the host app's `cds` to `activate(cds)`. Modules receive what they need
as parameters (a model, a user, a service) typed by the structural interfaces in
`src/types.ts` and next to each module. ESLint forbids `global.cds`.

## Consequences

- Pure modules (model reader, schema mapper, registry) need no CAP runtime to test.
- No singletons; each `activate` call is independent.
