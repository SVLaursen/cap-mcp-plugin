import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";

/**
 * RC4 — `cds.mcp.scopes` end to end: the demo with a stub XSUAA binding (as in
 * protocol-auth.test.ts, which proves that without the key nothing changes) and two scopes.
 */
const demo = bootDemo();
cds.env.requires.auth = {
  kind: "xsuaa",
  credentials: {
    clientid: "sb-demo",
    clientsecret: "not-a-secret",
    url: "https://demo.authentication.example.com",
    uaadomain: "authentication.example.com",
    xsappname: "demo",
  },
} as unknown as typeof cds.env.requires.auth;
const env = cds.env as unknown as { mcp?: Record<string, unknown> };
env.mcp = { ...env.mcp, scopes: ["demo.read", "demo.write"] };

const anyone = { validateStatus: () => true };

test("the challenge asks for the configured scopes", async () => {
  const res = await demo.POST("/mcp", {}, { ...anyone, headers: { authorization: "Bearer x" } });
  expect(res.status).toBe(401);
  expect(res.headers["www-authenticate"]).toMatch(/, scope="demo\.read demo\.write"$/);
});

test("the RFC 9728 metadata lists them as scopes_supported", async () => {
  const res = await demo.GET("/.well-known/oauth-protected-resource/mcp", anyone);
  expect(res.data.scopes_supported).toEqual(["demo.read", "demo.write"]);
});
