import { as, type DemoUser } from "./demo";

/** The protocol version v2 targets first. See docs/mcp-spec-notes.md. */
export const PROTOCOL_VERSION = "2026-07-28";

type Poster = (
  url: string,
  data: unknown,
  config: ReturnType<typeof as> & { headers?: Record<string, string> },
) => Promise<{ status: number; data: unknown; headers: Record<string, unknown> }>;

let nextId = 1;

/**
 * Send one raw JSON-RPC request to the demo's /mcp endpoint as a demo user.
 *
 * Under the 2026-07-28 spec every request is self-contained: no initialize handshake, no
 * session header. The protocol version travels in `_meta` and the method in `Mcp-Method`.
 * Use this for protocol-level assertions (status codes, headers, error codes). For
 * feature-level tests prefer `callTool` / `listTools` below.
 *
 * Note: the exact header and _meta key names must be checked against the spec and the SDK in
 * milestone M4 (docs/backlog.md). Adjust here, once, if they differ.
 */
export async function rpc(
  post: Poster,
  user: DemoUser,
  method: string,
  params: Record<string, unknown> = {},
) {
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION },
    },
  };
  return post("/mcp", body, {
    ...as(user),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    },
  });
}

export async function listTools(post: Poster, user: DemoUser) {
  const res = await rpc(post, user, "tools/list");
  return res;
}

export async function callTool(
  post: Poster,
  user: DemoUser,
  name: string,
  args: Record<string, unknown> = {},
) {
  return rpc(post, user, "tools/call", { name, arguments: args });
}
