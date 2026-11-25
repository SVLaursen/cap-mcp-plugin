import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { servedFiles, setUpSkills } from "../adapter/skills";
import { readConfig, skillsFolder } from "../config";

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
      if (skills) await copySkills(self, skills);
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
   * Exactly the skills the app serves (ADR 0016), checked and loaded as the runtime does: the
   * folder must be inside the app root, and a skill the runtime skips (a symlink in it, over the
   * limits, bad frontmatter) is not copied, so gen/ never serves what the app does not. Files
   * the runtime ignores (dotfiles) stay out too. cds-dk's own copy would follow symlinks.
   */
  async function copySkills(self: PluginSelf, folder: string) {
    const warn = (message: string) =>
      self.pushMessage(`MCP skills folder ${folder}${message}`, Base.WARNING);
    if (path.isAbsolute(folder))
      return warn(" is an absolute path; the deployed app reads it there, so it is not copied");
    const checked = skillsFolder(folder, cds.root);
    if (!checked.folder) return warn(` ${checked.reason ?? "cannot be used"}; not copied`);
    const { catalog, diagnostics } = await setUpSkills(folder, cds.root);
    for (const d of diagnostics) warn(`: ${d.target}: ${d.message}`);
    if (!catalog) return;
    const to = path.resolve(self.task.dest, "srv", folder);
    for (const file of servedFiles(catalog)) {
      const dest = path.join(to, ...file.split("/"));
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(checked.folder, ...file.split("/")), dest);
      self.pushFile(dest);
    }
  }
}
