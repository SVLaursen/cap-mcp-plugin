# 0016 — Skills over MCP: one static catalog from a folder

Status: accepted · 2026-11-25 (2.0 RC, spike S0; accepted by the maintainer the same day)

## Context

Agent Skills are folders with a `SKILL.md` (YAML frontmatter `name` and `description`, then
instructions) and optional files beside it. The Skills extension (SEP-2640,
`io.modelcontextprotocol/skills`, specification "beta") serves them over MCP: `skills/list`,
`skills/get` and, optionally, `resources/directory/read`, with each file readable as a
`skill://` resource through `resources/read`. An app could ship skills that explain how its
tools fit together ("handle a return": which tools, in which order, which policy to read).

Decided by the maintainer before this spike, not reopened here: skills ship in 2.0, opt-in
through a folder named by `cds.mcp.skills`; one catalog for every caller the endpoint lets in;
static content (hosts bind a user's approval to the published digests); no `mcp:skills` event,
no per-role visibility and no reload in 2.0.

### What the specification asks of a server

Read: https://skills.extensions.modelcontextprotocol.io/specification/beta/skills.

- A server that declares `capabilities.extensions["io.modelcontextprotocol/skills"]` MUST
  implement `skills/list` and `skills/get`, and MUST also declare the `resources` capability.
  `{ directoryRead: true }` declares `resources/directory/read`, which is then a MUST for every
  directory the server serves.
- A skill entry carries `uri` (its `SKILL.md`), `frontmatter` identical to the file's, and the
  complete list of its files as `{ uri, digest: "sha256:…", size }`. Hosts verify every file
  they fetch against it and bind approval to the whole set; a changed set revokes approval.
- `skills/get` answers for every skill served; an unknown URI is `-32602`.
- Results carry `resultType`, `ttlMs` and `cacheScope` (the examples use `public`, 300 s).
- Servers SHOULD NOT serve a skill over 512 files or 16 MiB.
- Nothing about 2025-era clients, except "to a client that does not implement this extension,
  `skill://` resources are ordinary resources". Nothing about per-user catalogs, symlinks or
  `listChanged`.

### What the SDK offers

`@modelcontextprotocol/server` 2.4.0, `./ext/skills` and `./ext/skills/node` (CommonJS, no new
dependency): `loadSkills(root, options)` builds a `SkillCatalog` from a folder of skill folders;
`catalog.attach(mcpServer)` registers one resource template, named
`io.modelcontextprotocol/skills`, over `skill://{+path}` (with a `list` callback that puts each
`SKILL.md` in `resources/list`), the `skills/list`, `skills/get` and `resources/directory/read`
handlers, and the extension in the server's capabilities. A `SkillCatalog` always implements
directory reads, so it always declares `directoryRead: true`. `attach` is marked
`@experimental` ("how an extension is wired to a server may change in a minor release").
`SkillSource` is the interface for building a catalog of one's own.

### What the spike measured

Inside `cds.test` on the demo, a catalog loaded once was attached to the server our own factory
(`serverFactory`) builds for each request, on an extra route behind `cds.middlewares.before`
(throwaway code under `_spike/`, not committed). One valid skill with a file under
`references/`, and three invalid ones.

- **Per-request servers work.** "One instance serves any number of servers: call attach on
  each." `attach` keeps a `WeakSet` (attaching twice to one server does nothing) and, for
  `reload()`, a `WeakRef` per server, pruned once there are 1,024. `skills/list`, `skills/get`,
  `resources/read` of every file, `resources/directory/read` (`skill://handle-return`, no
  trailing slash), `resources/list` and `resources/templates/list` all answered as the
  specification says, with the published digests matching the bytes.
- **Cost.** Loading the folder took 10 ms. 200 `tools/list` calls as alice took 0.91 ms per
  request without the catalog and 0.88 ms with it (a second round; the first, warming up, 1.5
  and 1.2 ms). 2,000 requests with the catalog attached left the heap no larger. The catalog
  holds metadata only; files are read from disk on each `resources/read` and checked against
  the published digest.
- **Capability.** Our factory declares `resources: { listChanged: false }` only when the caller
  has some resource. For a caller with none, `attach` made the SDK declare
  `resources: { listChanged: true }` (its default, a notification we never send) and
  `resources/list` came back with `ttlMs: 0`, outside our cache hints.
- **Names.** The template's name, `io.modelcontextprotocol/skills`, cannot equal a `cap://`
  template's name (`<Service>_<Entity>`, no `/`). An `mcp:resources` template registered under
  that name made `attach` throw in the factory, so **every** request on the endpoint failed with
  `-32603`. A `mcp:resources` URI or template under `skill://` would overlap the catalog's
  URIs. Our `completion/complete` handler and the skills template coexist (the skills template
  completes nothing).
- **2025-era clients** (stateless, ADR 0010) got the extension in `initialize`'s capabilities;
  `skills/list` and `skills/get` answered (without cache fields, which the SDK adds for
  2026-07-28 only); `SKILL.md` files were in `resources/list` and every file read through
  `resources/read`, as ordinary resources.
- **Invalid skills.** Without `strict`, each problem is a warning (`onWarning`) and the whole
  skill is skipped: a `name` that is not its folder's, a frontmatter without `description`, a
  symlink anywhere in the skill. Nothing of a skipped skill is served. A folder that cannot be
  read throws `SkillCatalogError`, `strict` or not.

## Decision

`SkillCatalog.attach` suits per-request servers. We use it as it is, with no `SkillSource` of
our own.

1. **Configuration.** `cds.mcp.skills` is a string: a folder relative to the app root
   (`cds.root`), holding one folder per skill. It is checked like every other key: anything but
   a non-empty string is `INVALID_CONFIG`. A folder that does not exist, is not a folder, or
   resolves (symlinks followed) outside the app root is an `INVALID_CONFIG` error and no skills
   are served; startup goes on. Without the key nothing changes (ADR 0004).
2. **Loading.** Once, on `served`, with `loadSkills(folder, { cacheHint, onWarning })`, before
   `mcp:apps`. Not `strict`: each SDK warning becomes an `INVALID_SKILL` warning in the startup
   report (target: the file's path under the skills folder; the SDK's message), and that skill
   is not served at all (the SDK skips it whole). A `SkillCatalogError` (storage) becomes an
   `INVALID_CONFIG` error and no skills are served. A folder with no valid skill serves no
   skills and declares nothing. The startup report lists the served skills by `SKILL.md` URI.
3. **Serving.** The factory attaches the one catalog to every request's server, after our own
   registrations. A configured catalog with at least one skill counts as a resource, so the
   `resources` capability (`listChanged: false`) and our cache hints for `resources/list` and
   `resources/templates/list` are declared for every caller, also one with no other resource
   (the specification requires `resources`; the SDK's default would say `listChanged: true`).
   Every caller the endpoint lets in gets the same catalog: CAP's authentication and
   `restrict_all_services` apply before the factory runs, as for every request (ADR 0009).
4. **Cache hints.** `{ ttlMs: 60_000, cacheScope: "private" }`, as for our lists, on
   `skills/list`, `skills/get`, directory reads and skill files. The content is the same for
   every caller, but the endpoint may require login: `public` would let a shared cache serve it
   to someone the endpoint would refuse.
5. **`directoryRead`.** Declared, because `SkillCatalog` always implements it; it is static
   and costs nothing. Directory URIs have no trailing slash.
6. **2025-era clients.** The same catalog over the same factory (ADR 0010): the extension in
   `initialize`, the methods, and `skill://` files as ordinary resources. No special case.
7. **Reserved names.** `mcp:resources` refuses (`register` and `registerTemplate` throw, as for
   `cap:` and `ui:`) the `skill:` scheme and the template name `io.modelcontextprotocol/skills`,
   whether or not skills are configured, so a registration cannot take down the endpoint later
   when skills are switched on.
8. **The experimental `attach`.** Guarded like ext-apps in ADR 0012: a contract test attaches a
   catalog to a fresh `McpServer` and asserts what we rely on (the extension id
   `SKILLS_EXTENSION_ID`, the template name, the methods answering, the capability with
   `directoryRead`, `resources` declared with `listChanged: false` when we declare it first).
   An SDK upgrade that changes the wiring fails that test. The dependency range stays `^2.4.0`;
   no pin.
9. **Build.** `cds build` copies the skills folder into the deployed app (`gen/srv/<folder>`),
   as it does the instructions file, and warns when it is missing or an absolute path.

Out of 2.0 (`docs/backlog.md`, 2.x): an `mcp:skills` event for skills from other plugins,
per-role skill visibility, `reload()` with `resources/list_changed`, `prefix`, configurable
limits (the SDK's 512 files and 16 MiB apply), dynamic (`"dynamic"`) skills, and a
`SkillSource` of our own.

## Alternatives considered

- **A `SkillSource` of our own.** Needed only for per-user or generated catalogs, which 2.0
  does not have. It would re-implement digest publishing and file checks the SDK's catalog
  already does (`skillEntry` helps, but reads stay ours).
- **`strict: true`.** One bad skill would stop the whole app from starting. Skills are guidance
  beside the tools; a warning and a skipped skill fit how the plugin treats other content from
  files (a missing MCP App file is a warning, ADR 0012).
- **Serving skills to 2026-07-28 clients only.** Would need the era in the factory and a second
  code path; the specification says older clients see ordinary resources, which is harmless.
- **Defer to 2.1.** Not needed: the spike found no blocker.

## Consequences

- One new config key (`skills`) and one new diagnostic code (`INVALID_SKILL`, warn).
- `mcp:resources` gains two refusals (a `skill:` URI or template, the reserved template name);
  an app that registered either today breaks at startup. None is known.
- Every request with skills configured registers one template and three handlers more; the
  spike measured no difference.
- The content is static for the life of the process: changing a skill needs a restart (and,
  for hosts, a new approval, since its digests change).
- Skills are instructions for agents, not data and not authorization: CAP still checks every
  tool call they lead to (docs/guide/production.md).
