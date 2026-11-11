import {
  DEFAULT_LIMITS,
  isOperator,
  elicitationSchema,
  queryLimits,
  type Limits,
} from "../schema-mapper";
import { view } from "../exposure-registry/access";
import type {
  EntityMode,
  EntitySpec,
  ExposureSpec,
  FieldSpec,
  JsonSchema,
  OperationSpec,
  PromptSpec,
  ServiceSpec,
  ToolSpec,
  UserLike,
} from "../types";
import { isObject, typeName } from "../util";

/** The executor's view of a CAP service. A structural subset of cds.Service. */
export interface ServiceLike {
  name: string;
  run(query: unknown): Promise<unknown>;
  send(request: {
    event?: string;
    entity?: string;
    query?: unknown;
    data?: unknown;
    params?: unknown;
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

/** Per call: whether the user confirmed it (@mcp.elicit, through MRTR), and with what values. */
export interface CallOptions {
  confirmed?: boolean;
  /**
   * The values the user gave in the confirmation form. Only the operation's @mcp.elicit
   * parameters are taken from it; they replace the agent's values and are checked like them.
   */
  confirmedArgs?: Record<string, unknown>;
}

/**
 * Map an error from execute() to an `isError` tool result, or undefined if it is not one the agent
 * can act on (bugs, 5xx, failed commits: the caller reports those as errors). Call it only AFTER
 * the transaction has rolled back: execute() throws so that CAP never commits partial work.
 */
export function errorResult(error: unknown): ToolResult | undefined {
  if (error instanceof ToolError) return toolError(error);
  const cap = capError(error);
  return cap && toolError(cap);
}

/**
 * A tool call the agent can fix: a bad argument, a missing record. Becomes an `isError` result,
 * never a protocol error, so the agent sees what went wrong.
 */
export class ToolError extends Error {
  constructor(
    readonly code:
      "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFIRMATION_REQUIRED" | "CONFIRMATION_DECLINED",
    message: string,
    readonly target?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * An @mcp.elicit operation that was not confirmed (nothing ran). Carries the form to show the
 * user: a client that can elicit asks with it (MRTR `input_required`) and retries.
 */
export class ConfirmationRequired extends ToolError {
  constructor(
    message: string,
    readonly request: { message: string; requestedSchema: JsonSchema },
  ) {
    super("CONFIRMATION_REQUIRED", message);
    this.name = "ConfirmationRequired";
  }
}

type Args = Record<string, unknown>;

/**
 * executor
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
  private readonly operations: Map<string, OperationSpec>;
  private readonly services: Map<string, ServiceSpec>;
  private readonly limits: Limits;

  constructor(spec: ExposureSpec, options: ExecutorOptions = {}) {
    this.entities = new Map(spec.services.flatMap((s) => s.entities.map((e) => [e.name, e])));
    this.services = new Map(spec.services.map((s) => [s.name, s]));
    this.operations = new Map(spec.services.flatMap((s) => s.operations.map((o) => [o.name, o])));
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  /** `user` is the caller (cds.context.user); describe tools only describe what it can reach. */
  async execute(
    tool: ToolSpec,
    args: Args,
    service: ServiceLike,
    user: UserLike,
    options: CallOptions = {},
  ): Promise<ToolResult> {
    // Errors propagate, so the caller's transaction rolls back; the caller maps them with
    // errorResult() afterwards. Catching them here would let CAP commit partial work.
    const target = tool.target;
    if (target.kind === "describe")
      return await this.describe(target.service, args, user, "describe");
    if (target.kind === "compact" && target.action === "describe_entity") {
      return await this.describe(target.service, args, user, "describe_entity");
    }
    if (target.kind === "compact" && target.action === "list_entities") {
      allowOnly(args, []);
      const reachable = this.reachable(target.service, user);
      return result({
        entities: reachable.entities.map((entity) =>
          clean({
            name: entity.name,
            title: entity.title,
            description: entity.description,
            modes: [...entity.modes].sort(),
          }),
        ),
      });
    }
    if (target.kind === "operation") {
      return await this.call(this.operation(target.operation), args, service, options);
    }
    if (target.kind === "compact" && target.action === "call_operation") {
      allowOnly(args, ["operation", "args"]);
      const op = this.operation(String(args.operation), target.service);
      return await this.call(
        op,
        args.args === undefined ? {} : object(args.args, "args"),
        service,
        options,
      );
    }
    return await this.dispatch(tool, args, service);
  }

  /**
   * One @mcp.resource record, addressed by the `{key}` segment of its URI (ADR 0006): the
   * value of a single key, or `k1=v1;k2=v2`, URI-encoded. Read as `get` does; anything that is
   * not such a record is NOT_FOUND or INVALID_ARGUMENT.
   */
  async readResource(entityName: string, key: string, service: ServiceLike): Promise<ToolResult> {
    const entity = this.entities.get(entityName);
    if (!entity?.resource || !entity.modes.has("get")) {
      throw new ToolError("NOT_FOUND", `${entityName} has no resources`);
    }
    return await this.get(entity, parseResourceKey(entity, key), service);
  }

  /**
   * Values for the `{key}` of an @mcp.resource template whose key has @mcp.completion: keys
   * that start with `value`, in key order, as the caller may read them (CAP applies @restrict).
   * At most MCP's 100, and never more than the entity's query limits, since CAP pages this query
   * too. One more than kept shows `hasMore`; when CAP's max is below 101 a full page is counted.
   */
  async completeKey(
    entityName: string,
    value: string,
    service: ServiceLike,
  ): Promise<{ values: string[]; hasMore: boolean }> {
    const entity = this.entities.get(entityName);
    const key = entity?.keys.length === 1 ? entity.keys[0] : undefined;
    if (!entity?.resource || !key?.completion) return { values: [], hasMore: false };
    const from = { ref: [entity.name] };
    const where = value ? [{ func: "startswith", args: [keyText(key), { val: value }] }] : [];
    const wanted = Math.min(MAX_COMPLETIONS, queryLimits(entity, this.limits).maxRows);
    // One more than we keep shows there are more, if CAP serves that many.
    const asked = wanted === MAX_COMPLETIONS ? wanted + 1 : wanted;
    const rows = ((await service.run({
      SELECT: {
        from,
        columns: [ref(key.name)],
        ...(where.length && { where }),
        orderBy: [{ ...ref(key.name), sort: "asc" }],
        limit: { rows: { val: asked } },
      },
    })) ?? []) as Args[];
    const values = rows.slice(0, wanted).map((row) => String(row[key.name]));
    if (rows.length > wanted) return { values, hasMore: true };
    if (asked > wanted || rows.length < wanted) return { values, hasMore: false };
    const counted = (await service.run({
      SELECT: {
        one: true,
        from,
        columns: [{ func: "count", args: ["*"], as: "total" }],
        ...(where.length && { where }),
      },
    })) as { total: number | string } | undefined;
    return { values, hasMore: Number(counted?.total ?? 0) > wanted };
  }

  private dispatch(tool: ToolSpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    const target = tool.target;
    if (target.kind === "entity") {
      const entity = this.entity(target.entity);
      const run = this.modes(entity, service)[target.mode];
      if (target.mode === "query") return run({}, args);
      // Per-entity tools take keys (and fields) at the top level.
      const isKey = (name: string) => entity.keys.some((k) => k.name === name);
      const keys = Object.fromEntries(Object.entries(args).filter(([k]) => isKey(k)));
      const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !isKey(k)));
      return target.mode === "create" ? run({}, args) : run(keys, rest);
    }
    if (target.kind === "compact" && isEntityAction(target.action)) {
      const { entity: name, key, data, ...rest } = args;
      const entity = this.entity(String(name), target.service, target.action);
      const run = this.modes(entity, service)[target.action];
      if (target.action === "query") return run({}, rest);
      allowOnly(rest, []);
      const keyArgs = target.action === "create" ? {} : object(key, "key");
      const writes = target.action === "create" || target.action === "update";
      return run(keyArgs, writes ? object(data, "data") : {});
    }
    // describe, list_entities, describe_entity and call_operation are handled in execute().
    throw new Error(`Unexpected tool target ${JSON.stringify(target)}`);
  }

  /** One runner per entity mode: (key, data) → result. */
  private modes(
    entity: EntitySpec,
    service: ServiceLike,
  ): Record<EntityMode, (key: Args, data: Args) => Promise<ToolResult>> {
    return {
      query: (_key, data) => this.query(entity, data, service),
      get: (key, data) => {
        allowOnly(data, []);
        return this.get(entity, key, service);
      },
      create: (_key, data) => this.create(entity, data, service),
      update: (key, data) => this.update(entity, key, data, service),
      delete: async (key, data) => {
        allowOnly(data, []);
        const address = keyOf(entity, key);
        // Keys in req.data as with OData's DELETE /Books(201): handlers rely on req.data.ID.
        const done = (await service.send({
          query: { DELETE: { from: addressed(entity, address) } },
          data: address,
        })) as Affected;
        if (affected(done) === 0) throw notFound(entity, address);
        return result({ deleted: address });
      },
    };
  }

  private async create(entity: EntitySpec, data: Args, service: ServiceLike): Promise<ToolResult> {
    refuseDraftChild(entity);
    const entry = this.writable(entity, structuredClone(data), "create");
    if (entity.draftRoot) {
      // A plain CREATE would only start a draft: NEW it, then SAVE (activate) it, so the app's
      // NEW and SAVE handlers run. One transaction: if SAVE fails, no draft is left behind.
      const [draft] = (await service.send({
        event: "NEW",
        entity: `${entity.name}.drafts`,
        data: entry,
      })) as Args[];
      const key = pick(draft ?? {}, entity);
      await service.send(activate(entity, key));
      return this.get(entity, key, service);
    }
    const written = (await service.run({
      INSERT: { into: { ref: [entity.name] }, entries: [entry] },
    })) as Args[];
    // Without an address (no keys, or an omitted one) a read-back could find another record.
    if (!entity.modes.has("get"))
      return result(
        project(
          entry,
          entity.fields.map((f) => f.name),
        ),
      );
    // CAP returns the written keys, generated ones included.
    return this.get(entity, pick(written[0] ?? entry, entity), service);
  }

  /**
   * Data the agent may write: fields that are not readonly, each of its type (null only where
   * optional), and @mcp.deepInsert compositions checked the same way against the child's own
   * fields, without its back link (CAP fills it). Keys can be given on create but never changed
   * by update. CAP checks the rest (@mandatory, @assert.*, handlers).
   */
  private writable(
    entity: EntitySpec,
    data: Args,
    mode: "create" | "update",
    backlink?: string,
  ): Args {
    const fields = byName(
      entity.fields.filter(
        (f) =>
          !f.readonly && (mode === "create" || !f.key) && (!backlink || f.association !== backlink),
      ),
    );
    const nested = new Map(entity.deepInsert.map((d) => [d.element, d]));
    for (const [name, given] of Object.entries(data)) {
      const deep = nested.get(name);
      if (deep) {
        const child = this.entities.get(deep.target);
        if (!child)
          throw new ToolError("INVALID_ARGUMENT", `Unknown field ${name}`, `data.${name}`);
        const items = deep.many ? given : [given];
        const notObject = given === null || typeof given !== "object";
        if (!Array.isArray(items) || (!deep.many && notObject)) {
          throw new ToolError(
            "INVALID_ARGUMENT",
            `${name} must be ${deep.many ? "an array" : "an object"}`,
            `data.${name}`,
          );
        }
        items.forEach((item, i) =>
          this.writable(child, object(item, `data.${name}[${i}]`), "create", deep.backlink),
        );
        continue;
      }
      const target = field(fields, name, `data.${name}`);
      if (given !== null || target.mandatory) value(target, given, `data.${name}`);
    }
    return data;
  }

  private async update(
    entity: EntitySpec,
    key: Args,
    data: Args,
    service: ServiceLike,
  ): Promise<ToolResult> {
    refuseDraftChild(entity);
    const address = keyOf(entity, key);
    const changes = this.writable(entity, structuredClone(data), "update");
    if (entity.draftRoot) return this.updateDraft(entity, address, changes, service);
    // req.data = changes plus keys, as with OData's PATCH /Books(201).
    const done = (await service.send({
      query: { UPDATE: { entity: addressed(entity, address), data: changes } },
      data: { ...changes, ...address },
    })) as Affected;
    if (affected(done) === 0) throw notFound(entity, address);
    return this.get(entity, address, service);
  }

  /**
   * EDIT → patch → SAVE, as a Fiori client does over OData, so SAVE handlers see the whole
   * record. (CAP's direct update of an active draft record gives them only the changed fields.)
   * EDIT is refused while someone else holds a draft; a failure rolls the draft back with the call.
   */
  private async updateDraft(
    entity: EntitySpec,
    address: Args,
    changes: Args,
    service: ServiceLike,
  ): Promise<ToolResult> {
    const version = (active: boolean) => ({
      ref: [{ id: entity.name, where: keyWhere({ ...address, IsActiveEntity: active }) }],
    });
    // An explicit query: CAP's @restrict-where check runs before the draft handler sets one.
    await service.send({
      event: "EDIT",
      query: { SELECT: { from: version(true) } },
      data: { ...address, IsActiveEntity: true },
    });
    await service.send({
      query: { UPDATE: { entity: version(false), data: changes } },
      data: { ...changes, ...address, IsActiveEntity: false },
    });
    await service.send(activate(entity, address));
    return this.get(entity, address, service);
  }

  /** The service as this caller can reach it (empty if not at all). */
  private reachable(name: string, user: UserLike): ServiceSpec {
    const service = this.services.get(name);
    const visible = service && view(service, user);
    if (!visible) throw new ToolError("INVALID_ARGUMENT", `Unknown service ${name}`);
    return visible;
  }

  /**
   * What a service exposes to this caller: its reachable entities (fields without @mcp.omit,
   * which never reach the spec) and operations. Nothing outside the service: an agent must not
   * learn about entities it cannot use.
   */
  private async describe(
    name: string,
    args: Args,
    user: UserLike,
    tool: "describe" | "describe_entity",
  ): Promise<ToolResult> {
    allowOnly(args, ["entity"]);
    const service = this.reachable(name, user);
    const wanted = args.entity === undefined ? undefined : String(args.entity);
    const entities = service.entities.filter((e) => wanted === undefined || e.name === wanted);
    if ((wanted !== undefined || tool === "describe_entity") && entities.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${String(args.entity)}`, "entity");
    }
    if (tool === "describe_entity") return result(describeEntity(entities[0] as EntitySpec));
    return result({
      service: clean({
        name: service.name,
        title: service.title,
        description: service.description,
      }),
      entities: entities.map(describeEntity),
      operations: wanted === undefined ? service.operations.map(describeOperation) : [],
    });
  }

  private operation(name: string, service?: string): OperationSpec {
    const op = this.operations.get(name);
    // Through a compact call_operation: only that service's operations, and not @mcp.ui ones
    // (they have their own tool).
    if (!op || (service !== undefined && (op.service !== service || op.ui !== undefined))) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown operation ${name}`, "operation");
    }
    return op;
  }

  /**
   * An operation through srv.send, so the app's `on` handler runs: unbound with its parameters
   * as req.data, bound with the instance key in req.params (as OData does). @mcp.elicit
   * operations only run once the user confirmed the call.
   */
  private async call(
    op: OperationSpec,
    args: Args,
    service: ServiceLike,
    options: CallOptions,
  ): Promise<ToolResult> {
    const bound = op.boundTo ? this.entities.get(op.boundTo) : undefined;
    const keyNames = bound?.keys.map((k) => k.name) ?? [];
    if (options.confirmed && options.confirmedArgs) {
      // The user's answers to the confirmation form win over the agent's values, for the fields
      // the form had (parameters a form cannot hold keep the agent's value).
      const asked = Object.keys(elicitationSchema(op, args).properties ?? {});
      const answers = Object.entries(options.confirmedArgs).filter(([k]) => asked.includes(k));
      args = { ...args, ...Object.fromEntries(answers) };
    }
    allowOnly(args, [...keyNames, ...op.params.map((p) => p.name)]);
    const data: Args = {};
    for (const param of op.params) {
      const given = args[param.name];
      if (given === undefined || (given === null && !param.mandatory)) continue;
      if (param.many) {
        if (!Array.isArray(given))
          throw new ToolError("INVALID_ARGUMENT", `${param.name} must be an array`, param.name);
        given.forEach((item, i) => value(param, item, `${param.name}[${i}]`));
      } else value(param, given, param.name);
      data[param.name] = given;
    }
    if (op.elicit?.length && !options.confirmed) {
      const key = bound ? ` for ${JSON.stringify(pickKeys(args, keyNames))}` : "";
      const given = Object.keys(data).length ? ` with ${JSON.stringify(data)}` : "";
      throw new ConfirmationRequired(`${op.title} needs the user's confirmation before it runs`, {
        message: `Confirm ${op.title}${key}${given}?`,
        requestedSchema: elicitationSchema(op, data),
      });
    }
    const event = op.name.slice(op.name.lastIndexOf(".") + 1);
    const returned = bound
      ? await service.send({
          event,
          entity: bound.name,
          data,
          // The key alone addresses the active record (CAP rejects IsActiveEntity here).
          params: [keyOf(bound, pickKeys(args, keyNames))],
        })
      : await service.send({ event, data });
    if (!op.returns) return { text: `${op.title} done` };
    const fields = op.returns.fields?.map((f) => f.name);
    // Only the fields the return type exposes (no @mcp.omit ones the handler happened to read).
    const shape = (item: unknown) => (fields && isObject(item) ? project(item, fields) : item);
    if (!op.returns.many) return result({ value: shape(returned ?? null) });
    // A list operation whose handler returns nothing returned an empty list (the schema says array).
    return result({ value: (Array.isArray(returned) ? returned : []).map(shape) });
  }

  /** The entity a call names, which must be exposed (and in `service`, for compact tools). */
  private entity(name: string, service?: string, mode?: EntityMode): EntitySpec {
    const entity = this.entities.get(name);
    if (!entity || (service && entity.service !== service) || (mode && !entity.modes.has(mode))) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${name}`, "entity");
    }
    return entity;
  }

  private async query(entity: EntitySpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    allowOnly(args, ["q", "where", "orderby", "select", "top", "cursor"]);
    const fields = byName(entity.fields);
    const wanted = list(args.select, "select");
    if (wanted && (wanted.length === 0 || new Set(wanted).size !== wanted.length)) {
      throw new ToolError("INVALID_ARGUMENT", "select needs distinct field names", "select");
    }
    const columns = (wanted ?? [...fields.keys()]).map((name) =>
      ref(field(fields, String(name), "select").name),
    );
    // Keys are always read (resource links need them) and dropped again by project().
    const read = [
      ...columns,
      ...entity.keys
        .filter((k) => !columns.some((c) => c.ref[0] === k.name))
        .map((k) => ref(k.name)),
    ];
    const where = and(conditions(fields, args.where), search(entity, args.q));
    const orderBy = [
      ...(list(args.orderby, "orderby") ?? []).map((o) => sortBy(fields, o)),
      // Keys last, so pages are stable and neither overlap nor skip.
      ...entity.keys.map((k) => ({ ref: [k.name], sort: "asc" })),
    ];
    // The limits the tool advertises: CAP's @cds.query.limit, capped by cds.mcp.limits.
    const limits = queryLimits(entity, this.limits);
    const top = integer(args.top ?? limits.defaultRows, "top", 1, limits.maxRows);
    const offset = decodeCursor(args.cursor);
    const from = { ref: [entity.name] };
    const rows = (await service.run({
      SELECT: {
        from,
        columns: read,
        ...(where.length && { where }),
        orderBy,
        limit: { rows: { val: top }, offset: { val: offset } },
      },
    })) as Args[];
    // A separate count, without limit, offset or order: counting the page would give its size.
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
    // Exactly what was selected: CAP adds keys and draft columns (IsActiveEntity) to draft reads.
    const selected = columns.map((c) => c.ref[0] as string);
    return result(
      {
        rows: rows.map((row) => project(row, selected)),
        total,
        ...(next < total && rows.length > 0 && { nextCursor: encodeCursor(next) }),
      },
      resourceLinks(entity, rows),
    );
  }

  private async get(entity: EntitySpec, args: Args, service: ServiceLike): Promise<ToolResult> {
    const key = keyOf(entity, args);
    const row = (await service.run({
      SELECT: {
        one: true,
        from: addressed(entity, key),
        columns: entity.fields.map((f) => ref(f.name)),
      },
    })) as Args | undefined;
    if (!row) throw notFound(entity, key);
    return result(
      project(
        row,
        entity.fields.map((f) => f.name),
      ),
      resourceLinks(entity, [row]),
    );
  }
}

function describeEntity(entity: EntitySpec) {
  return clean({
    name: entity.name,
    title: entity.title,
    description: entity.description,
    keys: entity.keys.map((k) => k.name),
    modes: [...entity.modes].sort(),
    fields: entity.fields.map(describeField),
  });
}

function describeOperation(op: OperationSpec) {
  const spec = op.returns;
  const returns =
    spec && (spec.scalar ? typeName(spec.scalar.cdsType) : (spec.entity ?? "structure"));
  return clean({
    name: op.name,
    title: op.title,
    kind: op.kind,
    description: op.description,
    boundTo: op.boundTo,
    params: op.params.map(describeField),
    returns: spec && (spec.many ? `array of ${returns}` : returns),
  });
}

function describeField(spec: FieldSpec) {
  return clean({
    name: spec.name,
    type: spec.many ? `array of ${typeName(spec.cdsType)}` : typeName(spec.cdsType),
    key: spec.key || undefined,
    mandatory: spec.mandatory || undefined,
    readonly: spec.readonly || undefined,
    description: spec.description,
    enum: spec.enum,
    length: spec.length,
    precision: spec.precision,
    scale: spec.scale,
    target: spec.target,
  });
}

/** Drop undefined properties, so descriptions only say what is there. */
function clean<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

type Affected = { affected?: number } | number | undefined;
const affected = (r: Affected) => (typeof r === "number" ? r : (r?.affected ?? 0));

const notFound = (entity: EntitySpec, key: Args) =>
  new ToolError("NOT_FOUND", `No ${entity.title} with ${JSON.stringify(key)}`);

/**
 * One record, addressed like OData's `Books(201)`: the key as a filter on the entity reference.
 * CAP then puts the key into req.data, which custom handlers rely on (req.data.ID).
 */
const keyWhere = (key: Args) =>
  and(...Object.entries(key).map(([name, val]) => [ref(name), "=", { val }]));

/**
 * SAVE as OData's draftActivate on the draft: CAP loads the whole draft into req.data for the
 * SAVE handlers (sending the key as data would make req.data just the key).
 */
const activate = (entity: EntitySpec, key: Args) => ({
  event: "draftActivate",
  query: {
    SELECT: {
      from: { ref: [{ id: entity.name, where: keyWhere({ ...key, IsActiveEntity: false }) }] },
    },
  },
  data: {},
});

const addressed = (entity: EntitySpec, key: Args) => ({
  ref: [{ id: entity.name, where: keyWhere(key) }],
});

const pick = (row: Args, entity: EntitySpec) =>
  Object.fromEntries(entity.keys.map((k) => [k.name, row[k.name]]));

/** A draft's composition children are written through their root (deep insert), not directly. */
function refuseDraftChild(entity: EntitySpec): void {
  if (entity.draft && !entity.draftRoot) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${entity.title} is part of a draft; write it through its root`,
    );
  }
}

const BARE_STATUS: Record<number, { code: string; message: string }> = {
  401: { code: "UNAUTHORIZED", message: "Authentication required" },
  403: { code: "FORBIDDEN", message: "Not allowed for this user" },
  404: { code: "NOT_FOUND", message: "Not found" },
};

interface ToolErrorLike {
  code: string;
  message: string;
  target?: string;
  details?: unknown[];
}

/**
 * A CAP request error (4xx, e.g. req.error / req.reject, ASSERT_*) as a tool error the agent
 * can act on, keeping code, target and details. Anything else (5xx, bugs) is not ours to hide.
 */
function capError(error: unknown): ToolErrorLike | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  const numeric = typeof err.code === "number" ? err.code : undefined;
  const details = Array.isArray(err.details)
    ? (err.details as Record<string, unknown>[])
    : undefined;
  // CAP's MULTIPLE_ERRORS carries no status of its own, only its details' (all 4xx for input).
  const fromDetails = details?.length
    ? Math.max(...details.map((d) => Number(d.status ?? d.statusCode ?? d.code ?? 400) || 400))
    : undefined;
  const status = Number(err.status ?? err.statusCode ?? numeric ?? fromDetails ?? NaN);
  if (!(status >= 400 && status < 500)) return undefined;
  const message = typeof err.message === "string" ? err.message : "";
  // CAP's bare status errors (req.reject(403), a missing record) get readable codes.
  const named = BARE_STATUS[status];
  if (
    named &&
    (typeof err.code !== "string" || /^\d+$/.test(err.code)) &&
    (!message || /^\d+$/.test(message))
  ) {
    return { code: named.code, message: named.message };
  }
  return {
    code: typeof err.code === "string" ? err.code : message || String(status),
    message: message || String(err.code),
    target: typeof err.target === "string" ? err.target : undefined,
    // An error's message is not enumerable, so read each field rather than spreading it.
    details: details?.map((d) =>
      capError({ status: d.status ?? status, code: d.code, message: d.message, target: d.target }),
    ),
  };
}

function isEntityAction(action: string): action is EntityMode {
  return ["query", "get", "create", "update", "delete"].includes(action);
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

const COMPARISONS = {
  eq: "=",
  ne: "!=",
  gt: ">",
  ge: ">=",
  lt: "<",
  le: "<=",
} as const;
/** Key types stored as text; others are cast, so every database can compare a prefix. */
const TEXT_KEYS = new Set(["cds.String", "cds.LargeString", "cds.UUID"]);

function keyText(key: FieldSpec) {
  return TEXT_KEYS.has(key.cdsType)
    ? ref(key.name)
    : { ...ref(key.name), cast: { type: "cds.String" } };
}

/** `completion/complete` returns at most 100 values (MCP spec). */
export const MAX_COMPLETIONS = 100;

type TextFunction = "contains" | "startswith" | "endswith";
const TEXT_FUNCTIONS: ReadonlySet<string> = new Set<TextFunction>([
  "contains",
  "startswith",
  "endswith",
]);
const isTextFunction = (op: string): op is TextFunction => TEXT_FUNCTIONS.has(op);
const STRING_TYPES = new Set(["cds.String", "cds.LargeString"]);

function conditions(fields: Map<string, FieldSpec>, where: unknown): unknown[] {
  return and(
    ...(list(where, "where") ?? []).map((condition, i) => {
      const entry = object(condition, `where[${i}]`);
      allowOnly(entry, ["field", "op", "value"]);
      const target = field(fields, String(entry.field), `where[${i}].field`);
      const op = String(entry.op);
      if (!isOperator(op)) {
        throw new ToolError("INVALID_ARGUMENT", `Unknown operator ${op}`, `where[${i}].op`);
      }
      const at = `where[${i}].value`;
      if (op === "in") {
        if (!Array.isArray(entry.value))
          throw new ToolError("INVALID_ARGUMENT", "'in' needs an array", at);
        const list = entry.value.map((item) => ({ val: value(target, item, at) }));
        return [ref(target.name), "in", { list }];
      }
      if (isTextFunction(op)) {
        if (!STRING_TYPES.has(target.cdsType)) {
          throw new ToolError(
            "INVALID_ARGUMENT",
            `'${op}' needs a string field; ${target.name} is not one`,
            at,
          );
        }
        return [{ func: op, args: [ref(target.name), { val: value(target, entry.value, at) }] }];
      }
      // `= null` matches nothing in SQL: eq/ne null become `is null` / `is not null`.
      if (entry.value === null && (op === "eq" || op === "ne")) {
        return [ref(target.name), op === "eq" ? "is" : "is not", { val: null }];
      }
      return [ref(target.name), COMPARISONS[op], { val: value(target, entry.value, at) }];
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
  const order = object(entry, "orderby");
  allowOnly(order, ["field", "dir"]);
  const dir = order.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc")
    throw new ToolError("INVALID_ARGUMENT", "dir is asc or desc", "orderby");
  return { ref: [field(fields, String(order.field), "orderby").name], sort: dir };
}

/** Types whose values are JSON numbers. */
const NUMBER_TYPES = new Set([
  "cds.Integer",
  "cds.Int16",
  "cds.Int32",
  "cds.UInt8",
  "cds.Double",
  "cds.hana.REAL",
  "cds.hana.TINYINT",
  "cds.hana.SMALLINT",
]);
/** Types that may exceed a JSON number's precision: a number, or digits as a string. */
const DIGIT_TYPES = new Set([
  "cds.Int64",
  "cds.Integer64",
  "cds.Decimal",
  "cds.DecimalFloat",
  "cds.hana.SMALLDECIMAL",
]);
const DIGITS = /^-?\d+(\.\d+)?$/;

function fitsType(cdsType: string, given: unknown): boolean {
  if (cdsType === "cds.Boolean") return typeof given === "boolean";
  if (NUMBER_TYPES.has(cdsType)) return typeof given === "number";
  if (DIGIT_TYPES.has(cdsType)) {
    return typeof given === "number" || (typeof given === "string" && DIGITS.test(given));
  }
  return typeof given === "string";
}

/** `given`, checked against the field's type. */
function value(spec: FieldSpec, given: unknown, at: string): unknown {
  if (!fitsType(spec.cdsType, given)) {
    const type = typeName(spec.cdsType);
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${JSON.stringify(given)} is not a valid ${type} for ${spec.name}`,
      at,
    );
  }
  return given;
}

function field(fields: Map<string, FieldSpec>, name: string, at: string): FieldSpec {
  const spec = fields.get(name);
  if (!spec) throw new ToolError("INVALID_ARGUMENT", `Unknown field ${name}`, at);
  return spec;
}

function allowOnly(args: Args, allowed: string[]): void {
  const extra = Object.keys(args).find((k) => !allowed.includes(k) && args[k] !== undefined);
  if (extra) throw new ToolError("INVALID_ARGUMENT", `Unexpected argument ${extra}`, extra);
}

function list(given: unknown, at: string): unknown[] | undefined {
  if (given === undefined) return undefined;
  if (!Array.isArray(given)) throw new ToolError("INVALID_ARGUMENT", `${at} must be an array`, at);
  return given;
}

function object(given: unknown, at: string): Args {
  if (!isObject(given)) throw new ToolError("INVALID_ARGUMENT", `${at} must be an object`, at);
  return given;
}

function integer(given: unknown, at: string, min: number, max: number): number {
  if (typeof given !== "number" || !Number.isInteger(given) || given < min || given > max) {
    throw new ToolError("INVALID_ARGUMENT", `${at} must be an integer from ${min} to ${max}`, at);
  }
  return given;
}

/** Join condition token lists with `and`, wrapping each so `or` inside one stays contained. */
function and(...parts: unknown[][]): unknown[] {
  const present = parts.filter((p) => p.length > 0);
  if (present.length <= 1) return present[0] ?? [];
  return present.flatMap((p, i) => [...(i ? ["and"] : []), { xpr: p }]);
}

const ref = (name: string) => ({ ref: [name] });
const pickKeys = (args: Args, names: string[]) =>
  Object.fromEntries(names.filter((n) => n in args).map((n) => [n, args[n]]));
const project = (row: Args, names: string[]) =>
  Object.fromEntries(names.filter((n) => n in row).map((n) => [n, row[n]]));
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
    if (Number.isSafeInteger(offset) && (offset as number) >= 0) return offset as number;
  } catch {
    // fall through
  }
  throw new ToolError("INVALID_ARGUMENT", "cursor is not one this server returned", "cursor");
}

/** Integer types whose key values arrive as digits in a URI; others stay strings. */
const URI_NUMBERS = new Set(["cds.Integer", "cds.UInt8", "cds.Int16", "cds.Int32"]);

/** The inverse of resourceLinks' key: typed as the key fields are, checked by keyOf. */
function parseResourceKey(entity: EntitySpec, segment: string): Args {
  const typed = (f: FieldSpec | undefined, raw: string): unknown => {
    let text: string;
    try {
      text = decodeURIComponent(raw);
    } catch {
      throw new ToolError("INVALID_ARGUMENT", `${raw} is not a valid key`, f?.name);
    }
    if (f && URI_NUMBERS.has(f.cdsType) && /^-?\d+$/.test(text)) return Number(text);
    if (f?.cdsType === "cds.Boolean" && (text === "true" || text === "false"))
      return text === "true";
    return text;
  };
  const only = entity.keys.length === 1 ? entity.keys[0] : undefined;
  if (only) return { [only.name]: typed(only, segment) };
  const pairs = segment.split(";").map((part) => {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    return [
      name,
      typed(
        entity.keys.find((k) => k.name === name),
        part.slice(at + 1),
      ),
    ] as const;
  });
  return Object.fromEntries(pairs);
}

/**
 * The text of an @mcp.prompts entry with its arguments filled in: each `{{key}}` of an input
 * becomes the argument's value (already checked against promptArgsSchema). Other braces stay.
 */
export function renderPrompt(prompt: PromptSpec, args: Record<string, string>): string {
  const keys = new Set(prompt.inputs.map((input) => input.key));
  // One pass over the template, so an argument's own text is never filled in again.
  return prompt.template.replace(/\{\{([^{}]*)\}\}/g, (whole, key: string) =>
    keys.has(key) ? (args[key] ?? "") : whole,
  );
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

function toolError(error: ToolErrorLike): ToolResult {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.target && { target: error.target }),
    ...(error.details && { details: error.details }),
  };
  return {
    isError: true,
    structuredContent: { error: body },
    text: `${error.code}: ${error.message}`,
  };
}
