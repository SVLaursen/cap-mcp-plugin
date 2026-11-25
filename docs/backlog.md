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

Plugins and app code register MCP resources through a `mcp:resources` event: a few fixed resources, and templates for many documents (ADR 0013). First user: cap-okf. One commit per task, test first.

- [x] Demo targets: in `demo/server.js`, fixed `notes://bookshop/returns-policy.md` (everyone), `notes://bookshop/stock-policy.md` (`visible` for `admin` only; `read` uses `ctx.locale`), `notes://bookshop/missing.md` (`read` throws a 404 error), and a template `notes://bookshop/topics/{+path}` over a small in-memory map (`read` 404s unknown paths, `complete`, no `list`); rows in `demo/README.md`
- [x] R1 Registry and validation: `contractVersion: 1`; closed after the emit; rejects non-absolute or non-canonical URIs, `cap:`/`ui:` schemes, duplicate URIs, templates and template names, empty `name`/`mimeType`/`uriTemplate`, a template without a variable, and callbacks that are not functions; URIs and templates come back sorted _(`test/contract/registered-resources.test.ts`)_
- [x] R2 Emit at startup and report: emitted once after `mcp:apps`, also when nothing else produces resources; the startup report lists fixed URIs and templates; with no listener, the report and `/mcp` are unchanged
- [x] R3 List per caller: `visible` decides per user (alice sees stock-policy, bob and anonymous do not); a throwing `visible` hides and logs; the `resources` capability and private cache hints follow the caller's resources (none: no capability); order is `ui://`, fixed by URI, then template `list` results; a throwing `list` is logged and adds nothing
- [x] R4 Read fixed resources: text with its MIME type; `ctx.user`, `ctx.locale` and `ctx.tenant` reach `read`; a 404 error becomes resource-not-found with the URI only; any other error is logged and not leaked; a hidden URI answers exactly like an unknown one
- [x] R5 Templates: listed in `resources/templates/list`; a matching URI reads with `params`; a fixed URI wins over a matching template; `complete` answers `completion/complete` (at most 100, `hasMore`), a throwing `complete` offers nothing; a template named like a `cap://` template is skipped and logged
- [x] R6 2025-era clients: the same list, read and completion over a stateless 2025-era request
- [x] R7 Docs: `docs/annotations.md` "Resources from code (`mcp:resources`)" next to MCP Apps (example, rules, errors, few fixed and templates for many); `docs/architecture.md` request lifecycle and adapter files; the user guide (`docs/guide/features.md`); README feature list and opt-in table
- [x] Maintainer: accept ADR 0013 (accepted 2026-11-17)
- [x] Review: run the `reviewer` agent on the block's diff and fix what it finds, test first (fixed: a template the SDK cannot parse, or that is not canonical once expanded, fails startup instead of every request; the cap:// name clash uses every template in the model, not the caller's; a `list` returning no array or reserved URIs, and a `read` returning no string, are contained; `visible` failures and clashes are logged once; `complete` only for the template's variables; the contract types exported; tests for `cds.context` inside `read`, raw params, no caching, a failing startup. Left as is: a template's 404 reports the normalised URI, while the SDK echoes an unmatched one as sent)

### mcp:hints (other plugins' instructions and tool notes)

Plugins and app code add text to the server instructions and short notes to generated tools' descriptions through a `mcp:hints` event, per caller (ADR 0014). Asked for by the cap-okf benchmark (M2): agents use knowledge only when told it exists and applies. Branch `feat/benchmark-m2-improvements`.

- [x] Demo target: `demo/server.js` adds a returns-policy pointer to the instructions and to `OrdersService.Orders.cancel` for support and admin; bob's output is unchanged
- [x] Registry: `contractVersion: 1`; closed after the emit; an empty `id`, a non-function callback, or an `id` registered twice for one method throws
- [x] Emit: once, right after `mcp:resources`, also when nothing else is configured
- [x] Instructions: the app's own, then each provider's trimmed text, a blank line apart, in registration order; 1,500 characters each (warned once); both eras
- [x] Tool notes: one call per generated tool per request with `{ tool, service, definition, kind }`; appended as paragraphs, 400 characters each; describe and compact tools get none
- [x] Errors and context: a failing provider is skipped and logged, its message never sent; providers get user, tenant and locale inside `cds.context`; nothing cached
- [x] No providers: output byte for byte as before (contract test; demo baseline captured at 51b3a6e)
- [x] Docs: ADR 0014 (proposed), `docs/annotations.md`, `docs/guide/features.md`, README, `docs/architecture.md`
- [x] Maintainer: accept ADR 0014 (accepted 2026-11-25)
- [x] Review: run the `reviewer` agent on the block's diff and fix what it finds (fixed: the demo baseline fixture, a frozen copy of bob's whole tool list with the package version in it, which would have failed the `2.0.0-rc.0` release commit, replaced by a contract test that providers adding nothing change nothing, notes included; a failing notes provider is logged once per request, not once per tool; listeners get a frozen object with the two methods only; tests for notes that are not text or reject, a bound action's target, compact tools and tools the caller cannot reach getting no notes. Left as is, recorded in ADR 0014: no time limit on providers (they must settle); an `await` before registering surfaces as an unhandled rejection, as for `mcp:resources`)

### Filtered-read notices

Tell the agent when `@restrict … where` filters its reads, only then (ADR 0015). Asked for by the cap-okf benchmark (round 2): agents took empty filtered results for "does not exist". Branch `feat/benchmark-m2-improvements`.

- [x] Demo target: `OrdersService.Returns` (support filtered, admin not, bob no access); `Orders` (bob and alice filtered, carol not); baseline captured at 83e6d69
- [x] Model and rule: `GrantSpec.where` (whether, never the condition; not on inherited grants); `readsFiltered` mirrors CAP's grant rule
- [x] Query results: `notice` first, declared in the filtered caller's output schema; get: "or it is not visible to you"; compact `_query`/`_get` too
- [x] Descriptions: one line on the query and get tools of filtered callers; everyone else byte for byte as before
- [x] Config: `cds.mcp.filterNotices: false` turns it off
- [x] Docs: ADR 0015 (proposed), `docs/annotations.md`, `docs/guide/production.md`, `docs/guide/annotations.md`, README, `docs/architecture.md`
- [x] Maintainer: accept ADR 0015 (accepted 2026-11-25)
- [x] Review: run the `reviewer` agent on the block's diff and fix what it finds (fixed: tests for the compact `_query`/`_get` notice, which had none; an empty `where` and a privileged user are not filtered, as in CAP; the grant rule written once (`applicable` in `src/access.ts`); the registry test pins that only the description and the output schema change; the demo baseline comparison ignores `_meta`, which carries the package version and would have failed the `2.0.0-rc.0` release commit. Left for the maintainer: `filterNotices` is on by default, an exception to ADR 0004 that stands only once ADR 0015 is accepted)

Decided against (maintainer, 2026-11-11):

- **Per-tool row budgets** (`@mcp.limits`): CAP's `@cds.query.limit` already applies to MCP queries, the same limit as OData. Operations returning arrays stay uncapped, as over OData; a handler that can return a lot limits its own result.
- **Call budgets** (rate limits per user and tool): left to the SAP AI Gateway in front of `/mcp`. Every call carries its tool in the `Mcp-Name` header for such a gateway.

## 2.0 release candidate

From the gap analysis against MCP 2026-07-28 (25 Nov 2026; project doc `claude/mcp-2026-07-28-gap-analysis.md`, full report https://claude.ai/artifact/8PsgucBHW6xQra7XoaF9WP). The core protocol passed every mandatory requirement that was probed; these tasks close what is left before `2.0.0-rc.0`. Maintainer decision (25 Nov 2026): Skills over MCP ships in 2.0, opt-in. Tasks that start with "Maintainer:" are not for `next-task`; skip them and go on.

### Protocol edge

- [x] RC1 Characterisation: pin the 2026-07-28 wire contract that only the SDK guarantees today, so an SDK upgrade cannot change it silently. These tests are expected to pass at once (the official conformance suite, 0.1.16, has no 2026-07-28 scenarios): a missing or mismatched `Mcp-Method`, a missing `Mcp-Name` on `tools/call` and a missing `MCP-Protocol-Version` header are HTTP 400 with `-32020`; a request without the `_meta` envelope is `-32602` naming the missing keys; `ping` and `logging/setLevel` are `-32601`; every result carries `io.modelcontextprotocol/serverInfo` in `_meta`; `resources/read` carries `ttlMs` and `cacheScope`; a call with `io.modelcontextprotocol/logLevel` gets no `notifications/message`; `subscriptions/listen` is acknowledged with nothing subscribed and ends _(`protocol.test.ts` › stateless)_. All passed at once. The envelope check names the spec's required keys only (`protocolVersion`, `clientCapabilities`): `clientInfo` is a SHOULD, so a request without it is served (pinned too)
- [x] RC2 MCP Apps declared: read the ext-apps specification first (`specification/2026-01-26/apps.mdx` in modelcontextprotocol/ext-apps) and record in ADR 0012 what it asks of a server. Unless it says servers do not declare the extension: `server/discover` carries `capabilities.extensions["io.modelcontextprotocol/ui"]` for a caller with at least one UI tool and no `extensions` for a caller without (advertise only what the caller can use); the ext-apps contract test also checks `EXTENSION_ID` _(`protocol.test.ts` › mounting; `apps.test.ts`)_. → The specification (Stable, 2026-01-26) defines only the client's declaration; servers declare nothing. Recorded in ADR 0012 (addendum), no code
- [x] RC3 `ui://` resources are listed with a readable `name` and `title` taken from the tool that links to them (first by tool name when several do), not the URI _(`opt-in-features.test.ts` › MCP Apps)_
- [x] RC4 Scopes in the auth challenge, opt-in: `cds.mcp.scopes` (a list of strings, checked like the other keys) is sent as `scope` in the Bearer `WWW-Authenticate` challenge and as `scopes_supported` in the RFC 9728 metadata; `offline_access` is refused with a diagnostic (the spec says servers should not ask for it); without the key both are byte for byte as today _(`adapter-auth.test.ts`, `protocol-auth.test.ts`, `config.test.ts`; `docs/annotations.md`, `docs/guide/production.md`)_. `protocol-auth.test.ts` stays unchanged (it proves "without the key"); the key end to end is `protocol-auth-scopes.test.ts`, since CAP reads the config once per boot

### Skills over MCP (SEP-2640)

An app serves Agent Skills (folders with a `SKILL.md`) beside its tools through the official extension `io.modelcontextprotocol/skills`. The SDK already carries the protocol side: `@modelcontextprotocol/server/ext/skills` and `/ext/skills/node` (`loadSkills`, `SkillCatalog.attach`, `SkillSource`), CommonJS, no new runtime dependency. Specification: https://skills.extensions.modelcontextprotocol.io/specification/beta/skills. First cut, as decided: a folder named by config, one catalog for every caller the endpoint lets in, static content (hosts bind approval to the published digests). One commit per task, test first.

- [x] S0 **SPIKE** → ADR 0016 (proposed): inside `cds.test`, attach one catalog loaded at startup to the per-request server of `createMcpHandler`. → `attach` suits per-request servers (no measurable cost, no heap growth); its template name `io.modelcontextprotocol/skills` cannot clash with `cap://` names but an `mcp:resources` template of that name takes down every request; 2025-era clients get the same catalog (files as ordinary resources); cache hints 60 s private; warnings, not `strict` (a bad skill is skipped whole); `directoryRead` declared (the SDK's catalog always implements it); the experimental `attach` guarded by a contract test, no pin; `cds.mcp.skills` a folder (string) inside the app root. Tasks below corrected to the ADR
- [x] Maintainer: accept ADR 0016 (accepted 2026-11-25)
- [x] S1 Demo target: `demo/mcp-skills/handle-return/SKILL.md` (frontmatter `name: handle-return`, a description, steps that use the Orders and Returns tools and the returns policy) and `references/checklist.md`; a row in `demo/README.md`. The key itself (`cds.mcp.skills: "mcp-skills"`) is set in the demo by S2, which reads it: before that it is an `UNKNOWN_CONFIG` warning, and the demo's startup report must stay clean (`startup-report.test.ts`). Tests that pin exact outputs of the demo (e.g. `protocol.test.ts` › "only implemented capabilities are advertised") are updated in S4, where the outputs change
- [x] S2 Config: `cds.mcp.skills` read and checked in `src/config.ts` (a non-empty string; no `UNKNOWN_CONFIG`; a wrong shape is `INVALID_CONFIG`); a folder that does not exist, is not a folder, or resolves (symlinks followed) outside the app root is an `INVALID_CONFIG` error and serves no skills; startup goes on _(`config.test.ts`)_. `skillsFolder` decides it; the startup wiring (diagnostic in the report) lands with S3, which loads the folder. The demo sets the key
- [x] S3 Load and report: the catalog is loaded once on `served` (`loadSkills` with the cache hint and `onWarning`, not `strict`), before `mcp:apps`; the startup report lists the skills by `SKILL.md` URI; each SDK warning (no frontmatter `name`/`description`, a name that is not its folder, over 512 files or 16 MiB, a symlink) is an `INVALID_SKILL` warning targeting the file, and that skill is not served at all; a `SkillCatalogError` (unreadable folder) is `INVALID_CONFIG` and no skills are served; a folder without a valid skill declares nothing _(`startup-report.test.ts`, contract tests over a temp folder)_. The SDK serves a skill over the limits with only a warning, so the plugin skips it itself (ADR 0016, correction); a folder without skills is also an `INVALID_SKILL` warning ("no skills found")
- [x] S4 Serve: the factory attaches the catalog to every request's server after our own registrations; `server/discover` declares `extensions["io.modelcontextprotocol/skills"] = { directoryRead: true }` and `resources: { listChanged: false }`; `skills/list` and `skills/get` answer with `resultType`, `ttlMs` 60000, `cacheScope` private and the frontmatter verbatim; every listed file reads through `resources/read`, and its bytes match the published `sha256:` digest and `size`; `resources/directory/read` lists `skill://handle-return` (no trailing slash); `SKILL.md` appears in `resources/list`; an unknown skill URI is `-32602`. A contract test attaches a catalog to a fresh `McpServer` and pins what we rely on (`SKILLS_EXTENSION_ID`, the template name, the methods, the capability), as ADR 0012 does for ext-apps. Update the demo assertions that S1 left for here _(new `test/behaviour/skills.test.ts`, new `test/contract/skills.test.ts`)_
- [x] S5 Off by default: a behaviour file boots the demo with `cds.mcp.skills` removed: no `extensions` in `server/discover`, no `skill://` resource or template, `resources/directory/read` and `skills/list` are method-not-found, and the capabilities are what they were before S1. No frozen fixture of whole results (a package version in `_meta` breaks it at every release; see the mcp:hints review); compare with what the registry and the demo's resources give, as `protocol.test.ts` does _(`skills-off.test.ts`)_
- [x] S6 Scheme, name and capability: `mcp:resources` rejects `skill:` URIs and templates as it does `cap:` and `ui:`, and the template name `io.modelcontextprotocol/skills`, whether or not skills are configured; with skills configured the `resources` capability is declared with `listChanged: false` and our cache hints also for a caller with no other resource (the SDK's own default says `listChanged: true`, `ttlMs: 0`); anonymous callers and production (`restrict_all_services`) behave as for every other request _(`registered-resources.test.ts`, `skills.test.ts`)_. The capability and access tests passed at once: S4 had already built them
- [x] S7 2025-era clients: the same catalog over a stateless 2025-era request: the extension in `initialize`'s capabilities, `skills/list` and `skills/get` without cache fields, `SKILL.md` in `resources/list`, every file through `resources/read` _(`skills.test.ts`)_
- [x] S8 Build: `cds build` copies the skills folder to `gen/srv/<folder>`, as it does the instructions file, and warns when it is missing or an absolute path _(`cds-cli.test.ts`)_. Symlinks are left out with a warning: cds-dk's copy follows them, so a skill skipped at runtime would otherwise turn into regular files in gen/ and be served
- [x] S9 Docs: `docs/annotations.md` (Configuration; `INVALID_SKILL` in Diagnostics; a "Skills (`cds.mcp.skills`)" section next to resources from code: example, rules, limits of 512 files and 16 MiB per skill, static content and why, restart to change, reserved `skill:` scheme), `docs/guide/features.md`, `docs/guide/production.md` (skills are instructions for agents, not data; CAP still authorizes every call; every caller the endpoint lets in sees them), README feature list and opt-in table, `docs/architecture.md` (request lifecycle, adapter files) _(`docs.test.ts`)_
- [x] S10 Review: run the `reviewer` agent on the block's diff and fix what it finds, test first (fixed: the build copied a skill the runtime skips once its symlink was left out, and did not check the folder, so `../x` or a symlinked folder could read and write outside the app; it now checks and loads the folder as the runtime does and copies only the served skills' files (no dotfiles). `skills: "."` served skills from `node_modules`: the app root is refused. Read-time warnings went to an array that grew per read: they are logged. A nested skill inside a skipped one is reported; no misleading "no skills found"; clean diagnostic targets; `..skills` is inside the root; the checked path is the loaded path; any load error is `INVALID_CONFIG`; cache hints on skill files and directory reads pinned. Recorded in ADR 0016, clarifications)

### Skills in the hint context (ADR 0017)

cap-okf informs agents about the app through `mcp:hints`; it should be able to point them at skills too. Skills cannot carry that text (frontmatter verbatim, digests bind approval), so providers learn which skills are served. Maintainer decision (25 Nov 2026), ADR 0017. One commit per task, test first.

- [x] K1 Demo target: `demo/server.js` adds an instructions line for support and admin naming the `handle-return` skill, only when `ctx.skills` has it; bob's output is unchanged. Committed with K2: before it, the demo provider would read a `skills` that does not exist yet and fail on every staff request
- [x] K2 Context: every provider's context has `skills` (`{ uri, name, description }`, sorted by URI, frozen, the same array on every request); empty without `cds.mcp.skills`; no output changes without a provider that uses it _(`hints.test.ts`, `skills.test.ts`)_
- [x] K3 Docs: `docs/annotations.md` (Hints from code), `docs/guide/features.md`, `docs/guide/skills.md`, `docs/architecture.md`; types exported
- [ ] K4 Review: run the `reviewer` agent on the block's diff and fix what it finds

### Release

- [x] RC5 Docs: `docs/mcp-spec-notes.md` gets the official extensions (MCP Apps, Skills, Tasks, OAuth client credentials, enterprise-managed authorization) with where v2 stands, and the note that the conformance suite has no 2026-07-28 scenarios yet (re-check on each release of `@modelcontextprotocol/conformance`). → True of 0.1.16, which we run; the 0.2.0 prereleases (`alpha`, 0.2.0-alpha.12) have 2026-07-28 scenarios. Recorded in `docs/mcp-spec-notes.md` › Conformance
- [x] RC6 Docs: `docs/guide/production.md` says how MCP clients register with XSUAA and IAS. Check SAP's documentation for Client ID Metadata Documents and dynamic client registration; where neither is supported, say that each client needs a pre-registered OAuth client and show the setup for one. State what was verified and what was not. → Neither documents Client ID Metadata Documents; IAS lists dynamic client registration but documents no endpoint for it (its documented discovery example has none); the guide recommends a pre-registered client per MCP client for both and lists what was verified and what was not
- [x] RC7 Review: run the `reviewer` agent on the Protocol edge and Release tasks' diff and fix what it finds (fixed: `resources/read` cache hints set by the adapter (`ttlMs` 0, private) instead of the SDK's default, and pinned; mismatched `Mcp-Name` on `tools/call` and a missing one on `resources/read` characterised (both passed); the logLevel test labelled as ours; scope tokens with a quote, backslash, non-ASCII or empty pinned; a UI's name never comes from a tool the caller cannot see; the XSUAA setup no longer claims a client per service key and warns that the secret allows the client credentials grant; the IAS setup names the open audience step; spec-notes wording. Left as is: no warning when `scopes` is set without OAuth-based auth, duplicates in `scopes` accepted)
- [ ] Maintainer: the open boxes above (ADR 0014 and ADR 0015 accepted 2026-11-25; still open: `repository`, `homepage`, `bugs` in M7)
- [ ] Maintainer: smoke test on BTP with real clients, one speaking 2026-07-28 and one 2025-era, against XSUAA and IAS: login through the RFC 9728 metadata (this also checks the token audience; for IAS, a token issued to a separate client application; for XSUAA, whether two service keys give different `client_id`s), list, call, an `@mcp.elicit` confirmation, an MCP App, a skill. Client names and versions go into the release notes
- [ ] Maintainer: full gate on `main` (`npm run check`, coverage, conformance), then `2.0.0-rc.0` as a prerelease with its own dist-tag (v1 gets its own dist-tag before v2 takes `latest`)

## 2.x (P1) and later (P2)

Multitenancy and extensibility · structured errors polish · OpenTelemetry and audit logging ·
long-running actions (tasks extension) · `subscriptions/listen` · binary resources ·
file-based prompts · localized titles, descriptions and error messages (`{i18n>…}` texts are left out today; CAP error details carry codes only) · decide whether 4xx errors from remote services are passed to agents verbatim · entities with parameters (`entity P(p: Integer)`; exposed today without a way to pass `p`) · skills from other plugins (`mcp:skills` event), per-role skill visibility, catalog reload with change notifications, a skills `prefix`, configurable skill limits and dynamic skills (ADR 0016) · trace context from `_meta` (`traceparent`) into CAP's telemetry · the authorization extensions (OAuth client credentials, enterprise-managed authorization). Add tasks here when 2.0 is out.
