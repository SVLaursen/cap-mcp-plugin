import { as, type DemoUser } from "./demo";

/** The protocol version v2 targets first. See docs/mcp-spec-notes.md. */
export const PROTOCOL_VERSION = "2026-07-28";
/** The 2025-era version older clients speak (initialize handshake; ADR 0010). */
export const LEGACY_VERSION = "2025-11-25";

const CLIENT_INFO = { name: "cap-mcp-tests", version: "0.0.0" };

/** Who sends a request: a demo user, or nobody (no credentials at all). */
export type Caller = DemoUser | "anonymous";

export interface HttpResponse {
  status: number;
  data: unknown;
  headers: Record<string, unknown>;
}

type Poster = (
  url: string,
  data: unknown,
  config: {
    headers?: Record<string, string>;
    validateStatus?: () => boolean;
    responseType?: "text";
  },
) => Promise<HttpResponse>;

/** A JSON-RPC response, whichever way it came (JSON body or one SSE `message` event). */
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcResponse {
  status: number;
  headers: Record<string, unknown>;
  /** The JSON-RPC response; undefined if the HTTP response carried none (401, 405, …). */
  message?: RpcMessage;
}

export interface RpcOptions {
  /** `MCP-Protocol-Version` header and `_meta` version; defaults to PROTOCOL_VERSION. */
  version?: string;
  /** Extra or overriding HTTP headers (a header set to undefined is dropped). */
  headers?: Record<string, string | undefined>;
  /** Extra `_meta` entries (a key set to undefined is dropped). */
  meta?: Record<string, unknown>;
  /** The endpoint, if not /mcp (cds.env.mcp.path). */
  path?: string;
}

let nextId = 1;

function credentials(caller: Caller) {
  return caller === "anonymous" ? { validateStatus: () => true } : as(caller);
}

/** The JSON-RPC message in a response: the JSON body, or the last SSE `data:` event. */
export function messageOf(res: HttpResponse): RpcMessage | undefined {
  const data = res.data;
  const type = String(res.headers["content-type"] ?? "");
  if (typeof data === "string" && type.startsWith("application/json")) {
    return JSON.parse(data) as RpcMessage;
  }
  if (typeof data === "string" && type.startsWith("text/event-stream")) {
    const events = data
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = events.at(-1);
    return last === undefined ? undefined : (JSON.parse(last) as RpcMessage);
  }
  if (data && typeof data === "object" && "jsonrpc" in data) return data as RpcMessage;
  return undefined;
}

function without<T>(record: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as Record<
    string,
    T
  >;
}

/** The value a `Mcp-Name` header mirrors for this method (SEP-2243), if any. */
function nameOf(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "tools/call" || method === "prompts/get") return params.name as string;
  if (method === "resources/read") return params.uri as string;
  return undefined;
}

/**
 * Send one 2026-07-28 JSON-RPC request to /mcp: no initialize handshake, no session. The SDK
 * requires the `MCP-Protocol-Version` and `Mcp-Method` headers (and `Mcp-Name` for calls), and
 * the protocol version, client capabilities and client info in `_meta` (ADR 0010).
 * Use this for protocol-level assertions; feature tests use `callTool` / `listTools`.
 */
export async function rpc(
  post: Poster,
  caller: Caller,
  method: string,
  params: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<RpcResponse> {
  const version = options.version ?? PROTOCOL_VERSION;
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: without({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        ...options.meta,
      }),
    },
  };
  const name = nameOf(method, params);
  const res = await post(options.path ?? "/mcp", body, {
    ...credentials(caller),
    // Parsed here: the body is JSON or an SSE stream, depending on era and response mode.
    responseType: "text",
    headers: without({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      "mcp-method": method,
      "mcp-name": name,
      ...options.headers,
    }),
  });
  return { status: res.status, headers: res.headers, message: messageOf(res) };
}

/**
 * Send one 2025-era JSON-RPC request (no `_meta` envelope, no `Mcp-Method`), as an older client
 * does. Stateless: there is no session, so every request stands alone, `initialize` included.
 * The SDK answers these as SSE; `message` is the parsed event.
 */
export async function legacyRpc(
  post: Poster,
  caller: Caller,
  method: string,
  params: Record<string, unknown> = {},
  options: { version?: string; notification?: boolean } = {},
): Promise<RpcResponse> {
  const version = options.version ?? LEGACY_VERSION;
  const body = {
    jsonrpc: "2.0",
    ...(options.notification ? {} : { id: nextId++ }),
    method,
    params,
  };
  const res = await post("/mcp", body, {
    ...credentials(caller),
    // Parsed here: the body is JSON or an SSE stream, depending on era and response mode.
    responseType: "text",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // initialize itself is sent without a version header; later requests carry the agreed one.
      ...(method === "initialize" ? {} : { "mcp-protocol-version": version }),
    },
  });
  return { status: res.status, headers: res.headers, message: messageOf(res) };
}

/** The 2025-era `initialize` request, as an older client sends it. */
export function legacyInitialize(post: Poster, caller: Caller, version = LEGACY_VERSION) {
  return legacyRpc(post, caller, "initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
}

export async function listTools(post: Poster, caller: Caller, options: RpcOptions = {}) {
  return rpc(post, caller, "tools/list", {}, options);
}

export async function callTool(
  post: Poster,
  caller: Caller,
  name: string,
  args: Record<string, unknown> = {},
  options: RpcOptions = {},
) {
  return rpc(post, caller, "tools/call", { name, arguments: args }, options);
}
