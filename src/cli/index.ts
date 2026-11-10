import { NotImplementedError } from "../errors";

/**
 * cli (milestone M6)
 *
 * - `cds add mcp`: adds the dependency, `@mcp` on the chosen service, and an mcp config block.
 * - `cds mcp`: runs the app's MCP endpoint over stdio for local desktop clients.
 * - Startup exposure report: "[mcp] serving N tools, M resources, P prompts at /mcp" plus every
 *   Diagnostic from the model reader.
 */
export function formatExposureReport(): string {
  throw new NotImplementedError("formatExposureReport", "M6");
}
