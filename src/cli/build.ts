import { existsSync } from "node:fs";
import path from "node:path";
import { readConfig } from "../config";

/** What the build task needs from cds-dk's `cds` (passed in, ADR 0005). */
export interface BuildCds {
  root: string;
  env: { mcp?: unknown };
  build: { Plugin: (new () => { task: { src: string; dest: string } }) & { WARNING: unknown } };
}

/**
 * `cds build`: copies the `instructions` file to `srv/<file>` in the build output, where the
 * deployed app (rooted at gen/srv) resolves `{ file }` relative to its root (v1 parity).
 * Only runs when the app configures an instructions file.
 */
export function mcpBuildTask(cds: BuildCds) {
  const file = () => {
    const instructions = readConfig(cds.env.mcp).config.instructions;
    return typeof instructions === "object" ? instructions.file : undefined;
  };
  const Base = cds.build.Plugin;
  return class McpBuildTask extends Base {
    static taskDefaults = { src: "." };

    static hasTask() {
      return file() !== undefined;
    }

    async build() {
      const instructions = file();
      if (!instructions) return;
      const self = this as unknown as {
        copy(src: string): { to(dest: string): Promise<unknown> };
        pushMessage(message: string, severity: unknown): void;
      };
      const warn = (message: string) =>
        self.pushMessage(`MCP instructions file ${instructions} ${message}`, Base.WARNING);
      if (path.isAbsolute(instructions))
        return warn("is an absolute path; the deployed app reads it there, so it is not copied");
      if (!existsSync(path.resolve(cds.root, instructions))) return warn("not found; not copied");
      await self.copy(path.resolve(cds.root, instructions)).to(path.join("srv", instructions));
    }
  };
}
