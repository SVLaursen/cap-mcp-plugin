import { readFileSync } from "node:fs";
import path from "node:path";
import type { Application, RequestHandler } from "express";
import { mcpHandler, type RequestContext } from "./adapter";
import { setUpApps } from "./adapter/apps";
import {
  authErrors,
  checkOrigin,
  metadataHandler,
  metadataPath,
  requireUser,
  type AuthConfig,
} from "./adapter/auth";
import { exposureReport } from "./cli";
import { registryCache } from "./exposure-registry";
import { DEFAULT_LIMITS, type Limits } from "./schema-mapper";

/** The parts of the `cds` facade the plugin uses. Passed in, never read from a global (ADR 0005). */
export interface CdsLike {
  on(event: "served", handler: () => void): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  log(module: string): {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly app: Application;
  /** The app's root folder; MCP App files are read from `<root>/app/mcp-apps/`. */
  readonly root: string;
  readonly context?: RequestContext;
  readonly model?: unknown;
  readonly services: Record<string, unknown>;
  readonly middlewares: { before: RequestHandler[] };
  readonly requires: { auth?: AuthConfig };
  readonly env: { mcp?: McpConfig };
  readonly i18n: { messages: { at(key: string, locale?: string, args?: unknown): unknown } };
}

/** `cds.env.mcp` (docs/annotations.md, Configuration). No key turns a feature on. */
export interface McpConfig {
  path?: string;
  name?: string;
  version?: string;
  allowedOrigins?: string[];
  limits?: Partial<Limits>;
  /**
   * Multitenant XSUAA: a regular expression over the request host whose first capture group is
   * the subscriber's subdomain (like the approuter's TENANT_HOST_PATTERN). Off by default.
   */
  tenantHostPattern?: string;
}

export const MCP_PATH = "/mcp";

function packageVersion(): string {
  const file = path.join(__dirname, "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/**
 * Plugin activation, called once from cds-plugin.js with the host app's `cds`.
 *
 * Mounts one `/mcp` route for all `@mcp` services once CAP has served them, behind CAP's own
 * `before` middlewares (cds.context, auth, model), so the caller is `cds.context.user` and other
 * plugins' middleware applies (ADR 0009). The handler serves both protocol eras (ADR 0010).
 */
export function activate(cds: CdsLike): void {
  const log = cds.log("mcp");
  cds.on("served", () => {
    // Read once the app's env is complete (profiles applied).
    const config = cds.env.mcp ?? {};
    const mcpPath = config.path ?? MCP_PATH;
    const registryFor = registryCache({ limits: { ...DEFAULT_LIMITS, ...config.limits } });
    const registry = registryFor(cds.model as object);
    for (const line of exposureReport(registry, mcpPath)) log[line.level](line.text);
    // MCP Apps (ADR 0012): files for the app's @mcp.ui links, then the app's own registrations.
    const linked = registry.spec.services
      .flatMap((s) => s.operations.map((o) => o.ui))
      .filter((uri): uri is string => uri !== undefined);
    const apps = setUpApps(cds.root, linked, (registry) => cds.emit("mcp:apps", registry), log);
    const handler = mcpHandler({
      serverInfo: {
        name: config.name ?? "@gavdi/cap-mcp",
        version: config.version ?? packageVersion(),
      },
      context: () => cds.context,
      model: () => cds.model as object,
      registryFor,
      apps,
      services: cds.services,
      translate: (key, locale, args) => {
        const text = cds.i18n.messages.at(key, locale, args);
        return typeof text === "string" ? text : undefined;
      },
      log,
    });
    const auth = {
      path: mcpPath,
      auth: () => cds.requires.auth,
      // A pattern that is not a regular expression fails startup, loudly.
      ...(config.tenantHostPattern && {
        tenantHostPattern: new RegExp(config.tenantHostPattern, "i"),
      }),
    };
    // RFC 9728 metadata is public: clients read it to find out how to authenticate.
    cds.app.get(metadataPath(mcpPath), metadataHandler(auth));
    // All methods: the SDK answers GET/DELETE (2025 session operations) with 405.
    cds.app.all(
      mcpPath,
      checkOrigin(() => cds.env.mcp?.allowedOrigins),
      ...cds.middlewares.before,
      requireUser({ ...auth, user: () => cds.context?.user }),
      // No body parser: the SDK reads the body itself (4 MiB) and answers JSON-RPC errors.
      handler,
      authErrors(auth),
    );
    log.debug(`MCP endpoint mounted at ${mcpPath}`);
  });
}
