import cds from "@sap/cds";
import pkg from "../../package.json";
import { ExposureRegistry } from "../../src/exposure-registry";
import type { ToolSpec } from "../../src/types";
import { as, bootDemo } from "../helpers/demo";
import { PROTOCOL_VERSION, callTool, listTools, rpc } from "../helpers/mcp";
import { TOOLS_TTL_MS } from "../../src/adapter";
import { demoUser } from "../helpers/tools";

/**
 * M4 — adapter: MCP 2026-07-28 over Streamable HTTP, stateless.
 */
const demo = bootDemo();

/** What tools/list publishes for a tool: the spec without the executor's back-reference. */
const listed = ({ target: _target, ...tool }: ToolSpec) => tool;
describe("protocol: stateless 2026-07-28", () => {
  test("tools/list works without any initialize handshake", async () => {
    const res = await listTools(demo.POST, "bob");
    expect(res.status).toBe(200);
    expect(res.message?.result?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "CatalogService_Books_query" })]),
    );
  });

  test("tools/call works without any initialize handshake", async () => {
    const res = await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 201 });
    expect(res.status).toBe(200);
    expect(res.message?.result).toMatchObject({
      structuredContent: { ID: 201, title: "Wuthering Heights" },
      content: [{ type: "text" }],
    });
    expect(res.message?.result?.isError).toBeUndefined();
  });

  test("no Mcp-Session-Id header is ever set", async () => {
    for (const res of [
      await listTools(demo.POST, "bob"),
      await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 201 }),
      await rpc(demo.POST, "bob", "server/discover"),
    ]) {
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  test("server/discover returns supported versions, capabilities and server identity", async () => {
    const res = await rpc(demo.POST, "bob", "server/discover");
    expect(res.message?.result).toMatchObject({
      supportedVersions: expect.arrayContaining([PROTOCOL_VERSION]),
      capabilities: { tools: { listChanged: false } },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "@gavdi/cap-mcp", version: pkg.version },
      },
    });
  });

  test("an unsupported protocol version in _meta yields UnsupportedProtocolVersion (-32022)", async () => {
    const res = await listTools(demo.POST, "bob", { version: "2099-01-01" });
    expect(res.message?.error?.code).toBe(-32022);
  });

  test("every result carries resultType 'complete' (or 'input_required' for MRTR)", async () => {
    for (const res of [
      await listTools(demo.POST, "bob"),
      await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 201 }),
      await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 999 }),
      await rpc(demo.POST, "bob", "server/discover"),
    ]) {
      expect(res.message?.result?.resultType).toBe("complete");
    }
  });

  test("list results carry ttlMs and cacheScope private (lists depend on the user)", async () => {
    for (const res of [
      await listTools(demo.POST, "bob"),
      await rpc(demo.POST, "bob", "server/discover"),
    ]) {
      expect(res.message?.result).toMatchObject({ ttlMs: TOOLS_TTL_MS, cacheScope: "private" });
    }
  });

  test("two users hitting the same endpoint concurrently each get their own tool list", async () => {
    const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
    const callers = ["alice", "bob", "carol", "alice", "bob", "carol"] as const;
    const lists = await Promise.all(callers.map((who) => listTools(demo.POST, who)));
    lists.forEach((res, i) => {
      const who = callers[i] ?? "bob";
      expect(res.message?.result?.tools).toEqual(registry.toolsFor(demoUser(who)).map(listed));
    });
  });
});

describe("protocol: older clients", () => {
  test.todo(
    "SPIKE: decide whether 2025-11-25 clients (initialize handshake) are supported, and how",
  );
});

describe("protocol: auth metadata (mocked; OAuth in protocol-auth.test.ts)", () => {
  test("wrong credentials get CAP's own login challenge (Basic for mocked auth)", async () => {
    const res = await demo.POST(
      "/mcp",
      {},
      { auth: { username: "alice", password: "wrong" }, validateStatus: () => true },
    );
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="Users"');
  });

  test("without an authorization server there is no RFC 9728 metadata to serve", async () => {
    const res = await demo.GET("/.well-known/oauth-protected-resource/mcp", {
      validateStatus: () => true,
    });
    expect(res.status).toBe(404);
  });
});

describe("protocol: mounting inside CAP", () => {
  test("/mcp lists the caller's tools from the registry, exactly as specified", async () => {
    const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
    for (const who of ["alice", "bob"] as const) {
      const res = await listTools(demo.POST, who);
      expect(res.status).toBe(200);
      expect(res.message?.result?.tools).toEqual(registry.toolsFor(demoUser(who)).map(listed));
    }
  });

  test("@mcp services keep their OData endpoints: no protocol named mcp is registered", async () => {
    // A protocol named `mcp` would make CAP treat @mcp as the protocol choice (ADR 0009).
    expect(Object.keys(cds.env.protocols ?? {})).not.toContain("mcp");
    const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
    for (const { name } of registry.spec.services) {
      const endpoints = (cds.services[name] as unknown as { endpoints: { kind: string }[] })
        .endpoints;
      expect(endpoints.map((e) => e.kind)).toContain("odata");
    }
    expect((await demo.GET("/browse/Books?$top=1", as("bob"))).status).toBe(200);
  });

  test("only implemented capabilities are advertised (tools, listChanged off)", async () => {
    const res = await rpc(demo.POST, "bob", "server/discover");
    expect(res.message?.result?.capabilities).toEqual({ tools: { listChanged: false } });
  });

  test.todo(
    "activate() leaves cds.env.cdsc untouched, so doc comments stay the app's choice (ADR 0011)",
  );
  test.todo(
    "SPIKE: mount as a CAP protocol adapter (cds.env.protocols) vs. one /mcp route behind cds.middlewares.before; record the decision as an ADR",
  );
  test.todo("cds.context.user inside a tool handler is the authenticated user (not privileged)");
  test.todo(
    "middleware added by other plugins (e.g. @sap/ams) applies to /mcp without special code",
  );
});
