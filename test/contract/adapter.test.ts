import { createMcpHandler } from "@modelcontextprotocol/server";
import { serverFactory } from "../../src/adapter";
import { registryCache } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

/** The adapter's factory over a snippet model, served by the SDK without CAP or HTTP. */
function serve(cdl: string, roles: string[]) {
  const model = compileSnippet(cdl);
  const user = { id: "someone", is: (role: string) => roles.includes(role) };
  const factory = serverFactory({
    serverInfo: { name: "test", version: "0" },
    context: () => ({ user }),
    model: () => model,
    registryFor: registryCache(),
    services: {},
    log: { error: () => undefined },
  });
  return createMcpHandler(factory);
}

async function list(handler: ReturnType<typeof serve>) {
  const res = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
          },
        },
      }),
    }),
  );
  return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
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
