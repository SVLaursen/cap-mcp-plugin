# CLAUDE.md — @gavdi/cap-mcp v2

This repo is the v2 rewrite of the SAP CAP MCP plugin. v1 lives in
[gavdilabs/cap-mcp-plugin](https://github.com/gavdilabs/cap-mcp-plugin) and stays in maintenance
(security fixes only) after 1.9. v2 is built here, test-first, milestone by milestone.

Read these before your first change, in this order:

1. `docs/plan.md` — why v2 exists and what it must do (the review and roadmap, condensed).
2. `docs/architecture.md` — the modules, the request path, and what CAP does vs. what we do.
3. `docs/annotations.md` — the v2 annotation language. This is the user-facing contract.
4. `docs/backlog.md` — milestones and tasks. This is where work comes from.
5. `docs/testing.md` — how to write each kind of test here.
6. `docs/adr/` — decisions already made. Do not relitigate them silently; propose a new ADR.

## Rules that are not up for negotiation

1. **Everything is opt-in.** Nothing appears over MCP unless an annotation asks for it, and no
   config default switches a feature on. `@mcp` on a service gives only the read-only baseline
   (query + get for entities, plus functions). See ADR 0004.
2. **CAP does the work.** Every data access goes through `srv.run(cqn)` / `srv.send(...)` inside
   the request's `cds.context`. No manual transactions, no swallowed commit errors, no raw DB
   access, no string-built CQN, no re-implemented authorization. See ADR 0003.
3. **No globals.** Never read `global.cds`. `activate(cds)` receives `cds`; pass what a module
   needs as a parameter. ESLint enforces this. See ADR 0005.
4. **Test first, always.** Turn a `test.todo` into a real test, watch it fail for the right
   reason, make it pass with the least code, then refactor. Never write implementation without
   a failing test that demands it. See `.claude/skills/tdd/SKILL.md`.
5. **Never mock `@sap/cds`.** Contract tests compile CDS snippets (`test/helpers/snippet.ts`).
   Behaviour tests boot the demo app with `cds.test` (`test/helpers/demo.ts`). ESLint enforces
   the ban on `jest.mock("@sap/cds")`. See ADR 0007.
6. **The demo app is the fixture.** If a feature has no target in `demo/`, add the CDS
   annotation (and data, if needed) and a row in `demo/README.md` before writing the test.
7. **`src/types.ts` is the contract between modules.** Change it deliberately, in the same
   commit as the tests that need the change, and update `docs/architecture.md`.
8. **No new runtime dependency without an ADR.** Dev dependencies are fine.

## Commands

```bash
npm test                  # all tests (contract + behaviour), ~2 s today
npm run test:contract     # pure tests over CDS snippets — the fast loop for M1/M2
npm run test:behaviour    # cds.test against the demo app — M3 onwards
npx jest path/to/file     # one file
npm run typecheck         # tsc --noEmit (src + test)
npm run lint              # eslint (includes the no-global-cds / no-cds-mock rules)
npm run format:fix        # prettier
npm run check             # typecheck + lint + test: run before every commit
npm run build             # compile src/ to lib/ (cds-plugin.js loads lib/ outside Jest)
npm run demo              # cds watch on the demo app at http://localhost:4004
npm run inspect           # MCP Inspector, once the adapter exists (M4)
```

Demo users (mocked auth): `alice/alice` (admin), `bob/bob` (no roles), `carol/carol` (support).

## Layout

```
src/
  index.ts              activate(cds): wires the plugin into CAP (placeholder until M4)
  types.ts              ExposureSpec, EntitySpec, ToolSpec, … — the module contract
  model-reader/         M1  CSN + @mcp → ExposureSpec (pure)
  schema-mapper/        M1  FieldSpec → JSON Schema 2020-12 (pure)
  exposure-registry/    M2  ExposureSpec → ToolSpec[], per-user filtering, caching
  executor/             M3  tool call → CQN → srv.run/send → ToolResult
  adapter/              M4  MCP protocol edge (SDK v2, stateless, auth metadata)
  cli/                  M6  cds add mcp, cds mcp (stdio), startup report
test/
  helpers/              snippet.ts (compile CDS), demo.ts (cds.test + users), mcp.ts (JSON-RPC)
  contract/             M1–M2 pure tests
  behaviour/            M3–M5 end-to-end against the demo app
  regression/           one test per v1 finding
  auth/                 auth parity matrix (v1.9 PR #163)
demo/                   bookshop app; every v2 feature has an annotated target (demo/README.md)
docs/                   plan, architecture, annotation spec, backlog, testing, ADRs, spec notes
```

## How to work through the backlog

- Use the `next-task` skill: it picks the first open task in the current milestone of
  `docs/backlog.md`, runs the TDD loop, ticks the task, and commits.
- One task per commit. Commit message: `M<n>: <task>` plus why, if it is not obvious.
- Finish a milestone before starting the next, except tasks marked _(parallel)_.
- Tasks marked **SPIKE** produce an ADR, not code. Write the ADR, then add the tasks it implies
  to the backlog.
- When a milestone is done, run the `reviewer` agent on the milestone's diff and fix what it
  finds before moving on.

## Definition of done (every task)

- [ ] The test that demanded the change exists, failed first, and passes now.
- [ ] `npm run check` is green.
- [ ] No `test.todo` you converted is left behind as a duplicate.
- [ ] Docs touched if behaviour, annotations or module contracts changed.
- [ ] The backlog task is ticked.

## Things learned while setting up (save yourself the detour)

- **Doc comments** reach CSN only with `cds.env.cdsc.docs = true` (the demo sets it; the
  snippet helper passes `{ docs: true }` unless told `{ docs: false }`). The plugin does not set
  it for the app (ADR 0011).
- **MCP SDK v2** is split into packages: `@modelcontextprotocol/server`, `/client`, `/node`
  (Node HTTP transport), `/express`, `/core`, plus `@modelcontextprotocol/ext-apps` for MCP
  Apps. All ship CommonJS builds, so `require` works. v2 implements the 2026-07-28 spec; the old
  `@modelcontextprotocol/sdk` 1.x stays on 2025-11-25.
- **CAP protocol adapters** are configurable through `cds.env.protocols` and are mounted with
  CAP's own `before` middlewares (auth, context). See
  `node_modules/@sap/cds/lib/srv/protocols/index.js`. This is the M4 mounting spike.
- **`cds.test`** gives each test file its own in-memory SQLite database, so writes do not leak
  between files. Inside one file, order matters.
- **Failed commits**: the demo's `AdminService` makes `DELETE /Books(207)` fail at commit time
  via `req.before('commit')`. Use it for regression #1.
- **Key-addressed writes need `req.data`**: `srv.run(DELETE/UPDATE …)` leaves `req.data` empty,
  even with the key as a ref filter, so handlers checking `req.data.ID` silently skip (the demo's
  failed-commit hook did). Use `srv.send({ query, data: key })` like OData does. A missing record
  then comes back as CAP's own 404.
- **Draft reads add columns**: SELECT on a draft-enabled entity returns `IsActiveEntity` and the
  keys even when not selected; project rows to what was asked for.
- **`@restrict where`** already works over OData in the demo (bob sees only ORD-1001). MCP tests
  should assert "same rows as OData", not re-derive the rule.

## Reference material outside this repo

- v1 source: clone `gavdilabs/cap-mcp-plugin` next to this repo (`../cap-mcp-plugin`) to read
  how v1 did something. Port behaviour through tests, never by copying files.
  `docs/v1-reference.md` maps v1 files to v2 modules and lists what not to carry over.
- MCP spec 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- CAP docs: https://cap.cloud.sap/docs/
