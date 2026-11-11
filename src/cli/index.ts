import type { ExposureRegistry } from "../exposure-registry";
import type { Diagnostic, UserLike } from "../types";

/**
 * cli (milestone M6)
 *
 * - `cds add mcp`: adds the dependency, `@mcp` on the chosen service, and an mcp config block.
 * - stdio entry point for local desktop clients.
 * - Startup exposure report: "serving N tools, M resources, P prompts at /mcp" plus every
 *   Diagnostic from the model reader and the registry.
 */

export interface ReportLine {
  level: Diagnostic["level"];
  text: string;
}

/** Counts what the app exposes to anyone: a user with every role sees every tool. */
const EVERYONE: UserLike = { id: "startup-report", is: () => true };
const ORDER: Record<Diagnostic["level"], number> = { error: 0, warn: 1, info: 2 };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the plugin logs once CAP has served the app: a summary, then every diagnostic. */
export function exposureReport(registry: ExposureRegistry, path: string): ReportLine[] {
  const summary = [
    count(registry.toolsFor(EVERYONE).length, "tool"),
    count(registry.resourcesFor(EVERYONE).length, "resource"),
    count(registry.promptsFor(EVERYONE).length, "prompt"),
  ].join(", ");
  const diagnostics = [...registry.diagnostics]
    .sort((a, b) => ORDER[a.level] - ORDER[b.level])
    .map((d) => ({ level: d.level, text: `${d.code} ${d.target}: ${d.message}` }));
  return [{ level: "info", text: `serving ${summary} at ${path}` }, ...diagnostics];
}
