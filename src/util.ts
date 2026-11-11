/** Small helpers shared by several modules. Pure: no `cds`, no I/O. */

/** A plain object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A CDS builtin's name as people write it: `cds.Integer` → `Integer`. */
export function typeName(cdsType: string): string {
  return cdsType.replace(/^cds\./, "");
}

/**
 * Code-point order, the same on every machine (localeCompare depends on the locale). Tool
 * lists must be in a deterministic order so clients can cache them.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** For `sort`: by `name`, in code-point order. */
export function byNameOrder(a: { name: string }, b: { name: string }): number {
  return compareText(a.name, b.name);
}
