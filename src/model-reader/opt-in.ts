import { type Definition, type Context, isCopied, isExcluded } from "./definitions";
import { v1OptIn } from "./v1";

/** Opt-in rules (ADR 0004): what exposes a definition, @mcp or a v1 key the shim maps to it. */

/** Actions need their own @mcp; functions come with the service baseline (ADR 0004). */
export function exposesOperation(op: Definition, serviceOptedIn: boolean): boolean {
  if (isExcluded(op)) return false;
  return isOptedIn(op) || (op.kind === "function" && serviceOptedIn);
}

/** `@mcp`, or a v1 annotation the shim maps to it (v1OptIn). */
export function isOptedIn(def: Definition): boolean {
  return def["@mcp"] === true || v1OptIn(def) !== undefined;
}

/** Opted in here, not by an annotation CAP copied from the projected entity. */
export function isOwnOptIn(def: Definition, ctx: Context): boolean {
  if (def["@mcp"] === true) return !isCopied(def, "@mcp", ctx);
  const v1 = v1OptIn(def);
  return v1 !== undefined && !isCopied(def, v1, ctx);
}
