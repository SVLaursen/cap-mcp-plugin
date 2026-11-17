# 0014 — Hints from code: the `mcp:hints` event

Status: proposed · 2026-11-17 (after 2.0)

## Context

An evaluation of agents against a knowledge plugin (cap-okf, see ADR 0013) showed that agents
use the knowledge a server offers only when something tells them that it exists and when it
applies. Two places are read by every agent: the server's `instructions` and each tool's
`description`. Today only the app writes those, through `cds.mcp.instructions` (a file) and its
annotations (`@mcp.description`, doc comments). A plugin that serves knowledge, or app code
that decides at runtime, has no way to add a line to either.

What exists today:

- `mcp:apps` (ADR 0012) and `mcp:resources` (ADR 0013): events on `served` that hand listeners
  a registry, closed once the event returns.
- Every request builds its own `McpServer` (ADR 0010), from the registry for the caller's model
  and user. The SDK's factory may be async (`McpServerFactory` returns `McpServer | Promise`).
- Server instructions go into the `McpServer` constructor. 2026-07-28 clients read them from
  `server/discover`; 2025-era clients from `initialize`.
- The factory is not told the JSON-RPC method. 2026-07-28 requests carry it in the `Mcp-Method`
  header (the SDK checks it against the body before the factory runs); 2025-era requests do not.

## Decision

After `mcp:resources`, on `served`, the plugin emits `cds.emit("mcp:hints", registry)` exactly
once, whether or not anything else is configured, so listeners can rely on it.

```ts
interface HintContext {
  user: unknown; // cds.context.user (a cds.User)
  tenant?: string; // cds.context.tenant
  locale?: string; // cds.context.locale
}

interface HintRegistry {
  readonly contractVersion: 1;
  /** Text added to the MCP server's `instructions` (initialize and server/discover). */
  addInstructions(provider: InstructionsProvider): void;
  /** Short notes added to the descriptions of generated tools. */
  addToolNotes(provider: ToolNotesProvider): void;
}

interface InstructionsProvider {
  id: string; // unique among instructions providers
  text(ctx: HintContext): string | undefined | Promise<string | undefined>;
}

interface ToolNotesProvider {
  id: string; // unique among tool notes providers
  /** Called once per generated tool, per request. Return undefined for "nothing to add". */
  note(target: ToolTarget, ctx: HintContext): string | undefined | Promise<string | undefined>;
}

interface ToolTarget {
  tool: string; // the MCP tool name, e.g. "OrdersService_Orders_cancel"
  service: string; // fully qualified CDS service name
  definition: string; // fully qualified CDS name of the entity, action or function behind the tool
  kind: "entity" | "action" | "function";
}
```

The types are exported from the package (types only), as for `mcp:resources`.

### Registration (startup)

Listeners register synchronously while the event runs. Afterwards the registry is closed and
both methods throw (so does a listener that awaits something first). A registration that throws
fails startup. Each of these throws a `cap-mcp: …` error:

- a missing or empty `id`;
- `text` (or `note`) is not a function;
- an `id` already registered **for the same method**. One plugin may use the same `id` for its
  instructions provider and its notes provider; ids are unique per kind.

### Per request

Only when at least one provider is registered; otherwise the factory does exactly what it did
before (nothing is awaited, the output is byte for byte the same).

- **Context.** Providers run inside the request's `cds.context` (user, tenant, locale), not
  wrapped in `srv.tx`: they are not CAP data access through this plugin (ADR 0003 applies to
  what we run). Nothing they return is cached across requests; the answer may differ per user,
  tenant and locale.
- **Instructions.** Every `text` is called, concurrently, and the answers are used in
  registration order. Each is trimmed; `undefined`, `null` and empty strings add nothing. The
  app's own instructions (if any), trimmed, come first, then each text, a blank line apart. If no
  provider adds anything, the app's instructions are passed on untouched (not trimmed).
- **Tool notes.** `note` is called once per generated tool the caller gets, per provider,
  concurrently. Each non-empty note, trimmed, is appended to the tool's `description` as its own
  paragraph (`"\n\n"`), after the existing text, in provider registration order. Notes are plain
  text: passed on as they are, never interpreted.
- **Which tools.** Entity tools (`query`, `get`, `create`, `update`, `delete`, with the entity as
  `definition`) and operation tools (`action` or `function`, with the operation's fully qualified
  name, bound ones as `Service.Entity.op`). The `describe` tool and the `@mcp.compact` tool set
  act on a whole service and have no definition behind them, so they get no notes.
- **Limits.** Each provider's instructions text is cut at 1,500 characters, each note at 400
  (counted in code points, so a cut never splits a character). A cut is logged as a warning once
  per provider and activation, not on every request.
- **Both eras.** 2026-07-28 clients get the instructions in `server/discover`, 2025-era clients
  in `initialize`; the tool lists are the same (ADR 0010).

### Errors

A provider that throws, rejects, or returns anything but a string (or `undefined`/`null`) is
skipped for that request and logged as an error (`cap-mcp: tool notes provider <id> failed;
skipped for this request`). Its message never reaches the client. The rest of the request goes
on as if that provider had returned nothing.

### Opt-in (ADR 0004)

Emitting the event changes nothing. Text appears only because code registered a provider and
that provider returned it: the app's own code, or a plugin the app installed and configured.
No `cds.mcp` key is added.

### Cost

Every request builds its server, so every request, `tools/call` included, calls every
`text` once and every `note` once per generated tool. Measured on the demo (alice: 20 tools,
one notes provider, 40 requests): a synchronous `note` costs nothing measurable (0.5–0.9 ms per
request with or without it); an async `note` that waits 5 ms per call adds about 6 ms per
request, because the calls run concurrently. A provider that does I/O per tool therefore issues
one I/O per tool on every request, which is the real cost.

Providers should answer from memory (an index built at startup, keyed by `definition`) and keep
async work out of `note`. If that is not enough, the cheaper shapes, each a later contract
version, are:

1. **One call per request**, `notes(targets: ToolTarget[], ctx) → Record<tool, string>`: one
   lookup instead of one per tool, and the provider can batch its own I/O.
2. **Only where it is read**: call `text` only for `initialize`/`server/discover` and `note`
   only for `tools/list`. 2026-07-28 requests name their method in `Mcp-Method`, so the factory
   could skip hints for every other method; 2025-era requests do not, so they would need the
   body peeked at, or hints on every request as now.

Neither caches across requests.

## Alternatives considered

- **Annotations only** (`@mcp.description`, the instructions file). Static, written by the app;
  a plugin cannot add to them, and they cannot depend on the caller.
- **A hook that rewrites the whole tool list.** Powerful, but lets code drop or rename tools and
  rewrite schemas, outside the opt-in rules. Notes can only add text at the end.
- **Notes for describe and compact tools** (a `kind: "service"` target). Left out: there is no
  single definition to name, and no use case yet. A later contract version can add it.
- **Caching answers per user.** Rejected: the answer may depend on anything in the context, and
  cache invalidation would be the provider's problem disguised as ours.

## Consequences

- `cds.on("mcp:hints")` is part of the user-facing contract (docs/annotations.md), and
  `contractVersion` rises only for breaking changes.
- The server factory is async. It awaits providers only when some are registered.
- `AdapterOptions.log` gains an optional `warn` (for cut texts; `error` is used without it).
- Out of scope: hints for prompts or resources, `listChanged` notifications, removing or
  rewriting text, registrations after startup.
