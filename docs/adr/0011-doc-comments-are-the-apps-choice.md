# 0011 — Doc comments are the app's choice; the plugin does not set `cdsc.docs`

Status: accepted · 2026-11-10 (M1)

## Context

Descriptions fall back to doc comments (`/** … */`, docs/annotations.md). CAP keeps doc
comments in the CSN (as `doc`) only when the app compiles with `cds.env.cdsc.docs = true`.

A plugin can set that default: CAP merges the `cds` section of every plugin's `package.json`
into `cds.env` before the app's own config (`@sap/cds/lib/env/cds-env.js`), so the app could
still override it. But the setting is not MCP-only. With `docs` on, the compiler also emits
every doc comment as `Core.Description` in the app's OData `$metadata` (checked with
`cds.compile.to.edmx`, @sap/cds 10.2). Installing the MCP plugin would silently change the
contract of every other protocol the app serves.

## Decision

The plugin does not set `cdsc.docs`. The model reader uses `doc` when it is present and
otherwise continues down the fallback chain (`@title`, then nothing). Apps that want doc
comments as MCP descriptions set `"cdsc": { "docs": true }` themselves, as the demo does.

## Consequences

- Installing the plugin changes nothing outside `/mcp` (in the spirit of ADR 0004).
- Without the setting, doc comments are ignored and descriptions come from `@description` or
  `@title`. The M6 startup report should say so when an exposed definition has neither, so the
  missing setting is easy to spot.
- `cds add mcp` (M6) may offer to add the setting to the app's own config.
- A contract test guards that the plugin's `package.json` never sets it.
