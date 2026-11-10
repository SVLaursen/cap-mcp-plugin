---
name: cap-check
description: Check a change for CAP-native and opt-in compliance before committing. Use on any diff touching src/ or demo/.
---

# CAP and opt-in checklist

Run `git diff` (or the given range) and go through each item. Report findings with file:line.

## CAP does the work (ADR 0003)

- [ ] Data access only via `srv.run(cqn)` / `srv.send(...)`; no `cds.db`, no `cds.tx(...)` /
      `srv.tx(...)` opened by the plugin, no `.commit()` / `.rollback()`.
- [ ] CQN built as objects (`SELECT.from(...).where({ ... })`, `{ ref }`, `{ val }`), never via
      template strings or `cds.parse.expr` on user input.
- [ ] Search via `SELECT.search(q)`.
- [ ] No role checks deciding access (`user.is(...)` only to hide tools in the registry).
- [ ] No timeouts that race CAP work without cancelling it.
- [ ] CAP error `code`, `target`, `args`/`details` preserved in tool errors.

## Opt-in (ADR 0004)

- [ ] Nothing new is exposed without an annotation, and there is a test proving its absence
      without that annotation.
- [ ] No config default turns a feature on.
- [ ] `@mcp.omit` fields cannot be selected, filtered, searched, ordered by, returned or described.

## Hygiene (ADR 0005, 0007)

- [ ] No `global.cds`, no singletons, no module-level mutable state.
- [ ] No `jest.mock("@sap/cds")`; behaviour tests use `cds.test`.
- [ ] No `any` / `@ts-ignore`; casts are narrow and commented.
- [ ] New runtime dependencies have an ADR.
- [ ] `src/types.ts` changes are reflected in `docs/architecture.md`.
