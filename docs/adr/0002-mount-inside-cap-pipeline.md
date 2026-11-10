# 0002 — Mount MCP inside CAP's middleware pipeline

Status: accepted · refined by [0009](0009-single-mcp-route-behind-cap-middleware.md) (one route behind `cds.middlewares.before`, not a protocol adapter)

## Context

v1 mounts `/mcp` on raw Express at `bootstrap` and re-applies CAP's `before` middlewares by
hand (`mw.factory()`). Anything registered later is missed: v1.9 (PR #163) had to re-implement
`@sap/ams`'s middleware and patch `user.is` for exactly this reason.

CAP supports custom protocol adapters through `cds.env.protocols` (see
`node_modules/@sap/cds/lib/srv/protocols/index.js`); adapters are mounted per service together
with CAP's `before` middlewares (auth, context) and `@protocol` on a service selects them.

## Options for the spike

1. **Protocol adapter.** Register `mcp` in `cds.env.protocols` from the plugin's
   `package.json`, and serve services that carry `@mcp`. Pro: CAP sets up auth, context and
   other plugins' middleware. Open: CAP mounts adapters per service (e.g. `/mcp/browse`); MCP
   clients usually expect one endpoint. Can one adapter serve all services?
2. **Single route behind `cds.middlewares.before`.** Mount `/mcp` once, after CAP has built its
   middleware list (e.g. on `served`), using the same list CAP uses. Pro: one endpoint. Con:
   must mount late enough to include middleware added by other plugins.

## Decision criteria

- AMS (and any future auth plugin) applies with zero plugin code.
- `cds.context.user` in a tool handler is the authenticated caller.
- One endpoint for all exposed services is available (per-service endpoints optional).
- Works with `cds watch`, `cds serve` and `cds.test`.

Record the outcome as ADR 0009 and mark this one accepted or superseded.
