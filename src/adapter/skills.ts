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
import { posix } from "node:path";
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
export async function setUpSkills(
  value: string | undefined,
  root: string,
  options: { warn?: (...message: unknown[]) => void } = {},
): Promise<SkillsSetup> {
  const { folder, diagnostic } = skillsFolder(value, root);
  if (diagnostic) return { uris: [], diagnostics: [diagnostic] };
  if (!folder || value === undefined) return { uris: [], diagnostics: [] };
  const warnings: SkillWarning[] = [];
  // While loading, warnings become diagnostics; afterwards the catalog keeps the callback for
  // reads (a file that changed or cannot be read), and those go to the log.
  let sink: (warning: SkillWarning) => void = (warning) => void warnings.push(warning);
  const onWarning = (warning: SkillWarning) => sink(warning);
  let catalog: SkillCatalog;
  let skipped: Map<string, string>;
  try {
    // The SDK only warns about a skill over the limits and serves it; the specification says
    // not to serve it (ADR 0016). Load, find those skills, and load again without them.
    const files = nodeSkillFiles(folder);
    const load = (from: SkillFiles) =>
      SkillsExtension.load(from, { cacheHint: SKILLS_CACHE_HINT, onWarning });
    catalog = await load(files);
    skipped = overLimit(catalog.entries);
    if (skipped.size) {
      // A skill nested in a skipped one goes with it: say so rather than drop it silently.
      for (const entry of catalog.entries) {
        const dir = folderOf(entry.uri);
        const outer = [...skipped.keys()].find((d) => dir.startsWith(`${d}/`));
        if (outer && !skipped.has(dir))
          skipped.set(
            dir,
            `inside ${posix.join(value, outer)}, which is not served (skill skipped)`,
          );
      }
      warnings.length = 0;
      catalog = await load(without(files, new Set(skipped.keys())));
    }
  } catch (error) {
    // Startup goes on without skills (ADR 0016), whatever the storage threw.
    const why = SkillCatalogError.isInstance(error)
      ? error.problems.map((p) => `${p.path}: ${p.message}`).join("; ") || error.message
      : error instanceof Error
        ? error.message
        : String(error);
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
  const warn = options.warn;
  sink = (w) => void warn?.(`cap-mcp: skill file ${posix.join(value, w.path)}: ${w.message}`);
  // "No skills found" after skipping some would mislead: the folder had skills.
  const found = skipped.size ? warnings.filter((w) => w.path !== ".") : warnings;
  const diagnostics: Diagnostic[] = [
    ...found,
    ...[...skipped].map(([path, message]) => ({ path, message })),
  ]
    .map((w) => ({
      level: "warn" as const,
      code: "INVALID_SKILL" as const,
      target: posix.join(value, w.path),
      message: w.message,
    }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const uris = catalog.entries.map((e) => e.uri);
  return uris.length ? { catalog, uris, diagnostics } : { uris, diagnostics };
}

/** The served files, as paths relative to the skills folder (nested skills' files once). */
export function servedFiles(catalog: SkillCatalog): string[] {
  const files = new Set<string>();
  for (const entry of catalog.entries) {
    if (!Array.isArray(entry.resources)) continue;
    for (const r of entry.resources) files.add(pathOf(r.uri));
  }
  return [...files].sort();
}

/** `skill://a/b/c.md` → `a/b/c.md` (no prefix is used; segments are percent-encoded). */
function pathOf(uri: string): string {
  return uri.slice("skill://".length).split("/").map(decodeURIComponent).join("/");
}

/** A skill's folder, from its SKILL.md URI. */
function folderOf(uri: string): string {
  return posix.dirname(pathOf(uri));
}

/** The skills (by folder) over the publication limits, with why: 512 files or 16 MiB each. */
function overLimit(entries: readonly Skill[]): Map<string, string> {
  const over = new Map<string, string>();
  for (const entry of entries) {
    if (!Array.isArray(entry.resources)) continue;
    const files = entry.resources.length;
    const bytes = entry.resources.reduce((sum, r) => sum + r.size, 0);
    if (files <= SKILL_LIMITS.files && bytes <= SKILL_LIMITS.bytes) continue;
    over.set(
      folderOf(entry.uri),
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
