import type { Request, Response } from "express";
import {
  authErrors,
  authorizationServer,
  challenge,
  checkOrigin,
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

  test("multitenant XSUAA: tenantHostPattern maps the request host to the subscriber's subdomain", () => {
    const xsuaa = {
      kind: "xsuaa",
      credentials: {
        url: "https://provider.authentication.eu10.example.com",
        uaadomain: "authentication.eu10.example.com",
      },
    };
    const pattern = /^(.*)-bookshop\./;
    const at = (host: string) => authorizationServer(xsuaa, { host, pattern });
    expect(at("acme-bookshop.cfapps.example.com")).toBe(
      "https://acme.authentication.eu10.example.com",
    );
    // No match, no pattern, or a subdomain that is not a DNS label: the bound url, as before.
    expect(at("bookshop.cfapps.example.com")).toBe(xsuaa.credentials.url);
    expect(at("a.b-bookshop.cfapps.example.com")).toBe(xsuaa.credentials.url);
    expect(at("evil.com/x?-bookshop.cfapps.example.com")).toBe(xsuaa.credentials.url);
    expect(authorizationServer(xsuaa, { host: "acme-bookshop.x" })).toBe(xsuaa.credentials.url);
    // Without a uaadomain (IAS) there is no subdomain URL to build.
    const ias = { kind: "ias", credentials: { url: "https://provider.accounts.example.com" } };
    expect(authorizationServer(ias, { host: "acme-bookshop.x", pattern })).toBe(
      ias.credentials.url,
    );
    expect(
      protectedResourceMetadata("https://acme-bookshop.x/mcp", xsuaa, {
        host: "acme-bookshop.x",
        pattern,
      }),
    ).toMatchObject({ authorization_servers: ["https://acme.authentication.eu10.example.com"] });
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

  test("cds.mcp.scopes are offered as scopes_supported (RFC 9728); without them, no such key", () => {
    const ias = { kind: "ias", credentials };
    expect(
      protectedResourceMetadata("https://app.example.com/mcp", ias, {}, ["read", "write"]),
    ).toEqual({
      resource: "https://app.example.com/mcp",
      authorization_servers: ["https://tenant.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
    });
    expect(protectedResourceMetadata("https://app.example.com/mcp", ias)).not.toHaveProperty(
      "scopes_supported",
    );
  });

  test("the Bearer challenge names cds.mcp.scopes in `scope` (RFC 6750); without them, as before", () => {
    const challenged = (scopes?: string[]) => {
      const headers: Record<string, string> = {};
      const res = {
        set: (name: string, value: string) => {
          headers[name] = value;
          return res;
        },
        sendStatus: () => res,
      };
      const req = {
        protocol: "https",
        get: (h: string) => (h === "host" ? "app.example.com" : undefined),
      };
      challenge(req as unknown as Request, res as unknown as Response, {
        path: "/mcp",
        auth: () => ({ kind: "xsuaa", credentials }),
        ...(scopes && { scopes }),
      });
      return headers["WWW-Authenticate"];
    };
    const metadata =
      'resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"';
    expect(challenged(["read", "write"])).toBe(`Bearer ${metadata}, scope="read write"`);
    expect(challenged()).toBe(`Bearer ${metadata}`);
  });

  test("only 401s become a challenge; every other error goes on to express unchanged", () => {
    const next = jest.fn();
    const error = { status: 500, message: "boom" };
    authErrors({ path: "/mcp", auth: () => undefined })(error, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});

describe("adapter: Origin check (DNS rebinding)", () => {
  /** The status checkOrigin answers with, or "next" when it lets the request through. */
  const verdict = (allowed: readonly string[] | undefined, origin?: string) => {
    let outcome: number | "next" = "next";
    const res = {
      status(code: number) {
        outcome = code;
        return { json: () => undefined };
      },
    };
    const req = { get: (header: string) => (header === "origin" ? origin : undefined) };
    checkOrigin(allowed)(req as Request, res as unknown as Response, () => undefined);
    return outcome;
  };

  test("a request without Origin passes; one with Origin must be listed exactly", () => {
    expect(verdict(undefined)).toBe("next");
    expect(verdict(undefined, "https://shop.com")).toBe(403);
    expect(verdict(["https://shop.com"], "https://shop.com")).toBe("next");
    // Never a prefix or substring match.
    expect(verdict(["https://shop.com"], "https://shop.co")).toBe(403);
    expect(verdict(["https://shop.com"], "https://shop.com.evil.example")).toBe(403);
  });
});
