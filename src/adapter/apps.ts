import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * MCP Apps (issue #133, ADR 0012): the `ui://` resources that `@mcp.ui` tools link to.
 *
 * - By default `ui://<host>/<path>` is the file `<root>/app/mcp-apps/<path>`, read once (the
 *   host only names the app for the client; files are found by path).
 * - App code adds or replaces a resource through the `mcp:apps` event (`apps.register`).
 * - The adapter serves a resource only to callers who see a tool that links to it, and drops
 *   the UI link from a tool whose resource has no content.
 *
 * No dependency on @modelcontextprotocol/ext-apps: these constants are what its server helpers
 * use, and a contract test keeps them in step.
 */

/** The MIME type of an MCP App's HTML (ext-apps `RESOURCE_MIME_TYPE`). */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The older flat `_meta` key for the UI resource (ext-apps `RESOURCE_URI_META_KEY`). */
const LEGACY_META_KEY = "ui/resourceUri";

/** The HTML of one UI resource; called on every read, so the app decides about caching. */
export type AppContent = () => string | Promise<string>;

/** What the `mcp:apps` event hands to app code. */
export interface AppRegistry {
  register(uri: string, content: AppContent): void;
}

/** A tool's `_meta` for a UI resource, as ext-apps' `registerAppTool` writes it. */
export function appMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri }, [LEGACY_META_KEY]: uri };
}

/** The UI resource a tool's `_meta` links to, if any. */
export function linkedUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? meta?.[LEGACY_META_KEY];
  return typeof uri === "string" ? uri : undefined;
}

export class McpApps implements AppRegistry {
  readonly #sources = new Map<string, AppContent>();

  register(uri: string, content: AppContent): void {
    if (typeof uri !== "string" || !uri.startsWith("ui://"))
      throw new Error(`cap-mcp: an MCP App resource must be a ui:// URI, got ${String(uri)}`);
    if (typeof content !== "function")
      throw new Error(`cap-mcp: register ${uri} with a function that returns its HTML`);
    this.#sources.set(uri, content);
  }

  content(uri: string): AppContent | undefined {
    return this.#sources.get(uri);
  }

  /** Registered URIs, sorted (lists are deterministic). */
  uris(): string[] {
    return [...this.#sources.keys()].sort();
  }

  /** A tool's `_meta`, without its UI link when that resource has no content. */
  linkedMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const uri = linkedUri(meta);
    if (!meta || uri === undefined || this.#sources.has(uri)) return meta;
    const { ui: _ui, [LEGACY_META_KEY]: _legacy, ...rest } = meta;
    return Object.keys(rest).length ? rest : undefined;
  }
}

/**
 * The default UI resources: each `ui://<host>/<path>` from `<root>/app/mcp-apps/<path>`, read
 * now. A missing file, or a path that leaves app/mcp-apps, is a warning and gets no content.
 */
export function loadAppFiles(
  root: string,
  uris: Iterable<string>,
  log: { warn(...args: unknown[]): void },
): McpApps {
  return readAppFiles(root, uris, (_uri, text) => log.warn(text));
}

function readAppFiles(
  root: string,
  uris: Iterable<string>,
  problem: (uri: string, text: string) => void,
): McpApps {
  const apps = new McpApps();
  const dir = path.resolve(root, "app", "mcp-apps");
  const inside = (file: string, base: string) => file.startsWith(base + path.sep);
  const outside = (uri: string) =>
    problem(uri, `MCP App ${uri} is not a file under app/mcp-apps; the tool has no UI`);
  for (const uri of new Set(uris)) {
    const relative = filePath(uri);
    const file = relative === undefined ? undefined : path.resolve(dir, relative);
    if (file === undefined || !inside(file, dir)) {
      outside(uri);
      continue;
    }
    let real: string;
    let html: string;
    try {
      // Symlinks are followed, so check where the file really is.
      real = realpathSync(file);
      html = readFileSync(real, "utf8");
    } catch {
      const shown = path.relative(root, file).split(path.sep).join("/");
      problem(uri, `MCP App ${uri} has no file at ${shown}; the tool has no UI`);
      continue;
    }
    if (!inside(real, realpathSync(dir))) {
      outside(uri);
      continue;
    }
    apps.register(uri, () => html);
  }
  return apps;
}

/**
 * Startup: read the files for the linked URIs, let app code register more (the `mcp:apps`
 * event), then warn about linked URIs that still have no content and registrations nothing
 * links to. A missing file that app code supplies is not a problem.
 */
export function setUpApps(
  root: string,
  linked: string[],
  emit: (apps: AppRegistry) => void,
  log: { warn(...args: unknown[]): void },
): McpApps {
  const problems = new Map<string, string>();
  const apps = readAppFiles(root, linked, (uri, text) => problems.set(uri, text));
  emit(apps);
  for (const [uri, text] of problems) if (!apps.content(uri)) log.warn(text);
  for (const uri of apps.uris())
    if (!linked.includes(uri)) log.warn(`MCP App ${uri} is registered but no @mcp.ui links to it`);
  return apps;
}

/** `ui://<host>/<path>` → `<path>`, decoded; undefined if it is not one. */
function filePath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    return decoded || undefined;
  } catch {
    return undefined;
  }
}
