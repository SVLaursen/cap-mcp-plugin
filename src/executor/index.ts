import { NotImplementedError } from "../errors";
import { DEFAULT_LIMITS, OPERATORS, type Limits } from "../schema-mapper";
import type { EntitySpec, ExposureSpec, FieldSpec, ToolSpec } from "../types";

/** The executor's view of a CAP service. A structural subset of cds.Service. */
export interface ServiceLike {
  name: string;
  run(query: unknown): Promise<unknown>;
  send(request: {
    event: string;
    entity?: string;
    data?: unknown;
    params?: unknown[];
  }): Promise<unknown>;
}

export interface ToolResult {
  /** Machine-readable result matching the tool's outputSchema; `{ error }` for tool errors. */
  structuredContent?: unknown;
  /** Short human/LLM-readable rendering (one block, not one per row). */
  text: string;
  isError?: boolean;
  /** resource_link items for records with @mcp.resource. */
  links?: { uri: string; name: string }[];
}

export interface ExecutorOptions {
  limits?: Limits;
}

/**
 * A tool call the agent can fix: a bad argument, a missing record. Becomes an `isError` result,
 * never a protocol error, so the agent sees what went wrong.
 */
export class ToolError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "NOT_FOUND",
    message: string,
    readonly target?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

type Args = Record<string, unknown>;

/**
 * executor (milestone M3)
 *
 * Turns a validated tool call into CQN objects and runs it through the CAP service.
 *
 * Contract:
 * - Always `srv.run(cqn)` / `srv.send(...)` inside the request's cds.context. Never a manual
 *   transaction, never a raw DB call, never string-built CQN (build CQN objects).
 * - Search uses CAP's search function over the spec's search columns (@cds.search minus
 *   @mcp.omit), so omitted fields are never selected, searched, filtered on or ordered by.
 * - Paging returns { rows, total, nextCursor }; count ignores limit/offset/orderBy.
 * - `get` of a missing key is a NOT_FOUND tool error, not `null`.
 * - CAP errors keep code, target and details (req.error) in the tool error.
 * - Failed commits surface as errors (CAP's own transaction handling guarantees this when we
 *   do not swallow).
 * - Draft-enabled entities: writes go through the draft API or are refused clearly.
 * - Arguments are checked here as well as by the SDK against the input schema: compact tools
 *   have open schemas, and the executor must never trust a field name it did not expose.
 */
export class Executor {
  private readonly entities: Map<string, EntitySpec>;
  private readonly limits: Limits;

  constructor(spec: ExposureSpec, options: ExecutorOptions = {}) {
    this.entities = new Map(spec.services.flatMap((s) => s.entities.map((e) => [e.name, e])));
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  async execute(tool: ToolSpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    try {
      return await this.dispatch(tool, args, service);
    } catch (error) {
      if (error instanceof ToolError) return toolError(error);
      throw error;
    }
  }

  private dispatch(tool: ToolSpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    const target = tool.target;
    if (target.kind === "entity") {
      const entity = this.entity(target.entity);
      if (target.mode === "query") return this.query(entity, args, service);
      if (target.mode === "get") return this.get(entity, args, service);
    }
    if (target.kind === "compact" && (target.action === "query" || target.action === "get")) {
      const { entity: name, key, ...rest } = args;
      const entity = this.entity(String(name), target.service, target.action);
      if (target.action === "query") return this.query(entity, rest, service);
      return this.get(entity, object(key, "key"), service);
    }
    throw new NotImplementedError(`execute(${target.kind})`, "M3");
  }

  /** The entity a call names, which must be exposed (and in `service`, for compact tools). */
  private entity(name: string, service?: string, mode?: "query" | "get"): EntitySpec {
    const entity = this.entities.get(name);
    if (!entity || (service && entity.service !== service) || (mode && !entity.modes.has(mode))) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${name}`, "entity");
    }
    return entity;
  }

  private async query(entity: EntitySpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    allowOnly(args, ["q", "where", "orderby", "select", "top", "cursor"]);
    const fields = byName(entity.fields);
    const columns = (list(args.select, "select") ?? [...fields.keys()]).map((name) =>
      ref(field(fields, String(name), "select").name),
    );
    const where = and(conditions(fields, args.where), search(entity, args.q));
    const orderBy = [
      ...(list(args.orderby, "orderby") ?? []).map((o) => sortBy(fields, o)),
      // Keys last, so pages are stable and neither overlap nor skip.
      ...entity.keys.map((k) => ({ ref: [k.name], sort: "asc" })),
    ];
    const top = integer(args.top ?? this.limits.defaultRows, "top", 1, this.limits.maxRows);
    const offset = decodeCursor(args.cursor);
    const from = { ref: [entity.name] };
    const rows = (await service.run({
      SELECT: {
        from,
        columns,
        ...(where.length && { where }),
        orderBy,
        limit: { rows: { val: top }, offset: { val: offset } },
      },
    })) as Args[];
    // A separate count: no limit, offset or order (v1 finding #6).
    const counted = (await service.run({
      SELECT: {
        one: true,
        from,
        columns: [{ func: "count", args: ["*"], as: "total" }],
        ...(where.length && { where }),
      },
    })) as { total: number | string } | undefined;
    const total = Number(counted?.total ?? 0);
    const next = offset + rows.length;
    return result(
      { rows, total, ...(next < total && rows.length > 0 && { nextCursor: encodeCursor(next) }) },
      resourceLinks(entity, rows),
    );
  }

  private async get(entity: EntitySpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    const key = keyOf(entity, args);
    const row = (await service.run({
      SELECT: {
        one: true,
        from: { ref: [entity.name] },
        columns: entity.fields.map((f) => ref(f.name)),
        where: and(...Object.entries(key).map(([name, value]) => [ref(name), "=", { val: value }])),
      },
    })) as Args | undefined;
    if (!row) {
      throw new ToolError("NOT_FOUND", `No ${entity.title} with ${JSON.stringify(key)}`);
    }
    return result(row, resourceLinks(entity, [row]));
  }
}

/** Exactly the entity's keys, each of its type. */
function keyOf(entity: EntitySpec, args: Args): Args {
  allowOnly(
    args,
    entity.keys.map((k) => k.name),
  );
  return Object.fromEntries(
    entity.keys.map((k) => {
      if (args[k.name] === undefined) {
        throw new ToolError("INVALID_ARGUMENT", `Missing key ${k.name}`, k.name);
      }
      return [k.name, value(k, args[k.name], k.name)];
    }),
  );
}

const COMPARISONS: Record<string, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  ge: ">=",
  lt: "<",
  le: "<=",
};
const TEXT_FUNCTIONS = new Set(["contains", "startswith", "endswith"]);
const STRING_TYPES = new Set(["cds.String", "cds.LargeString"]);

function conditions(fields: Map<string, FieldSpec>, where: unknown): unknown[] {
  return and(
    ...(list(where, "where") ?? []).map((condition, i) => {
      const c = object(condition, `where[${i}]`);
      allowOnly(c, ["field", "op", "value"]);
      const f = field(fields, String(c.field), `where[${i}].field`);
      const op = String(c.op);
      if (!OPERATORS.includes(op)) {
        throw new ToolError("INVALID_ARGUMENT", `Unknown operator ${op}`, `where[${i}].op`);
      }
      const at = `where[${i}].value`;
      if (op === "in") {
        if (!Array.isArray(c.value))
          throw new ToolError("INVALID_ARGUMENT", "'in' needs an array", at);
        return [ref(f.name), "in", { list: c.value.map((v) => ({ val: value(f, v, at) })) }];
      }
      if (TEXT_FUNCTIONS.has(op)) {
        if (!STRING_TYPES.has(f.cdsType)) {
          throw new ToolError(
            "INVALID_ARGUMENT",
            `'${op}' needs a string field; ${f.name} is not one`,
            at,
          );
        }
        return [{ func: op, args: [ref(f.name), { val: value(f, c.value, at) }] }];
      }
      const val = c.value === null && (op === "eq" || op === "ne") ? null : value(f, c.value, at);
      return [
        ref(f.name),
        val === null ? (op === "eq" ? "is" : "is not") : COMPARISONS[op],
        { val },
      ];
    }),
  );
}

/** CAP's search function over exactly the spec's columns, never CAP's default (all Strings). */
function search(entity: EntitySpec, q: unknown): unknown[] {
  if (q === undefined || q === "") return [];
  if (typeof q !== "string") throw new ToolError("INVALID_ARGUMENT", "q must be a string", "q");
  if (entity.search.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", `${entity.title} has nothing to search`, "q");
  }
  const refs = entity.search.map((path) => ({ ref: path.split(".") }));
  return [{ func: "search", args: [refs.length === 1 ? refs[0] : { list: refs }, { val: q }] }];
}

function sortBy(fields: Map<string, FieldSpec>, entry: unknown) {
  const o = object(entry, "orderby");
  allowOnly(o, ["field", "dir"]);
  const dir = o.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc")
    throw new ToolError("INVALID_ARGUMENT", "dir is asc or desc", "orderby");
  return { ref: [field(fields, String(o.field), "orderby").name], sort: dir };
}

/** A value for this field's type; numeric strings are fine where CAP takes them. */
function value(f: FieldSpec, v: unknown, at: string): unknown {
  const t = f.cdsType;
  const ok =
    t === "cds.Boolean"
      ? typeof v === "boolean"
      : [
            "cds.Integer",
            "cds.Int16",
            "cds.Int32",
            "cds.UInt8",
            "cds.Double",
            "cds.hana.REAL",
            "cds.hana.TINYINT",
            "cds.hana.SMALLINT",
          ].includes(t)
        ? typeof v === "number"
        : [
              "cds.Int64",
              "cds.Integer64",
              "cds.Decimal",
              "cds.DecimalFloat",
              "cds.hana.SMALLDECIMAL",
            ].includes(t)
          ? typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))
          : typeof v === "string";
  if (!ok)
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${JSON.stringify(v)} is not a valid ${t.replace("cds.", "")} for ${f.name}`,
      at,
    );
  return v;
}

function field(fields: Map<string, FieldSpec>, name: string, at: string): FieldSpec {
  const f = fields.get(name);
  if (!f) throw new ToolError("INVALID_ARGUMENT", `Unknown field ${name}`, at);
  return f;
}

function allowOnly(args: Args, allowed: string[]): void {
  const extra = Object.keys(args).find((k) => !allowed.includes(k) && args[k] !== undefined);
  if (extra) throw new ToolError("INVALID_ARGUMENT", `Unexpected argument ${extra}`, extra);
}

function list(v: unknown, at: string): unknown[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ToolError("INVALID_ARGUMENT", `${at} must be an array`, at);
  return v;
}

function object(v: unknown, at: string): Args {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ToolError("INVALID_ARGUMENT", `${at} must be an object`, at);
  }
  return v as Args;
}

function integer(v: unknown, at: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    throw new ToolError("INVALID_ARGUMENT", `${at} must be an integer from ${min} to ${max}`, at);
  }
  return v as number;
}

/** Join condition token lists with `and`, wrapping each so `or` inside one stays contained. */
function and(...parts: unknown[][]): unknown[] {
  const present = parts.filter((p) => p.length > 0);
  if (present.length <= 1) return present[0] ?? [];
  return present.flatMap((p, i) => [...(i ? ["and"] : []), { xpr: p }]);
}

const ref = (name: string) => ({ ref: [name] });
const byName = (fields: FieldSpec[]) => new Map(fields.map((f) => [f.name, f]));

/** Stateless paging: the cursor is just the next offset, opaque to the agent. */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(String(cursor), "base64url").toString()) as {
      offset: unknown;
    };
    if (Number.isInteger(offset) && (offset as number) >= 0) return offset as number;
  } catch {
    // fall through
  }
  throw new ToolError("INVALID_ARGUMENT", "cursor is not one this server returned", "cursor");
}

/** `cap://<Service>/<Entity>/<key>`; composite keys as `k1=v1;k2=v2` (ADR 0006). */
function resourceLinks(entity: EntitySpec, rows: Args[]): ToolResult["links"] {
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

function result(structuredContent: unknown, links?: ToolResult["links"]): ToolResult {
  return { structuredContent, text: JSON.stringify(structuredContent), ...(links && { links }) };
}

function toolError(error: ToolError): ToolResult {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.target && { target: error.target }),
  };
  return {
    isError: true,
    structuredContent: { error: body },
    text: `${error.code}: ${error.message}`,
  };
}
