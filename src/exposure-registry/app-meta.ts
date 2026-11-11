/**
 * The `_meta` that links a tool to its MCP App UI (ADR 0012), as ext-apps' `registerAppTool`
 * writes it: the current `ui.resourceUri` and the older flat key. A contract test keeps these in
 * step with ext-apps.
 */

/** The older flat `_meta` key for the UI resource (ext-apps `RESOURCE_URI_META_KEY`). */
export const LEGACY_META_KEY = "ui/resourceUri";

/** A tool's `_meta` for a UI resource. */
export function appMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri }, [LEGACY_META_KEY]: uri };
}

/** The UI resource a tool's `_meta` links to, if any. */
export function linkedUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? meta?.[LEGACY_META_KEY];
  return typeof uri === "string" ? uri : undefined;
}
