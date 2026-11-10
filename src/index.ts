import { readFileSync } from "node:fs";
import path from "node:path";
import type { Application, RequestHandler } from "express";
import { mcpHandler, type RequestContext } from "./adapter";
import {
  authErrors,
  metadataHandler,
  metadataPath,
  requireUser,
  type AuthConfig,
} from "./adapter/auth";
import { registryCache } from "./exposure-registry";

/** The parts of the `cds` facade the plugin uses. Passed in, never read from a global (ADR 0005). */
export interface CdsLike {
  on(event: "served", handler: () => void): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
  log(module: string): {
    info(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly app: Application;
  readonly context?: RequestContext;
  readonly model?: unknown;
  readonly services: Record<string, unknown>;
  readonly middlewares: { before: RequestHandler[] };
  readonly env: { production?: boolean };
  readonly requires: { auth?: AuthConfig };
  readonly i18n: { messages: { at(key: string, locale?: string, args?: unknown): unknown } };
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
  const registryFor = registryCache();
  cds.on("served", () => {
    const handler = mcpHandler({
      serverInfo: { name: "@gavdi/cap-mcp", version: packageVersion() },
      context: () => cds.context,
      model: () => cds.model as object,
      registryFor,
      services: cds.services,
      production: cds.env.production,
      translate: (key, locale, args) => {
        const text = cds.i18n.messages.at(key, locale, args);
        return typeof text === "string" ? text : undefined;
      },
      log,
    });
    const auth = { path: MCP_PATH, auth: () => cds.requires.auth };
    // RFC 9728 metadata is public: clients read it to find out how to authenticate.
    cds.app.get(metadataPath(MCP_PATH), metadataHandler(auth));
    // All methods: the SDK answers GET/DELETE (2025 session operations) with 405.
    cds.app.all(
      MCP_PATH,
      ...cds.middlewares.before,
      requireUser({ ...auth, user: () => cds.context?.user }),
      // No body parser: the SDK reads the body itself (4 MiB) and answers JSON-RPC errors.
      handler,
      authErrors(auth),
    );
    log.debug(`MCP endpoint mounted at ${MCP_PATH}`);
  });
}
