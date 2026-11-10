---
name: cap-check
description: Check a change for CAP-native and opt-in compliance before committing. Use on any diff touching src/ or demo/.
---

# CAP and opt-in checklist

Run `git diff` (or the given range) and go through each item. Report findings with file:line.

## CAP does the work (ADR 0003)

- [ ] Data access only via `srv.run(cqn)` / `srv.send(...)`; no `cds.db`, no `cds.tx(...)`, no
      `.commit()` / `.rollback()`. The one exception: the adapter runs each `tools/call` in the
      service's own root transaction, `srv.tx(fn)` (as CAP's protocol adapters do), and maps
      errors only after it has rolled back.
- [ ] CQN built as objects (`SELECT.from(...).where({ ... })`, `{ ref }`, `{ val }`), never via
      template strings or `cds.parse.expr` on user input.
- [ ] Search via `SELECT.search(q)`.
- [ ] No role checks deciding access (`user.is(...)` only to hide tools in the registry). The
      one exception: `/mcp` applies CAP's production default itself (`requireUser`, mirroring
      `restrict_all_services`, ADR 0009), because it lives only in CAP's protocol adapters.
- [ ] No timeouts that race CAP work without cancelling it.
- [ ] CAP error `code`, `target`, `args`/`details` preserved in tool errors, and messages
      translated as over OData (`cds.i18n.messages`, the caller's locale).

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
