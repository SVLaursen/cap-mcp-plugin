import { existsSync } from "node:fs";
import path from "node:path";
import { readConfig } from "../config";

/** What the build task needs from cds-dk's `cds` (passed in, ADR 0005). */
export interface BuildCds {
  root: string;
  env: { mcp?: unknown };
  build: { Plugin: new () => { task: { src: string; dest: string } } };
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
  return class McpBuildTask extends cds.build.Plugin {
    static taskDefaults = { src: "." };

    static hasTask() {
      return file() !== undefined;
    }

    async build() {
      const instructions = file();
      if (!instructions || !existsSync(path.resolve(cds.root, instructions))) return;
      const self = this as unknown as { copy(src: string): { to(dest: string): Promise<unknown> } };
      await self.copy(path.resolve(cds.root, instructions)).to(path.join("srv", instructions));
    }
  };
}
