import { createMcpHandler } from "@modelcontextprotocol/server";
import { serverFactory } from "../../src/adapter";
import { registryCache } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

/** The adapter's factory over a snippet model, served by the SDK without CAP or HTTP. */
function serve(cdl: string, roles: string[], services: Record<string, unknown> = {}) {
  const model = compileSnippet(cdl);
  const user = { id: "someone", is: (role: string) => roles.includes(role) };
  const factory = serverFactory({
    serverInfo: { name: "test", version: "0" },
    context: () => ({ user }),
    model: () => model,
    registryFor: registryCache(),
    services,
    log: { error: () => undefined },
  });
  return createMcpHandler(factory);
}

function list(handler: ReturnType<typeof serve>) {
  return call(handler, "tools/list");
}

async function call(
  handler: ReturnType<typeof serve>,
  method: string,
  params: Record<string, unknown> = {},
) {
  const res = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "resources/read" && { "mcp-name": params.uri as string }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
          },
        },
      }),
    }),
  );
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  };
}

describe("adapter: server factory", () => {
  const cdl = `@mcp @requires: 'admin' service S { entity Books { key ID : Integer; } }`;

  test("a caller who can see no tool gets an empty list, not an error", async () => {
    const res = await list(serve(cdl, []));
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ tools: [], resultType: "complete" });
  });

  test("the same model lists the tools for a caller with the role", async () => {
    const res = await list(serve(cdl, ["admin"]));
    const names = (res.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["S_Books_get", "S_Books_query"]);
  });
});

describe("adapter: errors outside tools/call", () => {
  const cdl = `@mcp service S { @mcp.resource entity Authors { key ID : Integer @mcp.completion; } }`;
  /** A service whose database fails, as a broken query or connection would. */
  const failing = {
    name: "S",
    run: async () => {
      throw Object.assign(new Error("SQLITE_ERROR: no such table: S_Authors"), { code: 1 });
    },
    send: async () => undefined,
    tx: <T>(fn: (tx: unknown) => Promise<T>) => fn(failing),
  };
  const inProduction = async <T>(fn: () => Promise<T>) => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      return await fn();
    } finally {
      process.env.NODE_ENV = env;
    }
  };

  test("resources/read and completion/complete answer Internal error, without the database's text", async () => {
    const handler = serve(cdl, [], { S: failing });
    const read = await inProduction(() =>
      call(handler, "resources/read", { uri: "cap://S/Authors/1" }),
    );
    const complete = await inProduction(() =>
      call(handler, "completion/complete", {
        ref: { type: "ref/resource", uri: "cap://S/Authors/{key}" },
        argument: { name: "key", value: "1" },
      }),
    );
    for (const res of [read, complete]) {
      expect(res.error).toMatchObject({ code: -32603, message: "Internal error" });
      expect(JSON.stringify(res)).not.toMatch(/SQLITE|S_Authors/);
    }
  });

  test("a CAP refusal while completing offers no values", async () => {
    const refusing = {
      ...failing,
      run: async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403, code: "403" });
      },
      tx: <T>(fn: (tx: unknown) => Promise<T>) => fn(refusing),
    };
    const res = await call(serve(cdl, [], { S: refusing }), "completion/complete", {
      ref: { type: "ref/resource", uri: "cap://S/Authors/{key}" },
      argument: { name: "key", value: "1" },
    });
    expect(res.result?.completion).toMatchObject({ values: [], hasMore: false });
  });
});
