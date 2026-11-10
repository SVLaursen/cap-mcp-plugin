import { bootDemo, inProduction } from "../helpers/demo";
import { callTool, listTools } from "../helpers/mcp";

/**
 * M4/M5 — auth parity with v1.9 (Willem's PR #163). Each row runs the same small scenario:
 * an authenticated user lists tools and calls one read tool; an unauthenticated request gets 401.
 *
 * mocked runs against the demo app directly. The XSUAA/IAS rows need credentials or a local
 * token issuer; see docs/testing.md for how to stub the issuer without mocking @sap/cds.
 */
const demo = bootDemo();

describe("auth matrix", () => {
  test("mocked users (alice, bob, carol)", async () => {
    for (const who of ["alice", "bob", "carol"] as const) {
      const list = await listTools(demo.POST, who);
      expect(list.status).toBe(200);
      const names = (list.message?.result?.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("CatalogService_Books_get");
      expect(names.includes("AdminService_query")).toBe(who === "alice");
      const call = await callTool(demo.POST, who, "CatalogService_Books_get", { ID: 201 });
      expect(call.message?.result).toMatchObject({ structuredContent: { ID: 201 } });
    }
    // Wrong credentials, and (in production) none at all, get CAP's login challenge.
    const wrong = await demo.POST(
      "/mcp",
      {},
      { auth: { username: "bob", password: "nope" }, validateStatus: () => true },
    );
    const none = await inProduction(() => listTools(demo.POST, "anonymous"), {
      restrict_all_services: true,
    });
    for (const res of [wrong, none]) {
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Basic realm="Users"');
    }
  });
  test.todo("XSUAA with client secret");
  test.todo("XSUAA with X.509 certificate");
  test.todo("IAS with client secret");
  test.todo("IAS with X.509 certificate");
  test.todo("IAS only, roles from @sap/ams policies (user.is reflects AMS roles)");
});
