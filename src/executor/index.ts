import { view } from "../access";
import { DEFAULT_LIMITS, type Limits } from "../schema-mapper";
import type {
  EntityMode,
  EntitySpec,
  ExposureSpec,
  OperationSpec,
  ServiceSpec,
  ToolSpec,
  UserLike,
} from "../types";
import { allowOnly, object, type Args } from "./arguments";
import { completeKey } from "./completion";
import { describeOneEntity, describeService, listEntities } from "./describe";
import { ToolError } from "./errors";
import { callOperation } from "./operations";
import { get, query } from "./reads";
import { parseResourceKey } from "./resources";
import type { ToolResult } from "./results";
import { create, remove, update } from "./writes";

export { ConfirmationRequired, ToolError, errorResult } from "./errors";
export { MAX_COMPLETIONS } from "./completion";
export type { ToolResult } from "./results";

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
 *
 * Files: arguments.ts (checking what the agent sent), reads.ts (query, get), writes.ts (create,
 * update, delete, drafts), operations.ts (functions and actions), describe.ts (describe tools),
 * resources.ts and completion.ts (@mcp.resource), errors.ts and results.ts (what comes back).
 */

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

const ENTITY_ACTIONS: ReadonlySet<string> = new Set<EntityMode>([
  "query",
  "get",
  "create",
  "update",
  "delete",
]);
const isEntityAction = (action: string): action is EntityMode => ENTITY_ACTIONS.has(action);

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

  /**
   * Run one tool call. `user` is the caller (cds.context.user); describe tools only describe
   * what it can reach. Errors propagate, so the caller's transaction rolls back; the caller maps
   * them with errorResult() afterwards. Catching them here would let CAP commit partial work.
   */
  async execute(
    tool: ToolSpec,
    args: Args,
    service: ServiceLike,
    user: UserLike,
    options: CallOptions = {},
  ): Promise<ToolResult> {
    const target = tool.target;
    switch (target.kind) {
      case "describe":
        return describeService(this.reachable(target.service, user), args);
      case "operation":
        return this.call(this.operation(target.operation), args, service, options);
      case "entity": {
        const entity = this.entity(target.entity);
        if (target.mode === "query" || target.mode === "create") {
          return this.run(entity, target.mode, {}, args, service);
        }
        // Per-entity tools take keys (and, for update, fields) at the top level.
        const isKey = (name: string) => entity.keys.some((k) => k.name === name);
        const keys = Object.fromEntries(Object.entries(args).filter(([k]) => isKey(k)));
        const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !isKey(k)));
        return this.run(entity, target.mode, keys, rest, service);
      }
      case "compact": {
        const action = target.action;
        if (action === "list_entities") {
          return listEntities(this.reachable(target.service, user), args);
        }
        if (action === "describe_entity") {
          return describeOneEntity(this.reachable(target.service, user), args);
        }
        if (action === "call_operation") {
          allowOnly(args, ["operation", "args"]);
          const op = this.operation(String(args.operation), target.service);
          const opArgs = args.args === undefined ? {} : object(args.args, "args");
          return this.call(op, opArgs, service, options);
        }
        if (!isEntityAction(action)) throw new Error(`Unexpected compact action ${action}`);
        // Compact tools name the entity, and take `key` and `data` (query: its own arguments).
        const { entity: name, key, data, ...rest } = args;
        const entity = this.entity(String(name), target.service, action);
        if (action === "query") return this.run(entity, action, {}, rest, service);
        allowOnly(rest, []);
        const address = action === "create" ? {} : object(key, "key");
        const writes = action === "create" || action === "update";
        return this.run(entity, action, address, writes ? object(data, "data") : {}, service);
      }
    }
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
    return get(entity, parseResourceKey(entity, key), service);
  }

  /** Values for an @mcp.resource template's `{key}` (completion/complete); see completeKey. */
  completeKey(
    entityName: string,
    value: string,
    service: ServiceLike,
  ): Promise<{ values: string[]; hasMore: boolean }> {
    return completeKey(this.entities.get(entityName), value, service, this.limits);
  }

  /** One entity mode with the record's key (if any) and the rest of the arguments. */
  private run(
    entity: EntitySpec,
    mode: EntityMode,
    key: Args,
    data: Args,
    service: ServiceLike,
  ): Promise<ToolResult> {
    const lookup = (name: string) => this.entities.get(name);
    switch (mode) {
      case "query":
        return query(entity, data, service, this.limits);
      case "get":
        allowOnly(data, []);
        return get(entity, key, service);
      case "create":
        return create(entity, data, service, lookup);
      case "update":
        return update(entity, key, data, service, lookup);
      case "delete":
        return remove(entity, key, data, service);
    }
  }

  private call(
    op: OperationSpec,
    args: Args,
    service: ServiceLike,
    options: CallOptions,
  ): Promise<ToolResult> {
    const bound = op.boundTo ? this.entities.get(op.boundTo) : undefined;
    return callOperation(op, bound, args, service, options);
  }

  /** The service as this caller can reach it (empty if not at all). */
  private reachable(name: string, user: UserLike): ServiceSpec {
    const service = this.services.get(name);
    const visible = service && view(service, user);
    if (!visible) throw new ToolError("INVALID_ARGUMENT", `Unknown service ${name}`);
    return visible;
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

  /** The entity a call names, which must be exposed (and in `service`, for compact tools). */
  private entity(name: string, service?: string, mode?: EntityMode): EntitySpec {
    const entity = this.entities.get(name);
    if (!entity || (service && entity.service !== service) || (mode && !entity.modes.has(mode))) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${name}`, "entity");
    }
    return entity;
  }
}
