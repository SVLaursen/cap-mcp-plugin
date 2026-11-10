import type { Request, Response } from "express";

/**
 * adapter (milestone M4)
 *
 * The MCP protocol edge: JSON-RPC over Streamable HTTP (and stdio, M6), built on the MCP
 * TypeScript SDK v2 (@modelcontextprotocol/server), which implements the 2026-07-28 spec.
 *
 * Contract:
 * - Stateless: no sessions, no Mcp-Session-Id, no per-connection tool lists. Each request runs
 *   in its own cds.context set up by CAP's middleware (auth included).
 * - `server/discover` advertises versions, capabilities and identity. Support for 2025-11-25
 *   clients is decided by the spike in M4 (see docs/backlog.md).
 * - Auth metadata: RFC 9728 protected resource metadata; Client ID Metadata Documents; no fake DCR.
 * - Confirmation/elicitation uses the Multi Round-Trip Request pattern (input_required).
 *
 * Until M4 lands, the plugin answers every MCP request with a JSON-RPC error so the demo app
 * still boots and the behaviour tests have a stable baseline.
 */
export function notImplementedHandler(_req: Request, res: Response): void {
  res.status(501).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "cap-mcp v2: MCP adapter not implemented yet (milestone M4)" },
  });
}
