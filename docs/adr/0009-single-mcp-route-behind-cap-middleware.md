# 0009 — One `/mcp` route behind CAP's middlewares, for all services

Status: accepted · 2026-11-10 (decided by the maintainer, after the M4 spike) · refines 0002

## Context

ADR 0002 asked how to sit inside CAP's pipeline: as a CAP protocol adapter (`cds.env.protocols`)
or as one route behind `cds.middlewares.before`, and whether to offer one endpoint for all
services or one per service. The spike tried both in the demo (cds 10.2.2, `cds.test`).

- **Protocol adapter named `mcp`** (`lib/srv/protocols/index.js:50-139`): CAP treats any `@<kind>`
  annotation of a registered protocol as the service's protocol choice. Every `@mcp` service then
  got only the MCP endpoint and lost OData (`/browse/Books` returned 404), and with an absolute
  `@path` the adapter took over the OData path. Another name avoids that, but then every service
  needs `@protocol`, or the plugin must rewrite the model; the adapter base class is internal
  (`http.js`, "should stay internal"); a JWT `next(401)` goes to CAP's error handler, so we
  cannot add the Bearer `resource_metadata` challenge; and RFC 9728 routes are outside its path.
- **Route on `served` behind `cds.middlewares.before`** (`context`, `trace`, `auth`, `ctx_model`):
  `cds.context.user` was the authenticated user (alice admin, bob no roles, anonymous),
  `cds.context.http.req` the request, and OData stayed untouched. Middleware added with
  `cds.middlewares.add` before serving is in the same array, so plugins like `@sap/ams` apply.

## Decision

- `activate(cds)` mounts **one `/mcp` route** (path from `cds.env.mcp.path`) on `cds.on('served')`,
  behind `cds.middlewares.before`, then `the MCP handler (ADR 0010).
- **One endpoint for all `@mcp` services.** `tools/list` shows the tools of every service the
  caller can reach (registry, per-user); cross-service name clashes are already diagnostics.
  Per-service sub-paths (`/mcp/<service>`) can be added later on the same handler.
- The plugin owns its 401: `WWW-Authenticate: Bearer resource_metadata=…` for JWT/IAS, CAP's
  `req._login` for basic/mocked auth; and serves `/.well-known/oauth-protected-resource/mcp`
  (path-inserted, RFC 9728) unauthenticated at the app root.
- CAP's production default (`restrict_all_services`: `authenticated-user` on services without
  `@requires`) lives only in its protocol adapters, so `/mcp` requires an authenticated user in
  production itself.
- The registry is keyed by `cds.context.model ?? cds.model` (`ctx.model` is only set with
  extensibility/toggles and a tenant or features).

## Consequences

- No protocol named `mcp` may ever be registered; a test guards that `@mcp` services keep OData.
- Service-level `@requires` failures surface from the service layer as CAP 401/403 errors (tool
  errors), not as pre-dispatch HTTP errors; the registry hides those tools anyway.
- Middleware added after `served` is missed, as it would be for a protocol adapter.
