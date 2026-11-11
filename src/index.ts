import { readFileSync } from "node:fs";
import path from "node:path";
import type { Application, RequestHandler } from "express";
import { mcpHandler, type RequestContext, type TxService } from "./adapter";
import { setUpApps } from "./adapter/apps";
import {
  authErrors,
  checkOrigin,
  metadataHandler,
  metadataPath,
  requireUser,
  type AuthConfig,
} from "./adapter/auth";
import { docCommentHint, exposureReport } from "./cli";
import { mcpFacet, type FacetCds } from "./cli/add";
import { mcpBuildTask, type BuildCds } from "./cli/build";
import { capQueryLimit, readConfig, readInstructions } from "./config";
import { registryCache } from "./exposure-registry";
import { DEFAULT_LIMITS } from "./schema-mapper";

/** The parts of the `cds` facade the plugin uses. Passed in, never read from a global (ADR 0005). */
export interface CdsLike {
  on(event: "served", handler: () => void): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  log(module: string): {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly app: Application;
  /** The app's root folder; MCP App files are read from `<root>/app/mcp-apps/`. */
  readonly root: string;
  readonly context?: RequestContext;
  readonly model?: unknown;
  /** CAP's services: each runs CQN, sends events and opens its own root transaction. */
  readonly services: Record<string, TxService | undefined>;
  readonly middlewares: { before: RequestHandler[] };
  readonly requires: { auth?: AuthConfig };
  readonly env: {
    mcp?: unknown;
    cdsc?: { docs?: boolean };
    profiles?: string[];
    query?: { limit?: { max?: number; default?: number } };
  };
  /** Used once at startup, to compare the model with its doc comments (ADR 0011). */
  load(files: string | string[], options: { docComment: true; silent: true }): Promise<unknown>;
  readonly i18n: { messages: { at(key: string, locale?: string, args?: unknown): unknown } };
}

export type { McpConfig } from "./config";

export const MCP_PATH = "/mcp";

export { mcpFacet } from "./cli/add";
export { mcpBuildTask } from "./cli/build";

/** This plugin's own version (server identity default, `cds add mcp` dependency). */
export function packageVersion(): string {
  const file = path.join(__dirname, "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/**
 * What cds-plugin.js does, given the host app's `cds`: activate the plugin, and register the
 * `cds add mcp` facet and the `cds build` task when cds-dk runs those commands. The published
 * cds-plugin.js calls this from lib/; this repository's tests call it from src/ (test/setup-env.js).
 */
export function plugin(
  cds: CdsLike & {
    cli?: { command?: string };
    add?: { register(name: string, facet: unknown): void } & FacetCds["add"];
    build?: { register?(name: string, task: unknown): void } & Partial<BuildCds["build"]>;
  },
): void {
  activate(cds);
  // `cds add mcp`: cds-dk sets cds.cli before it loads plugins, and only it has cds.add.
  if (cds.cli?.command === "add" && cds.add) {
    const self = { name: "@gavdi/cap-mcp", version: packageVersion() };
    cds.add.register("mcp", mcpFacet(cds as unknown as FacetCds, self));
  }
  // `cds build`: copy the instructions file into the deployed app (only when one is configured).
  if (cds.cli?.command === "build" && cds.build?.register) {
    cds.build.register("mcp", mcpBuildTask(cds as unknown as BuildCds));
  }
}

/**
 * Plugin activation, called once (from `plugin`) with the host app's `cds`.
 *
 * Mounts one `/mcp` route for all `@mcp` services once CAP has served them, behind CAP's own
 * `before` middlewares (cds.context, auth, model), so the caller is `cds.context.user` and other
 * plugins' middleware applies (ADR 0009). The handler serves both protocol eras (ADR 0010).
 */
export function activate(cds: CdsLike): void {
  const log = cds.log("mcp");
  cds.on("served", () => {
    // Read once the app's env is complete (profiles applied).
    const { config, v1, diagnostics } = readConfig(cds.env.mcp);
    const instructions = readInstructions(config.instructions, cds.root);
    if (instructions.diagnostic) diagnostics.push(instructions.diagnostic);
    const mcpPath = config.path ?? MCP_PATH;
    const registryFor = registryCache({
      limits: capQueryLimit({ ...DEFAULT_LIMITS, ...config.limits }, cds.env.query?.limit),
      v1,
    });
    const registry = registryFor(cds.model as object);
    for (const line of exposureReport(registry, mcpPath, diagnostics)) log[line.level](line.text);
    // MCP Apps (ADR 0012): files for the app's @mcp.ui links, then the app's own registrations.
    const linked = registry.spec.services
      .flatMap((s) => s.operations.map((o) => o.ui))
      .filter((uri): uri is string => uri !== undefined);
    const apps = setUpApps(cds.root, linked, (registry) => cds.emit("mcp:apps", registry), log);
    const handler = mcpHandler({
      serverInfo: {
        name: config.name ?? "@gavdi/cap-mcp",
        version: config.version ?? packageVersion(),
      },
      instructions: instructions.text,
      context: () => cds.context,
      model: () => cds.model as object,
      registryFor,
      apps,
      services: cds.services,
      translate: (key, locale, args) => {
        // at(key, args) when there is no locale: CAP reads a non-string 2nd argument as args, so
        // at(key, undefined, args) would drop the arguments ("Only {1} in stock").
        const text = locale
          ? cds.i18n.messages.at(key, locale, args)
          : // cds-types only declare at(key, locale?, args?); the runtime also takes at(key, args).
            (cds.i18n.messages.at as (key: string, args: unknown) => unknown)(key, args);
        return typeof text === "string" ? text : undefined;
      },
      log,
    });
    const auth = {
      path: mcpPath,
      auth: () => cds.requires.auth,
      // A pattern that is not a regular expression fails startup, loudly.
      ...(config.tenantHostPattern && {
        tenantHostPattern: new RegExp(config.tenantHostPattern, "i"),
      }),
    };
    // RFC 9728 metadata is public: clients read it to find out how to authenticate.
    cds.app.get(metadataPath(mcpPath), metadataHandler(auth));
    // All methods: the SDK answers GET/DELETE (2025 session operations) with 405.
    cds.app.all(
      mcpPath,
      // Checked at startup like every other key: only a list of strings counts.
      checkOrigin(config.allowedOrigins),
      ...cds.middlewares.before,
      requireUser({ ...auth, user: () => cds.context?.user }),
      // No body parser: the SDK reads the body itself (4 MiB) and answers JSON-RPC errors.
      handler,
      authErrors(auth),
    );
    log.debug(`MCP endpoint mounted at ${mcpPath}`);
    const production =
      process.env.NODE_ENV === "production" || !!cds.env.profiles?.includes("production");
    // Beside startup, never in its way: CAP awaits `served` listeners before it listens.
    if (!cds.env.cdsc?.docs && !production) void reportLostDocComments(cds, registry, log);
  });
}

/**
 * ADR 0011: without `cdsc.docs`, doc comments never reach MCP. In development, compile the
 * app's sources once more with them (silently: no `loaded` event for other plugins) and say
 * which exposed definitions lost one. Best effort: a failure here only skips the hint.
 */
async function reportLostDocComments(
  cds: CdsLike,
  registry: Parameters<typeof docCommentHint>[0],
  log: ReturnType<CdsLike["log"]>,
): Promise<void> {
  const sources = (cds.model as { $sources?: string[] } | undefined)?.$sources;
  try {
    // `docComment` is the compiler's own option: CAP lets cds.env.cdsc override `docs`.
    const options = { docComment: true, silent: true } as const;
    const docs = await cds.load(sources?.length ? sources : "*", options);
    const hint = docCommentHint(registry, docs as Parameters<typeof docCommentHint>[1]);
    if (hint) log[hint.level](hint.text);
  } catch (error) {
    log.debug("Skipped the doc comment check:", error);
  }
}
