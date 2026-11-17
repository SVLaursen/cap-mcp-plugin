# 0013 — Resources from code: the `mcp:resources` event

Status: proposed · 2026-11-17 (after 2.0)

## Context

Another CAP plugin, cap-okf, serves an app's knowledge (its CDS model plus curated notes) as
Markdown documents, and wants to publish them as MCP resources through this plugin. Neither
plugin may import the other. App code has the same need: a policy text, a how-to for agents.

What exists today:

- `cap://<Service>/<Entity>/{key}` templates serve single records of `@mcp.resource` entities
  (ADR 0006). They come from annotations and are read through CAP.
- `mcp:apps` (ADR 0012) lets code supply `ui://` HTML, but only for URIs a tool links to. Plain
  documents have no tool and no `ui://` scheme; bending that event would break its rule.
- Every request builds its own `McpServer` (ADR 0010), so anything registered per request costs
  something on every call, `tools/call` included.

What the SDK (`@modelcontextprotocol/server` 2.x) does with resources:

- A fixed resource is stored under the URI string it was registered with, and `resources/read`
  looks it up by `new URL(uri).toString()`. A URI that `URL` rewrites (a space, an upper-case
  host in a special scheme) is listed but can never be read.
- Templates are stored by **name**, and a second template with the same name throws. Fixed
  resources are checked before templates on read. `{+path}` matches across slashes.
- `resources/list` lists fixed resources in registration order, then whatever each template's
  `list` callback returns. Templates without `list` appear only in `resources/templates/list`.

cap-okf's proposal (its ADR-0006, revision 2) asked for fixed resources and templates, an async
`visible`, and one fixed resource per concept for small bundles. This ADR settles what we build.

## Decision

After `mcp:apps`, on `served`, the plugin emits `cds.emit("mcp:resources", registry)` exactly
once, whether or not the app produces any other resource, so listeners can rely on it.

```ts
interface ResourceContext {
  user: unknown; // cds.context.user (a cds.User)
  tenant?: string; // cds.context.tenant
  locale?: string; // cds.context.locale
}

interface ResourceRegistry {
  readonly contractVersion: 1;
  register(resource: FixedResource): void;
  registerTemplate(template: TemplateResource): void;
}

interface FixedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  read(ctx: ResourceContext): string | Promise<string>;
  /** Synchronous. Without it, every caller sees the resource. */
  visible?(ctx: ResourceContext): boolean;
}

interface TemplateResource {
  uriTemplate: string; // RFC 6570, e.g. "okf://acme-orders/{+path}"
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  read(
    ctx: ResourceContext & { uri: string; params: Record<string, string> },
  ): string | Promise<string>;
  /** Optional: concrete resources for resources/list. Leave it out for large sets. */
  list?(ctx: ResourceContext): ListedResource[] | Promise<ListedResource[]>;
  /** Optional: values for completion/complete on one of the template's variables. */
  complete?(ctx: ResourceContext, param: string, value: string): string[] | Promise<string[]>;
}

interface ListedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
}
```

### Registration (startup)

Listeners register synchronously while the event runs. Afterwards the registry is closed, and
`register` and `registerTemplate` throw. Each of these throws a `cap-mcp: …` error naming the
URI:

- `uri` is not an absolute URI, or not in canonical form (`new URL(uri).href !== uri`);
- `uri` or `uriTemplate` uses the `cap:` or `ui:` scheme (records and MCP Apps stay ours);
- a duplicate `uri`, a duplicate `uriTemplate`, or a duplicate template `name` (the SDK keys
  templates by name);
- a missing or empty `name`, `mimeType` or `uriTemplate`, or a template without a variable;
- `read` is not a function, or `visible`, `list` or `complete` is given and is not one.

Duplicate names of fixed resources are allowed: MCP does not require them to be unique. The
startup report lists the registered fixed URIs and templates, sorted.

### Per request

- **Visibility.** A fixed resource is added when it has no `visible`, or `visible(ctx)` returns
  `true`. A `visible` that throws hides the resource for that request and is logged once. Every
  registered template is added for every caller; its `read` decides what exists for that caller.
- **Capability.** The `resources` capability (`listChanged: false`) and the private cache hints
  are advertised when the caller has any resource: a `cap://` template, a `ui://` app, a visible
  fixed resource, or a registered template. Without any, `/mcp` behaves as before.
- **Order.** `resources/list` holds the `ui://` apps, then the visible fixed resources sorted by
  URI, then what the templates' `list` returns. A `list` that throws is logged and adds nothing;
  the rest of the list still answers.
- **Context.** `read`, `list`, `complete` and `visible` run inside the request's `cds.context`
  (user, tenant, locale) and are not wrapped in `srv.tx`: they are not CAP data access through
  this plugin (ADR 0003 applies to what we run; the registering code owns its own). Nothing they
  return is cached across requests.
- **Templates.** A matching URI calls `read` with the `uri` and the template's `params` as
  strings. A fixed URI wins over a template that matches it (the SDK checks fixed first).
  `completion/complete` for a registered template calls `complete`; at most 100 values are
  returned, with `hasMore` when there are more. A `complete` that throws is logged and offers
  nothing, as a CAP refusal does for `cap://` keys.
- **Names.** A registered template whose name equals a `cap://` template's name in the request's
  model is not added for that request, and is logged. The tenant's model decides `cap://` names,
  so this cannot be checked once at startup.

### Errors

- An error from `read` with `status` or `statusCode` 404, or `code: "NOT_FOUND"`, becomes the
  protocol's resource-not-found error, with the URI only. Its message is not passed on: it was
  written for the plugin, not for agents.
- Any other error goes through the internal-error path: logged, and answered as JSON-RPC
  Internal error, with the message only outside production (as for `cap://` today).
- A fixed resource a caller cannot see is not on that request's server, so reading it answers
  exactly like an unknown URI. If a template matches the hidden URI, the template's `read`
  answers instead; a template must return 404 for whatever the caller may not see.
- 2026-07-28 clients and 2025-era clients get the same resources (ADR 0010).

### Opt-in (ADR 0004)

Emitting the event exposes nothing. A resource exists only because code registered it: the
app's own code, or a plugin the app installed and configured to do so (cap-okf, for example,
only registers with `cds.okf.serve.mcp` set). Installing and configuring that plugin is the
app's opt-in, as writing an `mcp:apps` listener is. No `cds.mcp` key is added.

### Few fixed resources, templates for many

Each fixed resource is registered, and its `visible` called, on every request. Fixed resources
are for a handful of entry points (an index, an overview, a policy). Many documents of one kind
go behind one template, which costs the same whether it covers ten documents or ten thousand.
The docs say so; the code does not enforce a number.

## Alternatives considered

- **Reuse `mcp:apps`.** No new event, but documents are not `ui://` and have no linking tool;
  ADR 0012's rule that only linked UIs are served would have to bend.
- **Fixed resources only.** cap-okf would register one resource per concept; for large bundles
  every request pays for hundreds of registrations and `visible` calls.
- **Async `visible`.** Every request, `tools/call` included, would wait for it while the server
  is built. With few fixed resources a synchronous check is enough; per-document authorization
  belongs in a template's `read`, which may be async.
- **Our own `resources/*` handlers instead of the SDK's.** Would let visibility run only on
  list and read, but duplicates the SDK's URI matching and error mapping. Templates make it
  unnecessary.

## Consequences

- `cds.on("mcp:resources")` is part of the user-facing contract (docs/annotations.md), and
  `contractVersion` rises only for breaking changes. cap-okf keeps a contract test on its side.
- `completion/complete` handles registered templates next to `cap://` keys, in our own handler.
- Out of scope: binary content, writable resources, `subscriptions/listen`, `listChanged`,
  registrations after startup, prompts or tools from code.
