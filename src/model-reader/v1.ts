import type { FieldSpec, ServiceSpec, V1Options } from "../types";
import {
  type Definition,
  type Context,
  serviceNames,
  serviceOf,
  isCopied,
  writtenAt,
} from "./definitions";

/**
 * The v1 shim: which v1 annotations and config still opt definitions in, what they map to, and the
 * V1_ANNOTATION / V1_DEFAULT_CHANGED diagnostics that say what to write instead
 * (docs/v1-compatibility.md).
 */

/** Where a v1 key was found, for its message. */
export interface V1Where {
  target: string;
  kind?: string;
  /** Inside a service (not a db entity that projections copy from). */
  inService: boolean;
  /** `@mcp.wrap.tools: false` on the same definition. */
  wrapToolsOff?: boolean;
}

export const OPERATION = new Set(["action", "function"]);

/** The message for a v1 opt-in key: mapped, or why it has no effect where it is. */
export function v1OptInMessage(
  key: string,
  value: unknown,
  where: V1Where,
  wanted: "entity" | "operation",
) {
  const { target, kind, inService } = where;
  const right = wanted === "operation" ? OPERATION.has(kind ?? "") : kind === "entity";
  if (!right)
    return `${key} is v1 and has no effect on ${target}: v1 read it on ${wanted === "operation" ? "actions and functions" : "entities"} only`;
  if (!inService)
    return `${key} is v1: on ${target} it reaches only the projections that copy it, which v2 does not opt in. Write @mcp on the projections instead`;
  return undefined;
}

/** v1 annotations that v2 maps (to @mcp) or drops, with what to write instead (docs/annotations.md). */
export const V1: Record<string, (value: unknown, where: V1Where) => string> = {
  "@mcp.wrap.tools": (value, where) =>
    value !== true
      ? `@mcp.wrap.tools: false is v1: it keeps the v1 list form of @mcp.resource from exposing ${where.target}. Leave out @mcp (and the v1 keys) instead`
      : (v1OptInMessage("@mcp.wrap.tools", value, where, "entity") ??
        `@mcp.wrap.tools is v1: mapped to @mcp on ${where.target}. Write @mcp instead`),
  "@mcp.tool": (value, where) =>
    value !== true
      ? "@mcp.tool is v1 and has no effect: an operation is exposed by @mcp"
      : (v1OptInMessage("@mcp.tool", value, where, "operation") ??
        `@mcp.tool is v1: mapped to @mcp on ${where.target}. Write @mcp instead`),
  "@mcp.usePrimaryKey": () =>
    "@mcp.usePrimaryKey is v1 and has no effect: keys are always the entity keys",
  "@mcp.wrap.name": () =>
    "@mcp.wrap.name is v1 and has no effect: tool names are <Service>_<Entity>_<mode>; use @mcp.name for the title",
};

export const V1_HINT = /^@mcp\.wrap\.hint(\.(query|get|create|update|delete))?$/;

/** v1's `wrap_entity_modes` default. */
export const V1_WRAP_MODES = ["query", "get", "create", "update"];

/**
 * The v1 annotation that opts a definition in (v1 shim), if any: `@mcp.tool: true`,
 * `@mcp.wrap.tools: true`, or the list form of `@mcp.resource`.
 */
export function v1OptIn(def: Definition): `@${string}` | undefined {
  if (OPERATION.has(def.kind ?? "")) return def["@mcp.tool"] === true ? "@mcp.tool" : undefined;
  if (def.kind !== "entity") return undefined;
  if (def["@mcp.wrap.tools"] === true) return "@mcp.wrap.tools";
  // `@mcp.wrap.tools: false` kept v1 from serving the entity as tools.
  if (Array.isArray(def["@mcp.resource"]) && def["@mcp.wrap.tools"] !== false)
    return "@mcp.resource";
  return undefined;
}

/**
 * v1 served an entity as tools (with `@mcp.wrap.modes`, else `wrap_entity_modes`) only with
 * `@mcp.wrap.tools: true`, or with `wrap_entities_to_actions` when wrap.tools was unset.
 */
export function v1Wrapped(def: Definition, v1: V1Options): boolean {
  return (
    def["@mcp.wrap.tools"] === true ||
    (v1.wrapEntitiesToActions === true &&
      def["@mcp.resource"] !== undefined &&
      def["@mcp.wrap.tools"] === undefined)
  );
}

/**
 * v1 shim: what a v1 app got by default (or from v1 config) and no longer gets. Writes from
 * `wrap_entity_modes`, tools from `wrap_entities_to_actions`, and the describe tool.
 */
export function checkV1Defaults(ctx: Context, services: ServiceSpec[]): void {
  const v1 = ctx.v1;
  const exposed = new Set(services.flatMap((s) => s.entities.map((e) => e.name)));
  const changed = (target: string, message: string) =>
    ctx.diagnostics.push({ level: "warn", code: "V1_DEFAULT_CHANGED", target, message });
  const names = serviceNames(ctx.definitions);
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind !== "entity" || !serviceOf(name, names)) continue;
    const wrapped = v1Wrapped(def, v1);
    const key = v1OptIn(def);
    if (!wrapped && !key) continue;
    if (!exposed.has(name)) {
      const from = key ?? "wrap_entities_to_actions";
      const copied =
        key && isCopied(def, key, ctx) ? `, copied from ${writtenAt(name, key, ctx)}` : "";
      changed(
        name,
        wrapped
          ? `v1 gave ${name} query and get tools (${from}${copied}); v2 does not. Add @mcp to the entity to keep them`
          : `v1 served ${name} as a resource template (${from}${copied}); v2 does not. Add @mcp to the entity for query and get tools`,
      );
      continue;
    }
    if (!wrapped || def["@mcp.wrap.modes"] !== undefined) continue;
    const lost = (v1.wrapEntityModes ?? V1_WRAP_MODES).filter((m) => m !== "query" && m !== "get");
    if (lost.length === 0) continue;
    changed(
      name,
      `v1 also gave ${name} ${lost.join(", ")} tools (wrap_entity_modes); v2 gives query and get only. Add @mcp.wrap.modes: [${lost.map((m) => `'${m}'`).join(", ")}] to keep them`,
    );
  }
  const v1App =
    Object.keys(v1).length > 0 || ctx.diagnostics.some((d) => d.code === "V1_ANNOTATION");
  // A configured enable_model_description is reported by the config reader.
  if (v1App && v1.describe === undefined) {
    changed(
      "cds.mcp.enable_model_description",
      "v1 served the cap_describe_model tool by default; v2 does not. Add @mcp.describe to a service for a describe tool scoped to it",
    );
  }
}

/** The definition without @mcp.wrap.modes, reported as having no effect (v1 shim). */
export function withoutModes(def: Definition, ctx: Context, name: string): Definition {
  if (def["@mcp.wrap.modes"] === undefined) return def;
  ctx.diagnostics.push({
    level: "warn",
    code: "V1_ANNOTATION",
    target: name,
    message: `@mcp.wrap.modes on ${name} has no effect: v1 applied it only with @mcp.wrap.tools. Write @mcp and @mcp.wrap.modes instead`,
  });
  const { "@mcp.wrap.modes": _modes, ...rest } = def;
  return rest;
}

/** v1's `@mcp.elicit: ['input']` asked for every parameter: map it to their names (v1 shim). */
export function mapV1Input(
  name: string,
  values: string[],
  params: FieldSpec[],
  ctx: Context,
): string[] {
  if (!values.includes("input") || params.some((p) => p.name === "input")) return values;
  const names = params.map((p) => p.name);
  ctx.diagnostics.push({
    level: "warn",
    code: "V1_ANNOTATION",
    target: name,
    message: names.length
      ? `@mcp.elicit 'input' is v1: mapped to the parameter names (${names.join(", ")}). List them instead`
      : `@mcp.elicit 'input' is v1: mapped to 'confirm' (${name} has no parameters). Write ['confirm'] instead`,
  });
  // v1's 'input' meant "ask for the parameters"; without parameters there is only 'confirm'.
  const asked = names.length ? names : ["confirm"];
  const mapped = values.flatMap((entry) => (entry === "input" ? asked : [entry]));
  return [...new Set(mapped)];
}

/** The V1_ANNOTATION message for a v1 key: what the shim mapped it to, or why it is dropped. */
export function v1Message(key: string, value: unknown, where: V1Where): string | undefined {
  const { target } = where;
  const known = V1[key];
  if (known) return known(value, where);
  if (V1_HINT.test(key))
    return `${key} is v1 and has no effect: use @mcp.description on the entity`;
  if (key === "@mcp.resource" && Array.isArray(value) && where.wrapToolsOff) {
    return `@mcp.resource with a list of query options is v1 and has no effect on ${target} with @mcp.wrap.tools: false. In v2, @mcp.resource means single records by key`;
  }
  if (key === "@mcp.resource" && Array.isArray(value)) {
    const elsewhere = v1OptInMessage("@mcp.resource", value, where, "entity");
    if (elsewhere)
      return `@mcp.resource with a list of query options is v1${elsewhere.slice("@mcp.resource is v1".length)}`;
    return `@mcp.resource with a list of query options is v1: mapped to @mcp on ${target} (query and get tools). Write @mcp instead; in v2, @mcp.resource means single records by key`;
  }
  return undefined;
}
