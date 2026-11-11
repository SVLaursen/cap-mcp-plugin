import type { EntitySpec, FieldSpec } from "../types";
import type { Args } from "./arguments";
import { ToolError } from "./errors";
import type { ToolResult } from "./results";

/**
 * @mcp.resource records (ADR 0006): their `cap://<Service>/<Entity>/<key>` URIs,
 * and the key segment read back from a URI.
 */

/** `cap://<Service>/<Entity>/<key>`; composite keys as `k1=v1;k2=v2`. */
export function resourceLinks(entity: EntitySpec, rows: Args[]): ToolResult["links"] {
  if (!entity.resource) return undefined;
  const local = entity.name.slice(entity.service.length + 1);
  return rows.map((row) => {
    const key =
      entity.keys.length === 1
        ? encodeURIComponent(String(row[entity.keys[0]?.name ?? ""]))
        : entity.keys.map((k) => `${k.name}=${encodeURIComponent(String(row[k.name]))}`).join(";");
    return {
      uri: `cap://${entity.service}/${local}/${key}`,
      name: `${entity.name} ${decodeURIComponent(key)}`,
    };
  });
}

/** Integer types whose key values arrive as digits in a URI; others stay strings. */
const URI_NUMBERS = new Set(["cds.Integer", "cds.UInt8", "cds.Int16", "cds.Int32"]);

/** The inverse of resourceLinks' key: typed as the key fields are, checked by keyOf. */
export function parseResourceKey(entity: EntitySpec, segment: string): Args {
  const typed = (spec: FieldSpec | undefined, raw: string): unknown => {
    let text: string;
    try {
      text = decodeURIComponent(raw);
    } catch {
      throw new ToolError("INVALID_ARGUMENT", `${raw} is not a valid key`, spec?.name);
    }
    if (spec && URI_NUMBERS.has(spec.cdsType) && /^-?\d+$/.test(text)) return Number(text);
    if (spec?.cdsType === "cds.Boolean" && (text === "true" || text === "false"))
      return text === "true";
    return text;
  };
  const only = entity.keys.length === 1 ? entity.keys[0] : undefined;
  if (only) return { [only.name]: typed(only, segment) };
  const pairs = segment.split(";").map((part) => {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    const spec = entity.keys.find((k) => k.name === name);
    return [name, typed(spec, part.slice(at + 1))] as const;
  });
  return Object.fromEntries(pairs);
}
