import type {
  Skill,
  SkillCatalog,
  SkillFiles,
  SkillWarning,
} from "@modelcontextprotocol/server/ext/skills";
import {
  SKILL_LIMITS,
  SkillCatalogError,
  SkillsExtension,
} from "@modelcontextprotocol/server/ext/skills";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
import { skillsFolder } from "../config";
import type { Diagnostic } from "../types";

/**
 * Skills over MCP (ADR 0016): one catalog, loaded once at startup from the folder named by
 * `cds.mcp.skills`, attached to every request's server. Static: a change needs a restart.
 */

/** As for our lists: the same for every caller, but the endpoint may require login. */
export const SKILLS_CACHE_HINT = { ttlMs: 60_000, cacheScope: "private" } as const;

export interface SkillsSetup {
  /** Undefined without the key, with an unusable folder, or without a valid skill. */
  catalog?: SkillCatalog;
  /** The served skills' SKILL.md URIs, sorted. */
  uris: string[];
  diagnostics: Diagnostic[];
}

/**
 * Load the skills folder. Not `strict`: the SDK skips an invalid skill whole and warns, and each
 * warning becomes an `INVALID_SKILL` diagnostic naming the file. A folder that cannot be used or
 * read is `INVALID_CONFIG`, and no skills are served; startup goes on.
 */
export async function setUpSkills(value: string | undefined, root: string): Promise<SkillsSetup> {
  const { folder, diagnostic } = skillsFolder(value, root);
  if (diagnostic) return { uris: [], diagnostics: [diagnostic] };
  if (!folder || value === undefined) return { uris: [], diagnostics: [] };
  const warnings: SkillWarning[] = [];
  let catalog: SkillCatalog;
  let over: Map<string, string>;
  try {
    // The SDK only warns about a skill over the limits and serves it; the specification says
    // not to serve it (ADR 0016). Load, find those skills, and load again without them.
    const files = nodeSkillFiles(folder);
    const load = (from: SkillFiles, warn: (w: SkillWarning) => void) =>
      SkillsExtension.load(from, { cacheHint: SKILLS_CACHE_HINT, onWarning: warn });
    catalog = await load(files, (warning) => void warnings.push(warning));
    over = overLimit(catalog.entries);
    if (over.size) {
      warnings.length = 0;
      catalog = await load(without(files, new Set(over.keys())), (w) => void warnings.push(w));
    }
  } catch (error) {
    if (!SkillCatalogError.isInstance(error)) throw error;
    const why = error.problems.map((p) => `${p.path}: ${p.message}`).join("; ") || error.message;
    return {
      uris: [],
      diagnostics: [
        {
          level: "error",
          code: "INVALID_CONFIG",
          target: "cds.mcp.skills",
          message: `cds.mcp.skills folder ${value} cannot be read (${why}); serving no skills`,
        },
      ],
    };
  }
  for (const [dir, message] of over) warnings.push({ path: dir, message });
  const diagnostics: Diagnostic[] = warnings
    .map((w) => ({
      level: "warn" as const,
      code: "INVALID_SKILL" as const,
      // The SDK names the folder itself "." (e.g. "no skills found").
      target: w.path === "." || !w.path ? value : `${value}/${w.path}`,
      message: w.message,
    }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const uris = catalog.entries.map((e) => e.uri);
  return uris.length ? { catalog, uris, diagnostics } : { uris, diagnostics };
}

/** The skills (by folder) over the publication limits, with why: 512 files or 16 MiB each. */
function overLimit(entries: readonly Skill[]): Map<string, string> {
  const over = new Map<string, string>();
  for (const entry of entries) {
    if (!Array.isArray(entry.resources)) continue;
    const files = entry.resources.length;
    const bytes = entry.resources.reduce((sum, r) => sum + r.size, 0);
    if (files <= SKILL_LIMITS.files && bytes <= SKILL_LIMITS.bytes) continue;
    const dir = entry.uri
      .slice("skill://".length, -"/SKILL.md".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    over.set(
      dir,
      `${files} files / ${bytes} bytes exceeds the limit of ${SKILL_LIMITS.files} files / ${SKILL_LIMITS.bytes} bytes (skill skipped)`,
    );
  }
  return over;
}

/** The skills folder without the given skill folders (paths relative to it). */
function without(files: SkillFiles, hidden: ReadonlySet<string>): SkillFiles {
  return {
    list: async (dir) =>
      (await files.list(dir)).filter((e) => !hidden.has(dir ? `${dir}/${e.name}` : e.name)),
    read: (file) => files.read(file),
  };
}
