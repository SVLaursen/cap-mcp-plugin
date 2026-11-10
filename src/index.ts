import type { Application } from "express";
import { notImplementedHandler } from "./adapter";

/** The parts of the `cds` facade the plugin uses. Passed in, never read from a global (ADR 0005). */
export interface CdsLike {
  on(event: "bootstrap", handler: (app: Application) => void): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
  log(module: string): { info(...args: unknown[]): void; debug(...args: unknown[]): void };
}

export const MCP_PATH = "/mcp";

/**
 * Plugin activation, called once from cds-plugin.js with the host app's `cds`.
 *
 * Today this mounts a placeholder endpoint so the demo app boots and the behaviour suite has a
 * stable baseline. Milestone M4 replaces it with the real adapter, mounted inside CAP's own
 * middleware chain (auth, cds.context, AMS, telemetry) — see ADR 0002 and docs/backlog.md.
 */
export function activate(cds: CdsLike): void {
  const log = cds.log("mcp");
  cds.on("bootstrap", (app: Application) => {
    app.post(MCP_PATH, notImplementedHandler);
    log.debug(`placeholder MCP endpoint mounted at ${MCP_PATH}`);
  });
}
