import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `cds add mcp` (M6): `@mcp` on the chosen services, the dependency, and an mcp config block.
 *
 * The plan is pure (what to write); `mcpFacet` runs it inside cds-dk, which hands plugins its
 * `cds.add.Plugin` base class. Nothing already configured is overwritten.
 */

export interface FacetInput {
  /** The app's services (from its model). */
  services: string[];
  /** `--service`: the ones to expose; required when the app has several. */
  chosen?: string[];
  /** The app's package.json. */
  app: Record<string, unknown>;
  plugin: { name: string; version: string };
  /** `--docs`: doc comments as MCP descriptions (sets cdsc.docs, ADR 0011). */
  docs?: boolean;
}

export interface FacetPlan {
  /** Relative to the app root. */
  file: string;
  cds: string;
  /** The app's package.json with the additions. */
  packageJson: Record<string, unknown>;
  /** What the developer should know (an option that had no effect). */
  notes: string[];
}

type Json = Record<string, unknown>;

export function planMcpFacet(input: FacetInput): FacetPlan {
  const services = [...input.services].sort();
  const list = services.join(", ");
  if (services.length === 0) throw new Error("No services to expose: define a service first");
  const chosen = input.chosen?.length ? input.chosen : services.length === 1 ? services : undefined;
  if (!chosen) throw new Error(`Several services: choose with --service (${list})`);
  const unknown = chosen.find((s) => !services.includes(s));
  if (unknown) throw new Error(`No service ${unknown} (${list})`);

  const app = input.app;
  const installed = isObject(app.devDependencies) && input.plugin.name in app.devDependencies;
  const notes: string[] = [];
  const cdsConfig = isObject(app.cds) ? app.cds : {};
  if (input.docs && isObject(cdsConfig.cdsc) && cdsConfig.cdsc.docs === false) {
    notes.push(
      "cdsc.docs is already false in package.json; left as is. Set it to true to use doc comments as MCP descriptions",
    );
  }
  const additions: Json = {
    ...(!installed && { dependencies: { [input.plugin.name]: `^${input.plugin.version}` } }),
    cds: {
      mcp: { name: app.name, version: app.version },
      ...(input.docs && { cdsc: { docs: true } }),
    },
  };
  return {
    file: "srv/mcp.cds",
    cds:
      "// Added by `cds add mcp`: exposes these services over MCP (read-only baseline).\n" +
      "// Writes, resources, prompts and more are opt-in per definition: see the @gavdi/cap-mcp docs.\n" +
      chosen.map((s) => `annotate ${s} with @mcp;\n`).join(""),
    packageJson: keepExisting(app, additions),
    notes,
  };
}

/** Adds what `additions` has and `target` lacks; existing values always win. */
function keepExisting(target: Json, additions: Json): Json {
  const result: Json = { ...target };
  for (const [key, value] of Object.entries(additions)) {
    if (value === undefined) continue;
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (isObject(existing) && isObject(value)) result[key] = keepExisting(existing, value);
  }
  return result;
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the facet needs from cds-dk's `cds` (passed in, ADR 0005). */
export interface FacetCds {
  root: string;
  cli: { options: Record<string, unknown> };
  add: { Plugin: new () => object };
  load(files: string): Promise<{ definitions?: Record<string, { kind?: string }> }>;
}

/**
 * The `cds add mcp` facet, built on the `cds.add.Plugin` class cds-dk hands to plugins.
 * Options: `--service A,B` (required when the app has several) and `--docs`.
 */
export function mcpFacet(cds: FacetCds, plugin: FacetInput["plugin"]) {
  return class McpFacet extends cds.add.Plugin {
    static help() {
      return "expose services over MCP (@gavdi/cap-mcp)";
    }

    options() {
      return {
        service: { type: "string", help: "Services to expose over MCP, comma-separated." },
        docs: { type: "boolean", help: "Use doc comments as MCP descriptions (cdsc.docs)." },
      };
    }

    async run() {
      const csn = await cds.load("*");
      const services = Object.entries(csn.definitions ?? {})
        .filter(([, def]) => def.kind === "service" && !fromDependency(def) && !isExternal(def))
        .map(([name]) => name);
      const pkgFile = path.join(cds.root, "package.json");
      const { service, docs } = cds.cli.options;
      const app = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
      const plan = planMcpFacet({
        services,
        chosen: typeof service === "string" ? service.split(",").map((s) => s.trim()) : undefined,
        app,
        plugin,
        docs: docs === true,
      });
      // Only touch package.json when something was added.
      if (JSON.stringify(plan.packageJson) !== JSON.stringify(app))
        writeFileSync(pkgFile, JSON.stringify(plan.packageJson, null, 2) + "\n");
      for (const note of plan.notes) console.warn(`[cds add mcp] ${note}`);
      const file = path.join(cds.root, plan.file);
      mkdirSync(path.dirname(file), { recursive: true });
      if (!existsSync(file)) return writeFileSync(file, plan.cds);
      // Keep what is there; add only the annotations it does not have yet (comments do not count).
      const existing = readFileSync(file, "utf8");
      const lines = new Set(existing.split("\n").map((l) => l.trim()));
      const added = plan.cds.split("\n").filter((l) => l.startsWith("annotate ") && !lines.has(l));
      if (added.length)
        writeFileSync(file, existing.replace(/\n?$/, "\n") + added.join("\n") + "\n");
    }
  };
}

/** Imported external services (`cds import`) are other systems' APIs, not the app's to expose. */
function isExternal(def: object): boolean {
  return (def as Record<string, unknown>)["@cds.external"] !== undefined;
}

/** Services that come with a dependency (another plugin's model) are not the app's to annotate. */
function fromDependency(def: object): boolean {
  const file = (def as { $location?: { file?: string } }).$location?.file;
  return !!file && file.split(/[\\/]/).includes("node_modules");
}
