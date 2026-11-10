import cds from "@sap/cds";
import { ExposureRegistry } from "../../src/exposure-registry";
import type { ToolSpec } from "../../src/types";
import { bootDemo } from "../helpers/demo";
import { listTools, rpc } from "../helpers/mcp";
import { demoUser } from "../helpers/tools";

/**
 * M4 — adapter: MCP 2026-07-28 over Streamable HTTP, stateless.
 */
const demo = bootDemo();

/** What tools/list publishes for a tool: the spec without the executor's back-reference. */
const listed = ({ target: _target, ...tool }: ToolSpec) => tool;
describe("protocol: stateless 2026-07-28", () => {
  test.todo("tools/list works without any initialize handshake");
  test.todo("no Mcp-Session-Id header is ever set");
  test.todo("server/discover returns supported versions, capabilities and server identity");
  test.todo("an unsupported protocol version in _meta yields UnsupportedProtocolVersion (-32022)");
  test.todo("every result carries resultType 'complete' (or 'input_required' for MRTR)");
  test.todo("list results carry ttlMs and cacheScope");
  test.todo("two users hitting the same endpoint concurrently each get their own tool list");
});

describe("protocol: older clients", () => {
  test.todo(
    "SPIKE: decide whether 2025-11-25 clients (initialize handshake) are supported, and how",
  );
});

describe("protocol: auth metadata", () => {
  test.todo("unauthenticated requests get 401 with a WWW-Authenticate resource_metadata pointer");
  test.todo("/.well-known/oauth-protected-resource serves RFC 9728 metadata");
  test.todo("no fake Dynamic Client Registration endpoint is served");
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
