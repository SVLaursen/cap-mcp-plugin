import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";

/**
 * Auth metadata for /mcp (ADR 0009). CAP authenticates; the plugin only tells clients how to
 * get credentials: CAP's own login challenge for basic/mocked auth, and for OAuth-based auth
 * (XSUAA, IAS) a Bearer challenge pointing at RFC 9728 protected resource metadata, which names
 * the app's authorization server. No authorization server endpoints, no fake DCR.
 */

/** Production, as CAP's protocol adapters decide it per request (lib/srv/protocols/http.js). */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.CDS_ENV === "prod";
}

/** The parts of `cds.requires.auth` the plugin reads. */
export interface AuthConfig {
  kind?: string;
  credentials?: { url?: string; uaadomain?: string };
  /** CAP: in production, services without @requires need an authenticated user unless false. */
  restrict_all_services?: boolean;
}

const OAUTH_KINDS = new Set(["jwt", "xsuaa", "ias", "jwt-auth", "xsuaa-auth", "ias-auth"]);

/** The host a request came to, and `cds.env.mcp.tenantHostPattern` (multitenant XSUAA). */
export interface TenantHost {
  host?: string;
  pattern?: RegExp;
}

/** A DNS label: what an XSUAA subdomain is, and all we put into a URL from a Host header. */
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The authorization server clients get tokens from, if the app uses OAuth-based auth: the bound
 * `credentials.url`. In a multitenant XSUAA app each subscriber logs in at its own subdomain;
 * with a `tenantHostPattern` (first capture group: the subdomain, as the approuter's
 * TENANT_HOST_PATTERN) a matching host gets `https://<subdomain>.<uaadomain>`.
 */
export function authorizationServer(
  auth: AuthConfig | undefined,
  tenant: TenantHost = {},
): string | undefined {
  if (!auth?.kind || !OAUTH_KINDS.has(auth.kind)) return undefined;
  const subdomain = tenant.host && tenant.pattern?.exec(tenant.host)?.[1];
  const domain = auth.credentials?.uaadomain;
  if (subdomain && domain && SUBDOMAIN.test(subdomain)) return `https://${subdomain}.${domain}`;
  return auth.credentials?.url;
}

/** RFC 9728: the metadata path is the resource path with the well-known prefix inserted. */
export function metadataPath(mcpPath: string): string {
  return `/.well-known/oauth-protected-resource${mcpPath}`;
}

/** The first value of a (possibly repeated, comma-separated) forwarding header. */
function forwarded(req: Request, name: string): string | undefined {
  return req.get(name)?.split(",")[0]?.trim() || undefined;
}

/**
 * The origin the client connected to. On BTP a router terminates TLS and forwards plain HTTP,
 * and CAP does not set express's `trust proxy`, so read the forwarding headers here: RFC 9728
 * clients reject a `resource` that differs from the URL they used. The values only shape the
 * URLs this same client is told about.
 */
function origin(req: Request): string {
  const proto = forwarded(req, "x-forwarded-proto") ?? req.protocol;
  return `${proto}://${host(req)}`;
}

function host(req: Request): string | undefined {
  return forwarded(req, "x-forwarded-host") ?? req.get("host");
}

/** The RFC 9728 document for /mcp, or undefined when there is no authorization server. */
export function protectedResourceMetadata(
  resource: string,
  auth: AuthConfig | undefined,
  tenant: TenantHost = {},
): Record<string, unknown> | undefined {
  const server = authorizationServer(auth, tenant);
  if (!server) return undefined;
  return { resource, authorization_servers: [server], bearer_methods_supported: ["header"] };
}

export interface AuthOptions {
  /** The /mcp path, e.g. `/mcp`. */
  path: string;
  /** `cds.requires.auth`, read per request. */
  auth(): AuthConfig | undefined;
  /** `cds.env.mcp.tenantHostPattern`, compiled; none by default. */
  tenantHostPattern?: RegExp;
}

export interface GateOptions extends AuthOptions {
  /** The caller, from cds.context. */
  user(): { is(role: string): boolean } | undefined;
}

/**
 * CAP's production default (`restrict_all_services`) lives in its protocol adapters, so the
 * service layer the executor calls never applies it. Apply it to /mcp itself, as CAP decides it
 * (lib/srv/protocols/http.js): in production, unless switched off, callers must authenticate.
 */
export function requireUser(options: GateOptions): RequestHandler {
  return (req, res, next) => {
    const restricted = isProduction() && options.auth()?.restrict_all_services !== false;
    if (restricted && !options.user()?.is("authenticated-user")) challenge(req, res, options);
    else next();
  };
}

type LoginRequest = Request & { _login?: () => unknown };

/** Ask the client to authenticate: CAP's own login (basic/mocked), else a Bearer challenge. */
export function challenge(req: Request, res: Response, options: AuthOptions): void {
  const login = (req as LoginRequest)._login;
  if (login) {
    login.call(req);
    return;
  }
  const metadata = authorizationServer(options.auth())
    ? ` resource_metadata="${origin(req)}${metadataPath(options.path)}"`
    : "";
  res.set("WWW-Authenticate", `Bearer${metadata}`).sendStatus(401);
}

const is401 = (error: unknown) => {
  const e = error as { status?: unknown; code?: unknown } | number | undefined;
  return e === 401 || (typeof e === "object" && (e?.status == 401 || e?.code == 401));
};

/** Turns CAP's `next(401)` (e.g. an invalid token in jwt-auth) into our challenge. */
export function authErrors(options: AuthOptions): ErrorRequestHandler {
  return (error, req, res, next) => (is401(error) ? challenge(req, res, options) : next(error));
}

/** GET handler for the RFC 9728 document; 404 when the app has no authorization server. */
export function metadataHandler(options: AuthOptions): RequestHandler {
  return (req, res) => {
    const metadata = protectedResourceMetadata(`${origin(req)}${options.path}`, options.auth(), {
      host: host(req),
      pattern: options.tenantHostPattern,
    });
    // Built from the request's host (and, multitenant, its subscriber): never from a cache.
    if (!metadata) res.sendStatus(404);
    else res.set("Cache-Control", "no-store").json(metadata);
  };
}

/**
 * Streamable HTTP: servers MUST validate Origin (DNS rebinding). A request without Origin (a
 * native client, a server-side bridge) passes; with one, it must be listed in
 * `cds.env.mcp.allowedOrigins`. There is no implicit "own" origin: it would have to come from the
 * Host header, which a DNS-rebinding page controls (maintainer decision, M7 conformance).
 */
export function checkOrigin(allowed: () => string[] | undefined): RequestHandler {
  return (req, res, next) => {
    const from = req.get("origin");
    if (from === undefined || allowed()?.includes(from)) return next();
    res.status(403).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: `Origin ${from} is not allowed` },
    });
  };
}
