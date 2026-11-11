import cds from "@sap/cds";
import { currentDemo, inProduction } from "../helpers/demo";
import { createIssuer, type Issuer } from "../helpers/issuer";
import { rpc } from "../helpers/mcp";

/**
 * One row of the auth matrix (v1.9 PR #163 parity). Call at the top level of a test file, right
 * after bootDemo(): it binds the demo to `auth` (with a local issuer, so @sap/xssec validates
 * real tokens) before CAP builds its auth middleware, and runs the same scenario for every row:
 *
 * - a token with the admin role lists AdminService's tools and calls a read tool;
 * - a token without roles sees no AdminService tools and calls a read tool;
 * - a token from another issuer, and (in production) no token, get 401 with the Bearer
 *   `resource_metadata` challenge; the RFC 9728 metadata names the binding's `url`.
 */
export interface Row {
  kind: "xsuaa" | "ias";
  credentials: Record<string, unknown>;
  /** Claims of a user token with the given roles, for this kind of binding. */
  claims(user: string, roles: string[]): Record<string, unknown>;
}

export function authMatrixRow(row: Row): { issuer: Issuer } {
  const issuer = createIssuer();
  cds.env.requires.auth = {
    kind: row.kind,
    credentials: row.credentials,
    config: issuer.config,
  } as unknown as typeof cds.env.requires.auth;

  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const names = async (token: string) => {
    const res = await rpc(currentDemo().POST, "anonymous", "tools/list", {}, bearer(token));
    expect(res.status).toBe(200);
    return (res.message?.result?.tools as { name: string }[]).map((t) => t.name);
  };
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await rpc(
      currentDemo().POST,
      "anonymous",
      "tools/call",
      { name, arguments: args },
      bearer(token),
    );
    return res.message?.result;
  };
  const readBook = (token: string) => call(token, "CatalogService_Books_get", { ID: 201 });

  test("a token with the admin role reaches AdminService and calls a read tool", async () => {
    const token = issuer.token(row.claims("alice", ["admin"]));
    expect(await names(token)).toEqual(
      expect.arrayContaining(["AdminService_query", "CatalogService_Books_get"]),
    );
    expect(await readBook(token)).toMatchObject({ structuredContent: { ID: 201 } });
    // CAP's own @requires check sees the role too.
    const authors = await call(token, "AdminService_get", {
      entity: "AdminService.Authors",
      key: { ID: 101 },
    });
    expect(authors).toMatchObject({ structuredContent: { ID: 101 } });
  });

  test("a token without roles sees no AdminService tools and calls a read tool", async () => {
    const token = issuer.token(row.claims("bob", []));
    const listed = await names(token);
    expect(listed).toContain("CatalogService_Books_get");
    expect(listed.filter((n) => n.startsWith("AdminService_"))).toEqual([]);
    expect(await readBook(token)).toMatchObject({ structuredContent: { ID: 201 } });
  });

  test("a token from another issuer, or none in production, gets the Bearer challenge", async () => {
    const forged = createIssuer().token(row.claims("alice", ["admin"]));
    const wrong = await rpc(currentDemo().POST, "anonymous", "tools/list", {}, bearer(forged));
    const none = await inProduction(() => rpc(currentDemo().POST, "anonymous", "tools/list"));
    const url = (currentDemo() as unknown as { url: string }).url;
    for (const res of [wrong, none]) {
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(
        `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
    const metadata = await currentDemo().GET("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.data).toMatchObject({ authorization_servers: [row.credentials.url] });
  });

  return { issuer };
}

/** The XSUAA binding of the demo app (xsappname `demo`); add a secret or a certificate. */
export const XSUAA = {
  clientid: "sb-demo!t1",
  xsappname: "demo!t1",
  url: "https://provider.authentication.example.com",
  uaadomain: "authentication.example.com",
  identityzone: "provider",
  tenantid: "provider-tenant",
};

/** A user token as XSUAA issues it: scopes prefixed with the xsappname. */
export function xsuaaClaims(user: string, roles: string[]): Record<string, unknown> {
  return {
    iss: `${XSUAA.url}/oauth/token`,
    zid: XSUAA.tenantid,
    client_id: XSUAA.clientid,
    cid: XSUAA.clientid,
    azp: XSUAA.clientid,
    aud: [XSUAA.clientid, XSUAA.xsappname],
    grant_type: "authorization_code",
    user_name: user,
    origin: "sap.default",
    scope: ["openid", ...roles.map((r) => `${XSUAA.xsappname}.${r}`)],
    ext_attr: { enhancer: "XSUAA", zdn: XSUAA.identityzone },
  };
}

/** The IAS binding of the demo app; add a secret or a certificate. */
export const IAS = {
  clientid: "ias-demo-client",
  url: "https://provider.accounts.example.com",
  domains: ["accounts.example.com"],
  app_tid: "provider-tenant",
};

/** A user token as IAS issues it: roles (AMS-less) come from `ias_apis`. */
export function iasClaims(user: string, roles: string[]): Record<string, unknown> {
  return {
    iss: IAS.url,
    sub: `user-${user}`,
    aud: [IAS.clientid],
    azp: IAS.clientid,
    app_tid: IAS.app_tid,
    user_uuid: `uuid-${user}`,
    email: `${user}@example.com`,
    ias_apis: roles,
  };
}
