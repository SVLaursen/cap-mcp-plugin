import {
  authErrors,
  authorizationServer,
  metadataPath,
  protectedResourceMetadata,
} from "../../src/adapter/auth";

describe("adapter: auth metadata", () => {
  const credentials = { url: "https://tenant.example.com" };

  test("XSUAA, JWT and IAS point clients at the bound authorization server", () => {
    for (const kind of ["xsuaa", "jwt", "ias"]) {
      expect(authorizationServer({ kind, credentials })).toBe("https://tenant.example.com");
    }
  });

  test("basic, mocked and custom auth have no authorization server (CAP's own login applies)", () => {
    for (const kind of ["basic", "mocked", "dummy", "custom"]) {
      expect(authorizationServer({ kind, credentials })).toBeUndefined();
    }
    expect(authorizationServer({ kind: "ias" })).toBeUndefined();
    expect(authorizationServer(undefined)).toBeUndefined();
  });

  test("the metadata path inserts the well-known prefix before the resource path (RFC 9728)", () => {
    expect(metadataPath("/mcp")).toBe("/.well-known/oauth-protected-resource/mcp");
    expect(
      protectedResourceMetadata("https://app.example.com/mcp", { kind: "ias", credentials }),
    ).toEqual({
      resource: "https://app.example.com/mcp",
      authorization_servers: ["https://tenant.example.com"],
      bearer_methods_supported: ["header"],
    });
  });

  test("only 401s become a challenge; every other error goes on to express unchanged", () => {
    const next = jest.fn();
    const error = { status: 500, message: "boom" };
    authErrors({ path: "/mcp", auth: () => undefined })(error, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
