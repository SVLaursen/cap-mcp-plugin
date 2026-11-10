# Backlog

Work top to bottom. One task per commit. Each task names the test file whose `test.todo` it
turns into a real test. Tick `[x]` when the task meets the definition of done in CLAUDE.md.

**SPIKE** tasks produce an ADR in `docs/adr/` (and new backlog tasks), not production code.

## M0 — Development environment ✅

- [x] Repo scaffold: TypeScript, Jest projects (contract, behaviour), ESLint rules, Prettier
- [x] Demo bookshop with a target for every v2 feature (`demo/README.md`)
- [x] Test helpers: CDS snippet compiler, `cds.test` boot + users, raw JSON-RPC helper
- [x] Baseline tests proving CAP behaviour in the demo (`test/behaviour/demo-baseline.test.ts`)
- [x] Module stubs with contracts; backlog of `test.todo` per milestone
- [x] CLAUDE.md, docs, ADRs 0001–0008, skills, CI

## M1 — Model reader and schema mapper (pure) ✅

Fast loop: `npm run test:contract`.

- [x] Decide doc comment handling: does the plugin set `cdsc.docs` via its `package.json` `cds` section? Test both paths. → no, ADR 0011 _(`model-reader.test.ts`)_
- [x] Opt-in rules: empty model, service baseline, functions vs. actions, single-entity opt-in, `@mcp: false`, `@cds.api.ignore` _(`model-reader.test.ts` › opt-in)_
- [x] `@mcp.omit` never reaches FieldSpecs _(opt-in)_
- [x] Write modes, resource, prompts, ui, elicit, completion, describe, compact, deepInsert, draft flags _(opt-in)_
- [x] Names and descriptions fallback chain _(names and descriptions)_
- [x] Field shapes: keys, mandatory, readonly, enum, length/precision/scale, range, FK targets, `Entity:element` params _(field shapes)_
- [x] Diagnostics: unknown keys, v1 annotations, bound op without keys, `@mcp.omit` on a key (warn); demo reads with zero errors _(diagnostics)_
- [x] Schema mapper: scalar types _(`schema-mapper.test.ts` › scalar types)_
- [x] Schema mapper: tool input schemas per mode and for operations _(input)_
- [x] Schema mapper: output schemas _(output)_
- [x] Review: run the `reviewer` agent on M1 (findings fixed in the `M1 review:` commits)

## M2 — Exposure registry ✅

- [x] Tool names, deterministic order, read-only/destructive hints _(`exposure-registry.test.ts` › tool list)_
- [x] Describe tool scoped to its service; compact tool set; `@mcp.ui` metadata _(tool list)_
- [x] Per-user filtering by `@requires` only; `@restrict where` never hides tools _(per-user)_
- [x] Cache per model object _(caching)_
- [x] Review: run the `reviewer` agent on M2 (findings fixed in the `M2 review:` commits)

## M3 — Executor on CAP

From here, tests run against the demo (`npm run test:behaviour`). Until M4 lands, drive the
executor directly inside `cds.test` (call it with `cds.services.X` within a
`cds.tx({ user }, …)`), then switch the same tests to `/mcp` in M4.

- [x] Reads: query `{ rows, total, nextCursor }`, paging, count, where/orderby/select limits, `q` via `SELECT.search`, `get` NOT_FOUND, one text block _(`executor.test.ts` › reads)_
- [x] Describe tools (`<Service>_describe`, compact `list_entities` / `describe_entity`) scoped to what the caller can reach _(`executor-describe.test.ts`)_; regression #3
- [x] Regression #2, #6 _(`v1-findings.test.ts`)_
- [x] Writes through the service; custom handlers run; mode gating _(`executor-writes.test.ts`)_
- [x] Regression #1 (failed commit), #5 (same user context) _(`v1-findings.test.ts`)_
- [x] Operations: functions, actions, bound actions; structured CAP errors _(`executor-operations.test.ts`)_
- [x] Drafts and deep insert _(`executor-drafts.test.ts`)_
- [x] Authorization is CAP's: MCP rows equal OData rows per user _(authorization)_
- [ ] Review: run the `reviewer` agent on M3

## M4 — Adapter (MCP 2026-07-28, stateless)

- [ ] **SPIKE**: mount as a CAP protocol adapter (`cds.env.protocols`, see `node_modules/@sap/cds/lib/srv/protocols/`) vs. one `/mcp` route behind `cds.middlewares.before`. One endpoint for all services or one per service? → ADR 0009 _(`protocol.test.ts` › mounting)_
- [ ] **SPIKE**: support for 2025-11-25 clients (initialize handshake) — does SDK v2 serve both? → ADR 0010 _(older clients)_
- [ ] Verify `_meta` keys and `Mcp-Method` header against the spec and SDK; fix `test/helpers/mcp.ts` once
- [ ] Stateless tools/list and tools/call; `server/discover`; version errors; `resultType`; `ttlMs`/`cacheScope` _(stateless)_
- [ ] Switch M3 executor tests to go through `/mcp`; delete the placeholder test in `demo-baseline.test.ts`
- [ ] Regression #3 (describe never leaks), #4 (no session state) _(`v1-findings.test.ts`)_
- [ ] Auth metadata: 401 + `WWW-Authenticate`, RFC 9728 endpoint, no fake DCR _(auth metadata)_
- [ ] `cds.context.user` is the caller; AMS middleware applies without special code _(mounting)_
- [ ] `activate()` leaves `cds.env.cdsc` untouched (ADR 0011) _(mounting)_
- [ ] Production default: CAP requires `authenticated-user` on services without `@requires` (`restrict_all_services`); make `tools/list` for anonymous callers agree (or always authenticate `/mcp`) _(mounting)_
- [ ] Auth matrix: mocked _(`auth-matrix.test.ts`)_
- [ ] Review: run the `reviewer` agent on M4

## M5 — Opt-in features

- [ ] Baseline exposure matches the demo exactly; `@mcp: false`, `@cds.api.ignore` _(`opt-in-features.test.ts` › baseline)_
- [ ] Describe and compact _(describe and compact)_
- [ ] Resources as single records + `resource_link` _(resources)_
- [ ] Prompts with role visibility _(prompts)_
- [ ] MCP Apps via `@modelcontextprotocol/ext-apps` (issue #133), incl. custom registration hook _(MCP Apps)_
- [ ] Confirmation via MRTR `input_required` _(confirmation)_
- [ ] Completion _(completion)_
- [ ] Auth matrix: XSUAA/IAS × secret/certificate, IAS-only + AMS _(`auth-matrix.test.ts`)_
- [ ] Review: run the `reviewer` agent on M5

## M6 — Developer experience and v1 compatibility

- [ ] Startup exposure report and diagnostics output (`cli`)
- [ ] Startup report groups a diagnostic that CAP propagated to several projections (one typo in a db entity is reported once per projection today)
- [ ] Startup report: say when an exposed definition has a doc comment in the source but `cdsc.docs` is off, and how to turn it on (ADR 0011)
- [ ] `cds add mcp` facet
- [ ] `cds mcp` stdio entry point
- [ ] Config keys finalised in `docs/annotations.md` (camelCase, via `cds.env` only)
- [ ] v1 shim: map v1 annotations and config, emit `V1_ANNOTATION` / `V1_DEFAULT_CHANGED`
- [ ] Characterisation: v1 demo annotations produce equivalent v2 tools (compatibility checklist)
- [ ] User docs: "expose a service in 5 minutes", "lock it down for production", "debug a missing tool"

## M7 — Release 2.0

- [ ] MCP conformance suite in CI (`@modelcontextprotocol/conformance`)
- [ ] Coverage thresholds met (`jest.config.js`)
- [ ] Release workflow (port v1's release-it + trusted publishing)
- [ ] Publish `2.0.0`

## 2.x (P1) and later (P2)

Multitenancy and extensibility · structured errors polish · OpenTelemetry and audit logging ·
long-running actions (tasks extension) · `subscriptions/listen` · binary resources ·
file-based prompts · row and call budgets · entities with parameters (`entity P(p: Integer)`; exposed today without a way to pass `p`). Add tasks here when 2.0 is out.
