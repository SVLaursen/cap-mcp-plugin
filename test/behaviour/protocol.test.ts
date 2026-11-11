import http from "node:http";
import cds from "@sap/cds";
import pkg from "../../package.json";
import { ExposureRegistry } from "../../src/exposure-registry";
import type { ToolSpec } from "../../src/types";
import type { Request } from "express";
import { DEMO_DIR, as, bootDemo, inProduction } from "../helpers/demo";
import {
  LEGACY_VERSION,
  PROTOCOL_VERSION,
  callTool,
  legacyInitialize,
  legacyRpc,
  listTools,
  rpc,
} from "../helpers/mcp";
import { TOOLS_TTL_MS } from "../../src/adapter";
import { demoUser } from "../helpers/tools";

/**
 * M4 — adapter: MCP 2026-07-28 over Streamable HTTP, stateless.
 */
const demo = bootDemo();

/** Stands in for a plugin like @sap/ams: grants the roles named in a test header. */
cds.middlewares.add(function grantFromHeader(req: Request, _res: unknown, next: () => void) {
  const roles = req.headers["x-test-grant"];
  const user = cds.context?.user as (cds.User & { roles: Record<string, 1> }) | undefined;
  if (typeof roles === "string" && user) {
    for (const role of roles.split(",")) user.roles[role] = 1;
  }
  next();
});

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

  test("a malformed body is a JSON-RPC parse error (-32700), never an HTML page", async () => {
    const res = await demo.POST("/mcp", "{not json", {
      ...as("bob"),
      responseType: "text",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
      },
    });
    expect(String(res.headers["content-type"])).not.toContain("text/html");
    expect(JSON.parse(res.data as string).error.code).toBe(-32700);
  });

  test("large arguments (over 100 kB) still get a JSON-RPC answer", async () => {
    const res = await callTool(demo.POST, "bob", "CatalogService_Books_query", {
      q: "x".repeat(200_000),
    });
    expect(res.status).toBe(200);
    expect(res.message?.result?.structuredContent).toEqual({ rows: [], total: 0 });
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
    const registry = ExposureRegistry.fromModel(cds.model);
    const callers = ["alice", "bob", "carol", "alice", "bob", "carol"] as const;
    const lists = await Promise.all(callers.map((who) => listTools(demo.POST, who)));
    lists.forEach((res, i) => {
      const who = callers[i] ?? "bob";
      expect(res.message?.result?.tools).toEqual(registry.toolsFor(demoUser(who)).map(listed));
    });
  });
});

describe("protocol: older clients (2025-era, stateless; ADR 0010)", () => {
  test("initialize is answered without a session", async () => {
    for (const version of [LEGACY_VERSION, "2024-11-05"]) {
      const res = await legacyInitialize(demo.POST, "bob", version);
      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeUndefined();
      expect(res.message?.result).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "@gavdi/cap-mcp" },
      });
    }
  });

  test("tools/list and tools/call work as standalone requests, per user", async () => {
    const registry = ExposureRegistry.fromModel(cds.model);
    for (const who of ["alice", "bob"] as const) {
      const list = await legacyRpc(demo.POST, who, "tools/list");
      expect(list.headers["mcp-session-id"]).toBeUndefined();
      expect(list.message?.result?.tools).toEqual(registry.toolsFor(demoUser(who)).map(listed));
    }
    const call = await legacyRpc(demo.POST, "bob", "tools/call", {
      name: "CatalogService_Books_get",
      arguments: { ID: 201 },
    });
    expect(call.message?.result).toMatchObject({
      structuredContent: { ID: 201, title: "Wuthering Heights" },
    });
  });

  test("GET and DELETE on /mcp answer 405: there is no session stream to open or close", async () => {
    expect((await demo.GET("/mcp", as("bob"))).status).toBe(405);
    expect((await demo.DELETE("/mcp", as("bob"))).status).toBe(405);
  });

  test("@mcp.elicit tools give a clear isError: a 2025-era client cannot confirm", async () => {
    const res = await legacyRpc(demo.POST, "bob", "tools/call", {
      name: "OrdersService_Orders_cancel",
      arguments: { ID: "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a01", reason: "changed my mind" },
    });
    expect(res.message?.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: expect.stringMatching(/confirmation.*2026-07-28/),
        },
      },
    });
  });
});

describe("protocol: Origin (DNS rebinding protection)", () => {
  const origin = (value: string) => ({ headers: { origin: value } });

  test("a request from a foreign Origin is refused with 403", async () => {
    const res = await listTools(demo.POST, "bob", origin("http://evil.example"));
    expect(res.status).toBe(403);
  });

  test("a request without Origin (native clients, bridges) is fine", async () => {
    expect((await listTools(demo.POST, "bob")).status).toBe(200);
  });

  test("DNS rebinding: Host and Origin both the attacker's name are refused with 403", async () => {
    // What a page on evil.example.com sends once its name resolves to this server. Raw HTTP:
    // the test client would not send our Host header.
    const url = new URL((demo as unknown as { url: string }).url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: "evil.example.com",
            origin: "http://evil.example.com",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_VERSION,
            capabilities: {},
            clientInfo: { name: "rebinding", version: "1" },
          },
        }),
      );
    });
    expect(status).toBe(403);
  });

  test("the app's own origin is not allowed implicitly: browser clients must be listed", async () => {
    const own = (demo as unknown as { url: string }).url;
    expect((await listTools(demo.POST, "bob", origin(own))).status).toBe(403);
  });

  test("origins listed in cds.env.mcp.allowedOrigins are accepted", async () => {
    const env = cds.env as unknown as { mcp?: { allowedOrigins?: string[] } };
    const saved = env.mcp;
    env.mcp = { ...saved, allowedOrigins: ["http://localhost:6274"] };
    try {
      expect((await listTools(demo.POST, "bob", origin("http://localhost:6274"))).status).toBe(200);
      expect((await listTools(demo.POST, "bob", origin("http://localhost:6275"))).status).toBe(403);
    } finally {
      env.mcp = saved;
    }
  });

  test("allowedOrigins that is not a list allows nothing extra (never a substring match)", async () => {
    const env = cds.env as unknown as { mcp?: { allowedOrigins?: unknown } };
    const saved = env.mcp;
    env.mcp = { ...saved, allowedOrigins: "https://shop.com,https://b.com" };
    try {
      expect((await listTools(demo.POST, "bob", origin("https://shop.co"))).status).toBe(403);
      expect((await listTools(demo.POST, "bob", origin("https://shop.com"))).status).toBe(403);
    } finally {
      env.mcp = saved;
    }
  });
});

describe("protocol: production default (CAP's restrict_all_services)", () => {
  test("in production, anonymous callers must log in, as CAP's protocol adapters demand", async () => {
    const res = await inProduction(() => listTools(demo.POST, "anonymous"), {
      restrict_all_services: true,
    });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="Users"');
    // Authenticated users are unaffected.
    const bob = await inProduction(() => listTools(demo.POST, "bob"), {
      restrict_all_services: true,
    });
    expect(bob.status).toBe(200);
  });

  test("restrict_all_services: false (mocked auth's default) lets anonymous callers in, as CAP does", async () => {
    const res = await inProduction(() => listTools(demo.POST, "anonymous"), {
      restrict_all_services: false,
    });
    expect(res.status).toBe(200);
  });

  test("outside production, anonymous callers see only what CAP lets anonymous users reach", async () => {
    const registry = ExposureRegistry.fromModel(cds.model);
    const res = await listTools(demo.POST, "anonymous");
    expect(res.message?.result?.tools).toEqual(registry.toolsFor(cds.User.anonymous).map(listed));
    expect(JSON.stringify(res.message?.result)).not.toContain("AdminService");
  });
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
    const registry = ExposureRegistry.fromModel(cds.model);
    for (const who of ["alice", "bob"] as const) {
      const res = await listTools(demo.POST, who);
      expect(res.status).toBe(200);
      expect(res.message?.result?.tools).toEqual(registry.toolsFor(demoUser(who)).map(listed));
    }
  });

  test("@mcp services keep their OData endpoints: no protocol named mcp is registered", async () => {
    // A protocol named `mcp` would make CAP treat @mcp as the protocol choice (ADR 0009).
    expect(Object.keys(cds.env.protocols ?? {})).not.toContain("mcp");
    const registry = ExposureRegistry.fromModel(cds.model);
    for (const { name } of registry.spec.services) {
      const endpoints = (cds.services[name] as unknown as { endpoints: { kind: string }[] })
        .endpoints;
      expect(endpoints.map((e) => e.kind)).toContain("odata");
    }
    expect((await demo.GET("/browse/Books?$top=1", as("bob"))).status).toBe(200);
  });

  test("only implemented capabilities are advertised (tools, listChanged off)", async () => {
    const res = await rpc(demo.POST, "bob", "server/discover");
    // Bob's resources are the MCP App UIs of his CatalogService tools; he has no prompts.
    expect(res.message?.result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
  });

  test("activate() leaves cds.env.cdsc untouched, so doc comments stay the app's choice (ADR 0011)", () => {
    // A fresh env for the demo is read without any plugin activation.
    const fresh = cds.env.for("cds", DEMO_DIR) as unknown as { cdsc: unknown };
    expect(cds.env.cdsc).toEqual(fresh.cdsc);
  });
  test("cds.context.user inside a tool handler is the authenticated user (not privileged)", async () => {
    // @restrict where createdBy = $user: a privileged or technical user would see every order.
    for (const who of ["bob", "carol"] as const) {
      const odata = await demo.GET("/orders/Orders?$select=orderNo&$orderby=orderNo", as(who));
      const mcp = await callTool(demo.POST, who, "OrdersService_Orders_query", {
        select: ["orderNo"],
        orderby: [{ field: "orderNo" }],
      });
      const orderNos = odata.data.value.map((o: { orderNo: string }) => ({ orderNo: o.orderNo }));
      expect(mcp.message?.result?.structuredContent).toMatchObject({ rows: orderNos });
      expect(orderNos).toHaveLength(who === "bob" ? 1 : 2);
    }
  });

  test("middleware added by other plugins (e.g. @sap/ams) applies to /mcp without special code", async () => {
    // grantFromHeader (added with cds.middlewares.add, as @sap/ams adds its own) grants roles.
    const plain = await listTools(demo.POST, "bob");
    const granted = await listTools(demo.POST, "bob", { headers: { "x-test-grant": "admin" } });
    const names = (res: typeof plain) =>
      (res.message?.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names(plain)).not.toContain("AdminService_query");
    expect(names(granted)).toContain("AdminService_query");
  });
});
