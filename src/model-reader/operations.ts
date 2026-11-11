import type { FieldSpec, OperationSpec } from "../types";
import {
  type Definition,
  type Context,
  invalid,
  roles,
  strings,
  title,
  describe,
  grants,
} from "./definitions";
import { mapV1Input } from "./v1";
import { checkTypes, unusedCompletion } from "./checks";
import { readField, readReturns } from "./fields";

/** Actions and functions as OperationSpecs: parameters, return type, @mcp.elicit, @mcp.ui. */

export function readOperation(
  name: string,
  service: string,
  def: Definition,
  ctx: Context,
  boundTo?: string,
): OperationSpec {
  const params = Object.entries(def.params ?? {})
    .filter(([, p]) => (p.items ?? p).type !== "$self") // CAP's binding parameter
    .map(([param, p]) => readField(param, p));
  checkTypes(ctx, name, params);
  for (const param of params.filter((p) => p.completion)) {
    unusedCompletion(ctx, `${name}:${param.name}`, "this is a tool argument");
  }
  return {
    name,
    service,
    kind: def.kind === "function" ? "function" : "action",
    title: title(name, def),
    boundTo,
    description: describe(def),
    params,
    returns: readReturns(def.returns, ctx),
    requires: roles(def),
    restrict: grants(def)?.map(({ to }) => ({ grant: name.slice(name.lastIndexOf(".") + 1), to })),
    elicit: readElicit(name, def["@mcp.elicit"], params, ctx),
    ui: readUi(name, def, ctx),
  };
}

/**
 * `@mcp.elicit`: `['confirm']` and/or parameter names to ask the user for. Any other value is
 * diagnosed, but whatever was written still asks for confirmation: a typo must never switch it
 * off. The flag form (`@mcp.elicit` alone) means `['confirm']`; `[]` asks nothing.
 */
export function readElicit(
  name: string,
  value: unknown,
  params: FieldSpec[],
  ctx: Context,
): string[] | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return ["confirm"];
  if (!Array.isArray(value)) {
    invalid(
      ctx,
      name,
      `@mcp.elicit must be a list ('confirm' or parameter names); the call is still confirmed`,
    );
    return ["confirm"];
  }
  const raw = strings(value) ?? [];
  if (raw.length < value.length) {
    invalid(ctx, name, `@mcp.elicit values must be strings; the call is still confirmed`);
    if (!raw.length) return ["confirm"];
  }
  const values = mapV1Input(name, raw, params, ctx);
  for (const v of values) {
    if (v !== "confirm" && !params.some((p) => p.name === v)) {
      invalid(
        ctx,
        name,
        `@mcp.elicit value ${v} is neither 'confirm' nor a parameter of ${name}; the call is still confirmed`,
      );
    }
  }
  if (!values.length) {
    invalid(ctx, name, `@mcp.elicit is an empty list; the call is still confirmed`);
    return ["confirm"];
  }
  return values;
}

/** MCP Apps UI resources live under ui:// (issue #133); anything else is a mistake. */
export function readUi(name: string, def: Definition, ctx: Context): string | undefined {
  const ui = def["@mcp.ui"];
  if (ui === undefined) return undefined;
  if (typeof ui === "string" && ui.startsWith("ui://")) return ui;
  invalid(ctx, name, `@mcp.ui must be a ui:// resource URI, got ${JSON.stringify(ui)}`);
  return undefined;
}
