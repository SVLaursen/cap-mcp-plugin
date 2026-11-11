---
name: tdd
description: The red-green-refactor loop for this repo. Use for every code change in src/, including bug fixes, before writing any implementation.
---

# TDD loop

Never write implementation code that no failing test demands.

## 1. Pick the behaviour

- Find the `test.todo` that describes it (`docs/backlog.md` names the file).
- No todo for it? Add one to the right file first, then continue. If it is a new feature,
  check `docs/annotations.md` and ADR 0004 (opt-in) before adding it.
- Behaviour test? Make sure the demo has a target (`demo/README.md`). If not, add the CDS
  annotation/data/handler and the README row first, and run `npx jest test/behaviour/demo-baseline`
  to prove the demo still boots.

## 2. Red

- Replace the `test.todo(...)` with a real `test(...)`. Keep its name; tighten it if needed.
- Contract test: compile a minimal snippet with `compileSnippet` and assert on the whole relevant
  output (`toEqual`). Behaviour test: use `bootDemo()`, `as(user)`, `rpc`/`callTool`.
- Run only that file: `npx jest path/to/file -t "<test name>"`.
- It must fail **for the right reason**: an assertion about the behaviour. A typo, import error or crashing helper is not red;
  fix it and re-run.

## 3. Green

- Write the least code in `src/` that makes the test pass. Hard-coding is fine if the next test
  will force generalisation.
- Respect the rules in CLAUDE.md: no `global.cds`, CAP does the work, opt-in only.
- Re-run the file until green, then `npm test` to make sure nothing else broke.

## 4. Refactor

- With everything green, remove duplication and improve names in both code and test.
- Keep modules within their responsibility (docs/architecture.md). If a change crosses a
  module boundary, it probably belongs in `src/types.ts` first, with its own test.
- `npm run check` must be green.

## 5. Record

- Tick the backlog task if this completes it.
- Commit: `M<n>: <task>`; mention the behaviour, not the code.

## Smells that mean stop and rethink

- You want to `jest.mock` something from CAP → use a snippet or `cds.test` instead.
- You are writing a transaction, a role check or a string CQN expression → CAP should do it.
- The test needs many setup lines → the unit under test is doing too much; split it.
- You changed a test's expectation to make it pass → was the test or the code wrong? Say which
  in the commit message.
