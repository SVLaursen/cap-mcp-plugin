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

/** The note demo/server.js adds through `mcp:hints` for support and admin (ADR 0014). */
const DEMO_NOTE =
  "A cancelled order that was delivered is a return: read notes://bookshop/returns-policy.md first.";

/** The caller's tools as the registry specifies them, with the demo's own tool note. */
function expectedTools(registry: ExposureRegistry, who: Parameters<typeof demoUser>[0]) {
  const user = demoUser(who);
  const staff = user.is("support") || user.is("admin");
  return registry
    .toolsFor(user)
    .map(listed)
    .map((tool) =>
      staff && tool.name === "OrdersService_Orders_cancel"
        ? { ...tool, description: `${tool.description}\n\n${DEMO_NOTE}` }
        : tool,
    );
}
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

  // Characterisation (RC1): the 2026-07-28 wire contract the SDK enforces for us today. The
  // official conformance suite has no 2026-07-28 scenarios yet, so these pin it against an SDK
  // upgrade changing it silently.
  describe("wire contract the SDK guarantees (characterisation)", () => {
    const HEADER_MISMATCH = -32020;

    test.each([
      ["a missing Mcp-Method header", "tools/list", {}, { "mcp-method": undefined }],
      ["a mismatched Mcp-Method header", "tools/list", {}, { "mcp-method": "prompts/list" }],
      [
        "a missing Mcp-Name header on tools/call",
        "tools/call",
        { name: "CatalogService_Books_get", arguments: { ID: 201 } },
        { "mcp-name": undefined },
      ],
      [
        "a missing MCP-Protocol-Version header",
        "tools/list",
        {},
        { "mcp-protocol-version": undefined },
      ],
    ])("%s is HTTP 400 with -32020 (HeaderMismatch)", async (_case, method, params, headers) => {
      const res = await rpc(demo.POST, "bob", method, params, { headers });
      expect(res.status).toBe(400);
      expect(res.message?.error?.code).toBe(HEADER_MISMATCH);
    });

    test("a request without the _meta envelope is HTTP 400 with -32602 naming the missing keys", async () => {
      const res = await listTools(demo.POST, "bob", {
        meta: {
          "io.modelcontextprotocol/protocolVersion": undefined,
          "io.modelcontextprotocol/clientCapabilities": undefined,
          "io.modelcontextprotocol/clientInfo": undefined,
        },
      });
      expect(res.status).toBe(400);
      expect(res.message?.error).toMatchObject({
        code: -32602,
        // The spec's required keys; clientInfo is a SHOULD, so it is not named.
        data: {
          envelope: {
            missing: [
              "io.modelcontextprotocol/protocolVersion",
              "io.modelcontextprotocol/clientCapabilities",
            ],
          },
        },
      });
    });

    test("clientInfo is optional in the envelope (a SHOULD in the spec)", async () => {
      const res = await listTools(demo.POST, "bob", {
        meta: { "io.modelcontextprotocol/clientInfo": undefined },
      });
      expect(res.status).toBe(200);
      expect(res.message?.result?.tools).toBeDefined();
    });

    test.each(["ping", "logging/setLevel"])(
      "%s is gone in 2026-07-28: -32601 (method not found)",
      async (method) => {
        const res = await rpc(demo.POST, "bob", method, method === "ping" ? {} : { level: "info" });
        expect(res.message?.error?.code).toBe(-32601);
      },
    );

    test("every result carries io.modelcontextprotocol/serverInfo in _meta", async () => {
      const serverInfo = { name: "@gavdi/cap-mcp", version: pkg.version };
      for (const res of [
        await rpc(demo.POST, "bob", "server/discover"),
        await listTools(demo.POST, "bob"),
        await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 201 }),
        await callTool(demo.POST, "bob", "CatalogService_Books_get", { ID: 999 }),
        await rpc(demo.POST, "bob", "resources/list"),
        await rpc(demo.POST, "bob", "resources/templates/list"),
        await rpc(demo.POST, "bob", "resources/read", {
          uri: "notes://bookshop/returns-policy.md",
        }),
        await rpc(demo.POST, "alice", "prompts/list"),
      ]) {
        expect(res.message?.result?._meta).toMatchObject({
          "io.modelcontextprotocol/serverInfo": serverInfo,
        });
      }
    });

    test("resources/read carries ttlMs and cacheScope", async () => {
      const res = await rpc(demo.POST, "bob", "resources/read", {
        uri: "notes://bookshop/returns-policy.md",
      });
      expect(res.message?.result).toEqual(
        expect.objectContaining({ ttlMs: expect.any(Number), cacheScope: expect.any(String) }),
      );
    });

    test("a call with io.modelcontextprotocol/logLevel gets no notifications/message", async () => {
      const res = await callTool(
        demo.POST,
        "bob",
        "CatalogService_Books_get",
        { ID: 201 },
        { meta: { "io.modelcontextprotocol/logLevel": "debug" } },
      );
      expect(res.message?.result?.structuredContent).toMatchObject({ ID: 201 });
      expect(String(res.body)).not.toContain("notifications/message");
    });

    test("subscriptions/listen is acknowledged with nothing subscribed, and ends", async () => {
      // listChanged is false everywhere, so the SDK honours nothing and closes gracefully.
      const res = await rpc(demo.POST, "bob", "subscriptions/listen", {
        notifications: { toolsListChanged: true, resourcesListChanged: true },
      });
      expect(res.status).toBe(200);
      const events = String(res.body)
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
      expect(events).toEqual([
        expect.objectContaining({
          method: "notifications/subscriptions/acknowledged",
          params: expect.objectContaining({ notifications: {} }),
        }),
        expect.objectContaining({ result: expect.objectContaining({ resultType: "complete" }) }),
      ]);
    });
  });

  test("two users hitting the same endpoint concurrently each get their own tool list", async () => {
    const registry = ExposureRegistry.fromModel(cds.model);
    const callers = ["alice", "bob", "carol", "alice", "bob", "carol"] as const;
    const lists = await Promise.all(callers.map((who) => listTools(demo.POST, who)));
    lists.forEach((res, i) => {
      const who = callers[i] ?? "bob";
      expect(res.message?.result?.tools).toEqual(expectedTools(registry, who));
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
      expect(list.message?.result?.tools).toEqual(expectedTools(registry, who));
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

  test("origins listed in cds.env.mcp.allowedOrigins are accepted, and only those", async () => {
    // demo/package.json lists the MCP Inspector's origin.
    expect((await listTools(demo.POST, "bob", origin("http://localhost:6274"))).status).toBe(200);
    expect((await listTools(demo.POST, "bob", origin("http://localhost:6275"))).status).toBe(403);
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
      expect(res.message?.result?.tools).toEqual(expectedTools(registry, who));
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
    // Bob's resources are the MCP App UIs of his CatalogService tools and the demo's notes from
    // code, whose topics template completes (ADR 0013); he has no prompts.
    expect(res.message?.result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      completions: {},
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
