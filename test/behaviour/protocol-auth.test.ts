import cds from "@sap/cds";
import { bootDemo, inProduction } from "../helpers/demo";
import { rpc } from "../helpers/mcp";

/**
 * M4 — auth metadata for OAuth-based auth (XSUAA here; IAS works the same way). The demo boots
 * with a stub XSUAA binding: @sap/xssec validates tokens for real, so a bogus token is refused
 * by CAP's own jwt-auth, and anonymous requests pass CAP's middleware as anonymous.
 */
const demo = bootDemo();
const AUTHORIZATION_SERVER = "https://demo.authentication.example.com";
cds.env.requires.auth = {
  kind: "xsuaa",
  credentials: {
    clientid: "sb-demo",
    clientsecret: "not-a-secret",
    url: AUTHORIZATION_SERVER,
    uaadomain: "authentication.example.com",
    xsappname: "demo",
  },
} as unknown as typeof cds.env.requires.auth;

/** The app's own origin, as the client sees it. */
const url = () => (demo as unknown as { url: string }).url;
const metadataUrl = () => `${url()}/.well-known/oauth-protected-resource/mcp`;
const anyone = { validateStatus: () => true };

describe("protocol: auth metadata (OAuth)", () => {
  test("a request with an invalid token gets 401 with a WWW-Authenticate resource_metadata pointer", async () => {
    const res = await demo.POST(
      "/mcp",
      {},
      { ...anyone, headers: { authorization: "Bearer not-a-jwt" } },
    );
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${metadataUrl()}"`);
  });

  test("in production, a request without a token gets 401 with the resource_metadata pointer", async () => {
    const res = await inProduction(() => rpc(demo.POST, "anonymous", "tools/list"));
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${metadataUrl()}"`);
  });

  test("the metadata stays public in production", async () => {
    const status = await inProduction(async () => {
      const res = await demo.GET("/.well-known/oauth-protected-resource/mcp", anyone);
      return res.status;
    });
    expect(status).toBe(200);
  });

  test("/.well-known/oauth-protected-resource/mcp serves RFC 9728 metadata, unauthenticated", async () => {
    const res = await demo.GET("/.well-known/oauth-protected-resource/mcp", anyone);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      resource: `${url()}/mcp`,
      authorization_servers: [AUTHORIZATION_SERVER],
      bearer_methods_supported: ["header"],
    });
  });

  test("behind a TLS-terminating proxy (BTP), URLs use the client's scheme and host", async () => {
    const headers = { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" };
    const metadata = await demo.GET("/.well-known/oauth-protected-resource/mcp", {
      ...anyone,
      headers,
    });
    expect(metadata.data.resource).toBe("https://app.example.com/mcp");
    const challenge = await demo.POST(
      "/mcp",
      {},
      { ...anyone, headers: { ...headers, authorization: "Bearer not-a-jwt" } },
    );
    expect(challenge.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("no fake Dynamic Client Registration or authorization server endpoints are served", async () => {
    expect((await demo.GET("/.well-known/oauth-authorization-server", anyone)).status).toBe(404);
    expect((await demo.GET("/.well-known/openid-configuration", anyone)).status).toBe(404);
    expect((await demo.POST("/register", {}, anyone)).status).toBe(404);
  });

  test("the challenge does not get in the way of anonymous discovery outside production", async () => {
    // CAP lets anonymous callers reach services without @requires outside production.
    const res = await rpc(demo.POST, "anonymous", "server/discover");
    expect(res.status).toBe(200);
  });
});
