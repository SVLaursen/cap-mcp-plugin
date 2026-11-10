# 0010 — One stateless SDK handler for 2026-07-28 and 2025-era clients

Status: accepted · 2026-11-10 (decided by the maintainer, after the M4 spike)

## Context

ADR 0001 targets MCP 2026-07-28, stateless. Most installed clients still speak 2025-11-25
(initialize handshake, `Mcp-Session-Id`). The spike checked SDK v2 (`@modelcontextprotocol/server`
2.4.0, `/node` 2.1.2) inside `cds.test`.

- `createMcpHandler(factory, options)` serves both eras from one endpoint. `options.legacy` is
  `'stateless'` by default: a 2025 request gets a fresh server from the same factory, no session;
  GET/DELETE answer 405. `toNodeHandler(handler)` wires it to Node/Express and forwards `req.auth`.
- Modern requests worked without `initialize` or a session: `server/discover`, `tools/list`,
  `tools/call`, with `resultType`, `ttlMs`, `cacheScope`. The SDK is strict: it requires the
  `MCP-Protocol-Version`, `Mcp-Method` (and for calls `Mcp-Name`) headers and
  `io.modelcontextprotocol/clientCapabilities` in `_meta`; an unknown version is -32022.
- 2025 `initialize` (2025-11-25, 2024-11-05), then `tools/list` / `tools/call` worked on the same
  endpoint, answered as SSE.
- `cds.context` (AsyncLocalStorage) reaches the factory and tool handlers.
- MRTR confirmation (`input_required` + `inputResponses` on retry) works for modern clients; a
  2025 stateless request cannot receive server-to-client requests, so it fails fast.
- `McpServer` advertises `tools.listChanged` by default, which we do not implement.

## Decision

- Serve both eras with `createMcpHandler(factory, { legacy: 'stateless' })` wrapped once in
  `toNodeHandler`. The factory builds a server per request from the registry for
  `cds.context.user`; each `tools/call` runs in `srv.tx` and maps errors with `errorResult` after
  rollback (docs/architecture.md).
- Advertise only what we implement (no `listChanged`).
- `@mcp.elicit` tools return a clear `isError` result to 2025-era clients: they cannot confirm.

## Consequences

- No session state anywhere, for either era (v1 finding #4).
- `test/helpers/mcp.ts` must send the headers and `_meta` the SDK requires, and parse SSE for
  the legacy era.
- `responseMode` (`json` vs `auto`) is still to choose; `json` drops progress notifications.
- If the 2025 base fades, `legacy: 'reject'` is a one-line change (would need a new ADR).
