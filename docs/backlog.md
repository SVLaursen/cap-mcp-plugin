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

## M3 — Executor on CAP ✅

From here, tests run against the demo (`npm run test:behaviour`). Since M4 they call tools over
`/mcp` (`test/helpers/tools.ts`); `executeDirectly` runs the executor for what `/mcp` cannot do
(yet): unlisted tools, confirmed calls.

- [x] Reads: query `{ rows, total, nextCursor }`, paging, count, where/orderby/select limits, `q` via `SELECT.search`, `get` NOT_FOUND, one text block _(`executor.test.ts` › reads)_
- [x] Describe tools (`<Service>_describe`, compact `list_entities` / `describe_entity`) scoped to what the caller can reach _(`executor-describe.test.ts`)_; regression #3
- [x] Regression #2, #6 _(`v1-findings.test.ts`)_
- [x] Writes through the service; custom handlers run; mode gating _(`executor-writes.test.ts`)_
- [x] Regression #1 (failed commit), #5 (same user context) _(`v1-findings.test.ts`)_
- [x] Operations: functions, actions, bound actions; structured CAP errors _(`executor-operations.test.ts`)_
- [x] Drafts and deep insert _(`executor-drafts.test.ts`)_
- [x] Authorization is CAP's: MCP rows equal OData rows per user _(authorization)_
- [x] Review: run the `reviewer` agent on M3 (findings fixed in the `M3 review:` commits)

## M4 — Adapter (MCP 2026-07-28, stateless)

- [x] **SPIKE**: mount as a CAP protocol adapter (`cds.env.protocols`, see `node_modules/@sap/cds/lib/srv/protocols/`) vs. one `/mcp` route behind `cds.middlewares.before`. One endpoint for all services or one per service? → ADR 0009: one `/mcp` route on `served` behind `cds.middlewares.before`, one endpoint for all services _(`protocol.test.ts` › mounting)_
- [x] **SPIKE**: support for 2025-11-25 clients (initialize handshake) — does SDK v2 serve both? → ADR 0010: `createMcpHandler` with `legacy: 'stateless'` _(older clients)_
- [x] Fix `test/helpers/mcp.ts` to what the SDK requires: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers; `clientCapabilities`/`clientInfo` in `_meta`; a legacy helper that parses SSE (ADR 0010)
- [x] `activate(cds)`: mount `/mcp` on `served` behind `cds.middlewares.before` + `express.json()`; handler = `toNodeHandler(createMcpHandler(factory))`; factory from the registry for `cds.context.user`, keyed by `cds.context.model ?? cds.model`; advertise only implemented capabilities (ADR 0009, 0010) _(mounting)_
- [x] `@mcp` services keep their OData endpoints (guard against a protocol named `mcp`) _(mounting)_
- [x] Stateless tools/list and tools/call; `server/discover`; version errors; `resultType`; `ttlMs`/`cacheScope` _(stateless)_
- [x] Switch M3 executor tests to go through `/mcp`; delete the placeholder test in `demo-baseline.test.ts`
- [x] Regression #3 (describe never leaks), #4 (no session state) _(`v1-findings.test.ts`)_
- [x] Auth metadata: own 401 on `/mcp` (Bearer `resource_metadata` for JWT/IAS, `req._login` for mocked), `/.well-known/oauth-protected-resource/mcp` at the root, no fake DCR _(auth metadata; `protocol-auth.test.ts` boots the demo with a stub XSUAA binding)_
- [x] `cds.context.user` is the caller; AMS middleware applies without special code _(mounting)_
- [x] `activate()` leaves `cds.env.cdsc` untouched (ADR 0011) _(mounting)_
- [x] Production default: CAP requires `authenticated-user` on services without `@requires` (`restrict_all_services`); make `tools/list` for anonymous callers agree (or always authenticate `/mcp`) _(mounting)_
- [x] Legacy era: `initialize` → `tools/list` / `tools/call` without a session; GET → 405; `@mcp.elicit` tools give a clear `isError` _(older clients)_
- [x] Auth matrix: mocked _(`auth-matrix.test.ts`)_
- [x] Review: run the `reviewer` agent on M4 (findings fixed in the `M4 review:` commits)

## M5 — Opt-in features

- [x] Baseline exposure matches the demo exactly; `@mcp: false`, `@cds.api.ignore` _(`opt-in-features.test.ts` › baseline)_
- [x] Describe and compact _(describe and compact)_
- [x] Resources as single records + `resource_link` _(resources)_
- [x] Prompts with role visibility _(prompts)_
- [x] MCP Apps (issue #133), incl. custom registration hook; no runtime dependency on `@modelcontextprotocol/ext-apps` (ADR 0012) _(MCP Apps)_
- [x] Confirmation via MRTR `input_required` _(confirmation)_
- [x] Completion: `@mcp.completion` completes `@mcp.resource` key templates; MCP has no tool-argument completion, so parameters get a diagnostic _(completion)_
- [x] Auth matrix: XSUAA/IAS × secret/certificate, IAS-only + AMS _(`auth-matrix.test.ts`; the AMS row adds roles the way AMS's middleware does, without `@sap/ams` policy evaluation, which needs `@sap/ams-dev`)_
- [x] Multitenant XSUAA: opt-in `cds.env.mcp.tenantHostPattern` maps the request host to the subscriber's authorization server (`https://<subdomain>.<uaadomain>`); without it, or without a match, the metadata names `credentials.url` (M4 review)
- [x] Review: run the `reviewer` agent on M5 (fixed: confirmation bound to the call via `requestState`, no internal error text outside tools/call, real tests for UI visibility and completion absence, key cast and no wrong `total` in completion, elicit form fields only, empty `@mcp.elicit`, no-store auth metadata, prompt rendering, symlinks; left as accepted in ADR 0012: UI links for clients without MCP Apps support)

## M6 — Developer experience and v1 compatibility

- [x] Startup exposure report and diagnostics output (`cli`)
- [x] Startup report groups a diagnostic that CAP propagated to several projections (one typo in a db entity is reported once per projection today)
- [x] Startup report: say when an exposed definition has a doc comment in the source but `cdsc.docs` is off, and how to turn it on (ADR 0011)
- [x] `cds add mcp` facet
- [x] `cds mcp` stdio entry point: not built (maintainer decision). Documented instead: `cds watch` plus a bridge such as `mcp-remote` (docs/guide/getting-started.md). Rule for any future stdio entry point: anonymous by default, `--user <id>` only from `cds.requires.auth.users` with mocked/basic auth, refused in production (docs/architecture.md, stdio)
- [x] Config keys finalised in `docs/annotations.md` (camelCase, via `cds.env` only)
- [x] `cds build` copies the `instructions` file into the deployed app (v1 parity, `docs/v1-reference.md`)
- [x] v1 shim: map v1 annotations and config, emit `V1_ANNOTATION` / `V1_DEFAULT_CHANGED`
- [x] Characterisation: v1 demo annotations produce equivalent v2 tools (compatibility checklist)
- [x] User docs: "expose a service in 5 minutes", "lock it down for production", "debug a missing tool"
- [x] Review: run the `reviewer` agent on M6

## M7 — Release 2.0

- [x] MCP conformance suite in CI (`@modelcontextprotocol/conformance`): `npm run conformance` boots the demo and runs every server scenario; `conformance-baseline.yml` lists the ones that need the suite's own fixtures or features v2 does not offer. Fixed what it found: DNS rebinding (an `Origin` must be in `allowedOrigins`; no implicit own origin, maintainer decision) _(`protocol.test.ts`)_
- [x] Coverage thresholds met (`jest.config.js`): measured and set to 94/88/96/95 (statements/branches/functions/lines), enforced in CI by `npm run test:coverage`
- [x] Release workflow (port v1's release-it + trusted publishing): `.release-it.json`, `.github/workflows/release.yml` (manual, on main; npm trusted publishing with provenance). Dry run checked locally; the publish itself, OIDC and the deploy key can only be checked in GitHub Actions
- [x] The published package holds only runtime files, README and licence, and loads under an app's own Jest (`cds-plugin.js` loaded `src/` whenever `JEST_WORKER_ID` was set) _(`package.test.ts`)_
- [ ] Set `repository`, `homepage` and `bugs` in package.json, the README's absolute links and the npm trusted-publisher entry once the repository is decided (maintainer: pinned, awaiting Gavdi)
- [x] Review: run the `reviewer` agent on M7 (fixed: a stable release needs an explicit `stable` input and a `repository`, so `patch` from 2.0.0-alpha.x cannot publish 2.0.0 as `latest` by accident; pinned npm, no dependency cache in the release job, CI token read-only; the release hook runs coverage and conformance; lib/ built once per test run (two files raced) and cleaned before every build; no source maps pointing at unpublished src/; the package test boots an app and lists tools; the unused `zod` dependency removed; conformance script stops the demo on signals. Left as is: release-it publishes before it pushes (first run should be a prerelease, documented in release.yml); v1's workflow should publish with its own dist-tag before v2 takes `latest` (v1 repository))

## After 2.0

- [x] Query tools advertise and use CAP's row limits: `@cds.query.limit` (entity, then service) and `cds.query.limit`, capped by `cds.mcp.limits`. CAP already clamps MCP queries to them; the schema said 200/25 regardless, and CAP's `default` was never used _(`executor.test.ts` › reads)_
- [x] Review: run the `reviewer` agent on it (fixed: CAP's default precedence, entity's bare value before the service's default; a bad service value reported once; key completion stays within CAP's max and reports `hasMore`; a compact-tool test and demo target. Left as is: MCP can be stricter than OData when the global max is below an entity's own, documented in docs/annotations.md)

- [x] Code review for readability: comments say why rather than which milestone; shared helpers in `src/util.ts`; type-aware ESLint (`no-floating-promises`, `no-misused-promises`, `eqeqeq`); `allowedOrigins` read once; peer `@sap/cds` `^10` with a test against CAP's own paging; `cds-plugin.js` without test logic; the executor, model reader (v1 shim in `v1.ts`) and registry split by concern (docs/architecture.md, Modules)

### mcp:resources (other plugins' resources)

Plugins and app code register MCP resources through a `mcp:resources` event: a few fixed resources, and templates for many documents (ADR 0013, proposed). First user: cap-okf. One commit per task, test first.

- [x] Demo targets: in `demo/server.js`, fixed `notes://bookshop/returns-policy.md` (everyone), `notes://bookshop/stock-policy.md` (`visible` for `admin` only; `read` uses `ctx.locale`), `notes://bookshop/missing.md` (`read` throws a 404 error), and a template `notes://bookshop/topics/{+path}` over a small in-memory map (`read` 404s unknown paths, `complete`, no `list`); rows in `demo/README.md`
- [x] R1 Registry and validation: `contractVersion: 1`; closed after the emit; rejects non-absolute or non-canonical URIs, `cap:`/`ui:` schemes, duplicate URIs, templates and template names, empty `name`/`mimeType`/`uriTemplate`, a template without a variable, and callbacks that are not functions; URIs and templates come back sorted _(`test/contract/registered-resources.test.ts`)_
- [x] R2 Emit at startup and report: emitted once after `mcp:apps`, also when nothing else produces resources; the startup report lists fixed URIs and templates; with no listener, the report and `/mcp` are unchanged
- [x] R3 List per caller: `visible` decides per user (alice sees stock-policy, bob and anonymous do not); a throwing `visible` hides and logs; the `resources` capability and private cache hints follow the caller's resources (none: no capability); order is `ui://`, fixed by URI, then template `list` results; a throwing `list` is logged and adds nothing
- [x] R4 Read fixed resources: text with its MIME type; `ctx.user`, `ctx.locale` and `ctx.tenant` reach `read`; a 404 error becomes resource-not-found with the URI only; any other error is logged and not leaked; a hidden URI answers exactly like an unknown one
- [x] R5 Templates: listed in `resources/templates/list`; a matching URI reads with `params`; a fixed URI wins over a matching template; `complete` answers `completion/complete` (at most 100, `hasMore`), a throwing `complete` offers nothing; a template named like a `cap://` template is skipped and logged
- [x] R6 2025-era clients: the same list, read and completion over a stateless 2025-era request
- [x] R7 Docs: `docs/annotations.md` "Resources from code (`mcp:resources`)" next to MCP Apps (example, rules, errors, few fixed and templates for many); `docs/architecture.md` request lifecycle and adapter files; the user guide (`docs/guide/features.md`); README feature list and opt-in table
- [ ] Maintainer: accept ADR 0013 (status proposed until then)
- [x] Review: run the `reviewer` agent on the block's diff and fix what it finds, test first (fixed: a template the SDK cannot parse, or that is not canonical once expanded, fails startup instead of every request; the cap:// name clash uses every template in the model, not the caller's; a `list` returning no array or reserved URIs, and a `read` returning no string, are contained; `visible` failures and clashes are logged once; `complete` only for the template's variables; the contract types exported; tests for `cds.context` inside `read`, raw params, no caching, a failing startup. Left as is: a template's 404 reports the normalised URI, while the SDK echoes an unmatched one as sent)

Decided against (maintainer, 2026-11-11):

- **Per-tool row budgets** (`@mcp.limits`): CAP's `@cds.query.limit` already applies to MCP queries, the same limit as OData. Operations returning arrays stay uncapped, as over OData; a handler that can return a lot limits its own result.
- **Call budgets** (rate limits per user and tool): left to the SAP AI Gateway in front of `/mcp`. Every call carries its tool in the `Mcp-Name` header for such a gateway.

## 2.x (P1) and later (P2)

Multitenancy and extensibility · structured errors polish · OpenTelemetry and audit logging ·
long-running actions (tasks extension) · `subscriptions/listen` · binary resources ·
file-based prompts · localized titles, descriptions and error messages (`{i18n>…}` texts are left out today; CAP error details carry codes only) · decide whether 4xx errors from remote services are passed to agents verbatim · entities with parameters (`entity P(p: Integer)`; exposed today without a way to pass `p`). Add tasks here when 2.0 is out.
