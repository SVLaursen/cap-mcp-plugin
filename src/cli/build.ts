import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../config";

/** What the build task needs from cds-dk's `cds` (passed in, ADR 0005). */
export interface BuildCds {
  root: string;
  env: { mcp?: unknown };
  build: { Plugin: (new () => { task: { src: string; dest: string } }) & { WARNING: unknown } };
}

/** The Plugin methods the task calls (cds-dk's build plugin API). */
interface PluginSelf {
  task: { dest: string };
  copy(src: string): { to(dest: string): Promise<unknown> };
  pushFile(file: string): void;
  pushMessage(message: string, severity: unknown): void;
}

/**
 * `cds build`: copies the `instructions` file and the skills folder (ADR 0016) to `srv/<path>` in
 * the build output, where the deployed app (rooted at gen/srv) resolves them relative to its root
 * (v1 parity). Only runs when the app configures one of them.
 */
export function mcpBuildTask(cds: BuildCds) {
  const configured = () => {
    const { instructions, skills } = readConfig(cds.env.mcp).config;
    return { file: typeof instructions === "object" ? instructions.file : undefined, skills };
  };
  const Base = cds.build.Plugin;
  return class McpBuildTask extends Base {
    static taskDefaults = { src: "." };

    static hasTask() {
      const { file, skills } = configured();
      return file !== undefined || skills !== undefined;
    }

    async build() {
      const self = this as unknown as PluginSelf;
      const { file, skills } = configured();
      if (file) await copyOne(self, "instructions file", file, () => copyInstructions(self, file));
      if (skills) await copyOne(self, "skills folder", skills, () => copySkills(self, skills));
    }
  };

  /** The checks both share: an absolute path stays where it is; a missing one is a warning. */
  async function copyOne(
    self: PluginSelf,
    what: string,
    relative: string,
    copy: () => Promise<unknown>,
  ) {
    const warn = (message: string) =>
      self.pushMessage(`MCP ${what} ${relative} ${message}`, Base.WARNING);
    if (path.isAbsolute(relative))
      return warn("is an absolute path; the deployed app reads it there, so it is not copied");
    if (!existsSync(path.resolve(cds.root, relative))) return warn("not found; not copied");
    await copy();
  }

  function copyInstructions(self: PluginSelf, file: string) {
    return self.copy(path.resolve(cds.root, file)).to(path.join("srv", file));
  }

  /**
   * The skills folder, file by file. Symlinks are left out: cds-dk's copy follows them, so a
   * skill the app skips at runtime (ADR 0016) would turn into regular files in gen/ and be served.
   */
  async function copySkills(self: PluginSelf, folder: string) {
    const from = path.resolve(cds.root, folder);
    const to = path.resolve(self.task.dest, "srv", folder);
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(from, relative))) {
        const item = path.join(relative, entry);
        const stat = await lstat(path.join(from, item));
        if (stat.isSymbolicLink()) {
          const shown = item.split(path.sep).join("/");
          self.pushMessage(
            `MCP skills folder ${folder}: ${shown} is a symlink; not copied`,
            Base.WARNING,
          );
        } else if (stat.isDirectory()) {
          await walk(item);
        } else if (stat.isFile()) {
          await mkdir(path.dirname(path.join(to, item)), { recursive: true });
          await copyFile(path.join(from, item), path.join(to, item));
          self.pushFile(path.join(to, item));
        }
      }
    };
    await walk("");
  }
}
