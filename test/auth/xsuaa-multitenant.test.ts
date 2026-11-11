import cds from "@sap/cds";
import { bootDemo, currentDemo } from "../helpers/demo";
import { rpc } from "../helpers/mcp";
import { XSUAA, authMatrixRow, xsuaaClaims } from "./scenario";

/**
 * Auth matrix: multitenant XSUAA. Subscribers get tokens from their own subdomain, so with
 * `cds.env.mcp.tenantHostPattern` the RFC 9728 metadata names the subscriber's authorization
 * server, derived from the host the client called (as the approuter's TENANT_HOST_PATTERN).
 * Without a match the provider's `credentials.url` stays (the shared rows check that).
 */
bootDemo();
cds.env.mcp = { ...(cds.env.mcp as object), tenantHostPattern: "^(.*)-bookshop\\." };

describe("auth matrix: multitenant XSUAA", () => {
  const { issuer } = authMatrixRow({
    kind: "xsuaa",
    credentials: { ...XSUAA, clientsecret: "test-secret" },
    claims: xsuaaClaims,
  });
  const host = { headers: { "x-forwarded-host": "acme-bookshop.cfapps.example.com" } };

  test("the metadata names the subscriber's authorization server for a subscriber's host", async () => {
    const metadata = await currentDemo().GET("/.well-known/oauth-protected-resource/mcp", host);
    expect(metadata.data).toMatchObject({
      resource: "http://acme-bookshop.cfapps.example.com/mcp",
      authorization_servers: [`https://acme.${XSUAA.uaadomain}`],
    });
  });

  test("a token the subscriber's subdomain issued is accepted", async () => {
    const token = issuer.token({
      ...xsuaaClaims("dora", []),
      iss: `https://acme.${XSUAA.uaadomain}/oauth/token`,
      zid: "acme-tenant",
      ext_attr: { enhancer: "XSUAA", zdn: "acme" },
    });
    const res = await rpc(
      currentDemo().POST,
      "anonymous",
      "tools/list",
      {},
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(200);
  });
});
