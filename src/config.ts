import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "./schema-mapper";
import type { Diagnostic } from "./types";

/**
 * `cds.env.mcp` (docs/annotations.md, Configuration): camelCase keys, read through cds.env only.
 * No key turns a feature on. Checked once at startup: an unknown key is a warning, a value of
 * the wrong shape an error, and the plugin then uses that key's default.
 */
export interface McpConfig {
  path?: string;
  name?: string;
  version?: string;
  allowedOrigins?: string[];
  /**
   * Multitenant XSUAA: a regular expression over the request host whose first capture group is
   * the subscriber's subdomain (like the approuter's TENANT_HOST_PATTERN). Off by default.
   */
  tenantHostPattern?: string;
  /** Server instructions: the text, or a file relative to the app root. */
  instructions?: string | { file: string };
  limits?: Partial<Limits>;
}

type Check = (value: unknown) => string | undefined;

const isString = (v: unknown): v is string => typeof v === "string";
const string: Check = (v) => (isString(v) && v.length > 0 ? undefined : "a non-empty string");
const positiveInteger: Check = (v) =>
  Number.isInteger(v) && (v as number) > 0 ? undefined : "a positive integer";

const CHECKS: Record<Exclude<keyof McpConfig, "limits">, Check> = {
  path: (v) => (isString(v) && v.startsWith("/") ? undefined : 'a path starting with "/"'),
  name: string,
  version: string,
  allowedOrigins: (v) =>
    Array.isArray(v) && v.every(isString) ? undefined : "a list of origins (strings)",
  tenantHostPattern: string,
  instructions: (v) =>
    (isString(v) && v.length > 0) ||
    (isObject(v) && Object.keys(v).join() === "file" && isString(v.file))
      ? undefined
      : "a string, or { file } naming a file relative to the app root",
};
const LIMITS: Record<keyof Limits, Check> = {
  maxRows: positiveInteger,
  defaultRows: positiveInteger,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readConfig(raw: unknown): { config: McpConfig; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const unknown = (target: string) =>
    diagnostics.push({
      level: "warn",
      code: "UNKNOWN_CONFIG",
      target,
      message: `Unknown setting ${target}; it has no effect`,
    });
  const invalid = (target: string, message: string) =>
    diagnostics.push({ level: "error", code: "INVALID_CONFIG", target, message });
  if (raw === undefined || raw === null) return { config: {}, diagnostics };
  if (!isObject(raw)) {
    invalid(
      "cds.mcp",
      `cds.mcp must be an object${isString(raw) ? " (a JSON string is not read)" : ""}; using the defaults`,
    );
    return { config: {}, diagnostics };
  }

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = `cds.mcp.${key}`;
    if (key === "limits") {
      config.limits = readLimits(value, invalid, unknown);
      continue;
    }
    const check = CHECKS[key as keyof typeof CHECKS];
    if (!check) {
      unknown(target);
      continue;
    }
    const expected = check(value);
    if (expected) invalid(target, `${target} must be ${expected}; using the default`);
    else config[key] = value;
  }
  return { config: config as McpConfig, diagnostics };
}

function readLimits(
  value: unknown,
  invalid: (target: string, message: string) => void,
  unknown: (target: string) => void,
): Partial<Limits> {
  const limits: Partial<Limits> = {};
  if (!isObject(value)) {
    invalid("cds.mcp.limits", "cds.mcp.limits must be an object; using the defaults");
    return limits;
  }
  for (const [key, v] of Object.entries(value)) {
    const target = `cds.mcp.limits.${key}`;
    const check = LIMITS[key as keyof Limits];
    if (!check) unknown(target);
    else if (check(v)) invalid(target, `${target} must be ${check(v)}; using the default`);
    else limits[key as keyof Limits] = v as number;
  }
  const max = limits.maxRows ?? DEFAULT_LIMITS.maxRows;
  if (limits.defaultRows !== undefined && limits.defaultRows > max) {
    invalid(
      "cds.mcp.limits.defaultRows",
      `cds.mcp.limits.defaultRows (${limits.defaultRows}) is above maxRows (${max}); using ${max}`,
    );
    limits.defaultRows = max;
  } else if (limits.defaultRows === undefined && DEFAULT_LIMITS.defaultRows > max) {
    limits.defaultRows = max;
  }
  return limits;
}

/** The server instructions, read once at startup; a file is relative to the app root. */
export function readInstructions(
  value: McpConfig["instructions"],
  root: string,
): { text?: string; diagnostic?: Diagnostic } {
  if (value === undefined) return {};
  if (isString(value)) return { text: value };
  try {
    return { text: readFileSync(path.resolve(root, value.file), "utf8") };
  } catch {
    return {
      diagnostic: {
        level: "error",
        code: "INVALID_CONFIG",
        target: "cds.mcp.instructions",
        message: `cds.mcp.instructions file ${value.file} cannot be read; serving without instructions`,
      },
    };
  }
}
