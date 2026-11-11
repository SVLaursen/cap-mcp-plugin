import type { Diagnostic, FieldSpec, ServiceSpec } from "../types";
import { isMappedType } from "../schema-mapper";
import {
  type Definition,
  type Context,
  serviceNames,
  serviceOf,
  sourceOf,
  isCopied,
  writtenAt,
  isExcluded,
  isGenerated,
} from "./definitions";
import { v1Message } from "./v1";
import { isOptedIn } from "./opt-in";

/**
 * Diagnostics about annotations: unknown keys, keys that have no effect where they are, types MCP
 * cannot map, completion where nothing completes.
 */

/** Every annotation key v2 understands. Anything else under `@mcp.` is a diagnostic. */
export const KNOWN = new Set([
  "@mcp",
  "@mcp.name",
  "@mcp.description",
  "@mcp.hint",
  "@mcp.omit",
  "@mcp.wrap.modes",
  "@mcp.deepInsert",
  "@mcp.resource",
  "@mcp.prompts",
  "@mcp.ui",
  "@mcp.elicit",
  "@mcp.completion",
  "@mcp.describe",
  "@mcp.compact",
]);

/**
 * Feature annotations (@mcp.*) on a service, entity or operation that ends up not exposed have
 * no effect; say so instead of failing silently. Definitions excluded on purpose (@mcp: false,
 * @cds.api.ignore) and ones already reported as errors are skipped.
 */
export function checkUnused(ctx: Context, services: ServiceSpec[]): void {
  const exposed = new Set(
    services.flatMap((s) => [
      s.name,
      ...s.entities.map((e) => e.name),
      ...s.operations.map((o) => o.name),
    ]),
  );
  const reported = new Set(ctx.diagnostics.filter((d) => d.level === "error").map((d) => d.target));
  const report = (target: string, def: Definition) => {
    if (exposed.has(target) || reported.has(target) || isExcluded(def)) return;
    // Annotations CAP copied from another layer are meant for the MCP services that project
    // it; in other services they are expected to do nothing.
    const keys = Object.keys(def).filter(
      (key) =>
        key.startsWith("@mcp.") && KNOWN.has(key) && !isCopied(def, key as `@${string}`, ctx),
    );
    if (keys.length === 0) return;
    ctx.diagnostics.push({
      level: "warn",
      code: "UNUSED_ANNOTATION",
      target,
      message: `${keys.join(", ")} on ${target} has no effect: ${target} is not exposed over MCP`,
    });
  };
  const names = serviceNames(ctx.definitions);
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "service") {
      report(name, def);
      continue;
    }
    const service = serviceOf(name, names);
    if (!service || isExcluded(ctx.definitions[service] ?? {})) continue;
    if (def.kind === "function" || def.kind === "action") report(name, def);
    if (def.kind !== "entity" || isExcluded(def)) continue;
    if (isGenerated(name, def, ctx.definitions) && !isOptedIn(def)) continue;
    report(name, def);
    for (const [action, op] of Object.entries(def.actions ?? {})) report(`${name}.${action}`, op);
  }
}

/**
 * @mcp.completion completes the `{key}` of an @mcp.resource template, so it has an effect only
 * on the single key of such an entity. Elsewhere it is reported, unless CAP copied it here from
 * the entity this one projects (meant for the services where it does apply).
 */
export function checkCompletion(
  name: string,
  def: Definition,
  fields: FieldSpec[],
  ctx: Context,
): void {
  const keys = fields.filter((f) => f.key);
  const completes = def["@mcp.resource"] === true && keys.length === 1;
  const source = sourceOf(def, ctx)?.elements ?? {};
  for (const field of fields.filter((f) => f.completion)) {
    if (completes && field.key) continue;
    if (source[field.name]?.["@mcp.completion"] === true) continue;
    const why = !field.key
      ? "it completes the key of an @mcp.resource entity, and this is not a key"
      : def["@mcp.resource"] !== true
        ? "it completes resource keys, and this entity has no @mcp.resource"
        : "it completes a single key, and this entity's resource key is composite";
    unusedCompletion(ctx, `${name}:${field.name}`, why);
  }
}

export function unusedCompletion(ctx: Context, target: string, why: string): void {
  ctx.diagnostics.push({
    level: "warn",
    code: "UNUSED_ANNOTATION",
    target,
    message: `@mcp.completion on ${target} has no effect: ${why} (MCP completes resource-template variables and prompt arguments, not tool arguments)`,
  });
}

/**
 * Report unknown and v1 `@mcp.*` keys anywhere in the model, exposed or not, so a typo is never
 * a silent no-op. Targets: `Def`, `Def:element`, `Def.boundOp`, `Op:param`.
 *
 * CAP copies an entity's (and its elements') annotations to every projection of it. A key
 * copied that way is reported once, where it was written, naming the copies.
 */
export function checkAnnotations(ctx: Context): void {
  const reported = new Map<string, Diagnostic>();
  const copies = new Map<string, string[]>();
  const services = serviceNames(ctx.definitions);
  const check = (target: string, def: Definition, writtenAt?: (key: string) => string) => {
    const inService = serviceOf(target, services) !== undefined;
    for (const [key, diagnostic] of checkKeys(target, def, inService)) {
      const origin = writtenAt?.(key) ?? target;
      if (origin === target) {
        ctx.diagnostics.push(diagnostic);
        reported.set(`${target} ${key}`, diagnostic);
      } else copies.set(`${origin} ${key}`, [...(copies.get(`${origin} ${key}`) ?? []), target]);
    }
  };
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "entity" && isGenerated(name, def, ctx.definitions)) continue;
    check(name, def, (key) => writtenAt(name, key, ctx));
    for (const [element, el] of Object.entries(def.elements ?? {})) {
      check(`${name}:${element}`, el, (key) => writtenAt(name, key, ctx, element));
    }
    // Only entities have bound actions; a linked service also lists its unbound ones here.
    const bound = def.kind === "entity" ? def.actions : undefined;
    for (const [action, op] of Object.entries(bound ?? {})) {
      check(`${name}.${action}`, op);
      for (const [param, p] of Object.entries(op.params ?? {})) {
        check(`${name}.${action}:${param}`, p);
      }
    }
    for (const [param, p] of Object.entries(def.params ?? {})) {
      check(`${name}:${param}`, p);
    }
  }
  for (const [at, targets] of copies) {
    const diagnostic = reported.get(at);
    if (diagnostic) diagnostic.message += ` (CAP copied it to ${targets.sort().join(", ")})`;
  }
}

export function checkKeys(
  target: string,
  def: Definition,
  inService: boolean,
): [string, Diagnostic][] {
  const found: [string, Diagnostic][] = [];
  for (const key of Object.keys(def)) {
    if (key !== "@mcp" && !key.startsWith("@mcp.")) continue;
    const v1 = v1Message(key, def[key as `@${string}`], {
      target,
      kind: def.kind,
      inService,
      wrapToolsOff: def["@mcp.wrap.tools"] === false,
    });
    if (v1) {
      found.push([key, { level: "warn", code: "V1_ANNOTATION", target, message: v1 }]);
    } else if (!KNOWN.has(key)) {
      found.push([
        key,
        {
          level: "warn",
          code: "UNKNOWN_ANNOTATION",
          target,
          message: `Unknown annotation ${key} on ${target}; it has no effect`,
        },
      ]);
    }
  }
  return found;
}

export function checkTypes(ctx: Context, owner: string, fields: FieldSpec[]): void {
  for (const field of fields) {
    if (isMappedType(field.cdsType)) continue;
    ctx.diagnostics.push({
      level: "warn",
      code: "UNSUPPORTED_TYPE",
      target: `${owner}:${field.name}`,
      message: `${field.cdsType || "this type"} has no JSON Schema mapping; agents see ${field.name} as any value`,
    });
  }
}
