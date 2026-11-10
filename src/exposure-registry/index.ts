import { readModel } from "../model-reader";
import {
  entityInputSchema,
  entityOutputSchema,
  operationInputSchema,
  operationOutputSchema,
  type Limits,
} from "../schema-mapper";
import type {
  CompactAction,
  Diagnostic,
  EntityMode,
  EntitySpec,
  ExposureSpec,
  OperationSpec,
  ServiceSpec,
  ToolSpec,
  UserLike,
} from "../types";

/**
 * exposure-registry (milestone M2)
 *
 * Builds the tool list from an ExposureSpec and filters it per request.
 *
 * Contract:
 * - Built once per model (cache keyed by model identity, so extended tenant models get their own).
 * - `toolsFor(user)` hides tools the user can never call (service/entity @requires), and returns
 *   tools in a deterministic order (the 2026-07-28 spec asks for that, for client caching).
 * - It is NOT the authorization boundary. CAP enforces @requires/@restrict when the executor
 *   runs the request; the registry only avoids advertising tools that would always be refused.
 * - Tool names are stable and predictable: <Service>_<Entity>_<mode>, <Service>_<operation>.
 * - Compact services (@mcp.compact) publish the generic tool set instead of per-entity tools.
 */

export interface RegistryOptions {
  limits?: Limits;
}

type Hints = ToolSpec["annotations"];

/**
 * One registry per model object, built on first use. Keyed weakly, so a tenant's extended model
 * (a new object) gets its own tools and an unused one can be collected. Create one cache per
 * plugin activation and pass it where it is needed (no module-level state, ADR 0005).
 */
export function registryCache(options: RegistryOptions = {}): (model: object) => ExposureRegistry {
  const cache = new WeakMap<object, ExposureRegistry>();
  return (model) => {
    let registry = cache.get(model);
    if (!registry) {
      registry = ExposureRegistry.fromModel(model, options);
      cache.set(model, registry);
    }
    return registry;
  };
}

const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const HINTS: Record<EntityMode, Hints> = {
  query: READ,
  get: READ,
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};
const ACTION: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

const DESCRIBE_MODE: Record<EntityMode, (title: string) => string> = {
  query: (t) => `Query ${t} records: filter, sort, select fields and page through results.`,
  get: (t) => `Get one ${t} record by key.`,
  create: (t) => `Create a ${t} record.`,
  update: (t) => `Update a ${t} record by key; only the fields given change.`,
  delete: (t) => `Delete a ${t} record by key.`,
};

export class ExposureRegistry {
  /** Problems found while building tools (e.g. name clashes). Reported at startup. */
  readonly diagnostics: Diagnostic[] = [];
  private readonly tools: ToolSpec[];
  /**
   * Per tool: the @requires CAP checks for it, each met by any one of its roles. The service's
   * always applies; a bound operation uses its own, else its entity's (CAP's requires.js).
   */
  private readonly requires = new WeakMap<ToolSpec, string[][]>();

  constructor(
    private readonly spec: ExposureSpec,
    private readonly options: RegistryOptions = {},
    readDiagnostics: Diagnostic[] = [],
  ) {
    this.diagnostics.push(...readDiagnostics);
    this.tools = this.build();
  }

  /** Read a compiled model and build its registry; diagnostics cover both steps. */
  static fromModel(model: unknown, options: RegistryOptions = {}): ExposureRegistry {
    const { spec, diagnostics } = readModel(model);
    return new ExposureRegistry(spec, options, diagnostics);
  }

  /**
   * The tools this user could ever call. Only hides what CAP would always refuse by @requires;
   * @restrict (instance rules, `where`) is CAP's job when the call runs.
   */
  toolsFor(user: UserLike): ToolSpec[] {
    return this.tools.filter((tool) =>
      (this.requires.get(tool) ?? []).every((roles) => roles.some((role) => user.is(role))),
    );
  }

  private build(): ToolSpec[] {
    const byName = new Map<string, ToolSpec[]>();
    for (const service of this.spec.services) {
      for (const tool of this.serviceTools(service)) {
        byName.set(tool.name, [...(byName.get(tool.name) ?? []), tool]);
      }
    }
    const tools: ToolSpec[] = [];
    for (const [name, candidates] of byName) {
      const [tool, ...others] = candidates;
      if (tool && others.length === 0) {
        tools.push(tool);
        continue;
      }
      this.diagnostics.push({
        level: "error",
        code: "TOOL_NAME_CLASH",
        target: name,
        message: `${candidates.map(describeTarget).join(" and ")} would both be the tool ${name}; neither is exposed`,
      });
    }
    // Shared by every user and request, so nobody may change them in place.
    return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(deepFreeze);
  }

  private serviceTools(service: ServiceSpec): ToolSpec[] {
    const entities = new Map(service.entities.map((e) => [e.name, e]));
    const lookup = (name: string) => entities.get(name);
    const limits = this.options.limits;
    const tools: ToolSpec[] = [];
    const tag = (tool: ToolSpec, ...requires: (string[] | undefined)[]) => {
      this.requires.set(
        tool,
        [service.requires, ...requires].filter((r): r is string[] => !!r),
      );
      return tool;
    };
    if (service.describe) tools.push(tag(describeTool(service)));
    if (service.compact) {
      // An MCP App is bound to its own tool, so @mcp.ui operations stay separate.
      const [ui, rest] = partition(service.operations, (op) => op.ui !== undefined);
      tools.push(...compactTools(service, rest, limits?.maxRows).map((tool) => tag(tool)));
      for (const op of ui) {
        const bound = lookup(op.boundTo ?? "");
        tools.push(tag(operationTool(service, op, bound), op.requires ?? bound?.requires));
      }
      return tools;
    }
    for (const entity of service.entities) {
      for (const mode of entity.modes) {
        const tool: ToolSpec = {
          name: toolName(service.name, entity.name, mode),
          title: `${entity.title}: ${mode}`,
          description: withDescription(DESCRIBE_MODE[mode](entity.title), entity.description),
          inputSchema: entityInputSchema(entity, mode, { limits, entities: lookup }),
          outputSchema: entityOutputSchema(entity, mode),
          annotations: HINTS[mode],
          target: { kind: "entity", entity: entity.name, mode },
        };
        tools.push(tag(tool, entity.requires));
      }
    }
    for (const op of service.operations) {
      const bound = op.boundTo ? entities.get(op.boundTo) : undefined;
      tools.push(tag(operationTool(service, op, bound), op.requires ?? bound?.requires));
    }
    return tools;
  }
}

function operationTool(service: ServiceSpec, op: OperationSpec, bound?: EntitySpec): ToolSpec {
  return {
    name: toolName(service.name, op.name),
    title: op.title,
    description: op.description ?? `${op.kind === "function" ? "Function" : "Action"} ${op.title}.`,
    inputSchema: operationInputSchema(op, bound),
    outputSchema: operationOutputSchema(op),
    annotations: op.kind === "function" ? READ : ACTION,
    // MCP Apps (ext-apps): the current key plus the deprecated flat one, as registerAppTool does.
    ...(op.ui && { _meta: { ui: { resourceUri: op.ui }, "ui/resourceUri": op.ui } }),
    target: { kind: "operation", operation: op.name },
  };
}

/** `<Service>_describe`: what this service exposes over MCP, and nothing else (v1 finding #3). */
function describeTool(service: ServiceSpec): ToolSpec {
  return {
    name: `${service.name}_describe`,
    title: `${service.title}: describe`,
    description: withDescription(
      `Describe what ${service.title} exposes: its entities, fields, keys and operations. Pass an entity to describe just that one.`,
      service.description,
    ),
    inputSchema: {
      type: "object",
      properties: { entity: { enum: service.entities.map((e) => e.name) } },
      additionalProperties: false,
    },
    annotations: READ,
    target: { kind: "describe", service: service.name },
  };
}

const OBJECT = { type: "object" };

/**
 * The generic tool set of an @mcp.compact service. Field-level shapes are not in these schemas
 * (they depend on the entity argument); agents get them from describe_entity, and the executor
 * validates arguments against the entity's own schemas.
 */
function compactTools(service: ServiceSpec, ops: OperationSpec[], maxRows = 200): ToolSpec[] {
  const withMode = (mode: EntityMode) =>
    service.entities.filter((e) => e.modes.has(mode)).map((e) => e.name);
  const entityArg = (names: string[]) => ({ entity: { enum: names } });
  const object = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const all = service.entities.map((e) => e.name);
  const candidates: [
    CompactAction,
    string[] | undefined,
    string,
    Record<string, unknown>,
    Hints,
  ][] = [
    [
      "list_entities",
      all,
      "List the entities this service exposes.",
      { type: "object", properties: {}, additionalProperties: false },
      READ,
    ],
    [
      "describe_entity",
      all,
      "Describe one entity: fields, keys, types and the modes it allows.",
      object(entityArg(all), ["entity"]),
      READ,
    ],
    [
      "query",
      withMode("query"),
      "Query records of an entity: where/orderby/select by field name, top, cursor, q.",
      object(
        {
          ...entityArg(withMode("query")),
          q: { type: "string" },
          where: {
            type: "array",
            items: object({ field: { type: "string" }, op: { type: "string" }, value: {} }, [
              "field",
              "op",
              "value",
            ]),
          },
          orderby: {
            type: "array",
            items: object({ field: { type: "string" }, dir: { enum: ["asc", "desc"] } }, ["field"]),
          },
          select: { type: "array", items: { type: "string" }, uniqueItems: true },
          top: { type: "integer", minimum: 1, maximum: maxRows },
          cursor: { type: "string" },
        },
        ["entity"],
      ),
      READ,
    ],
    [
      "get",
      withMode("get"),
      "Get one record of an entity by key.",
      object({ ...entityArg(withMode("get")), key: OBJECT }, ["entity", "key"]),
      HINTS.get,
    ],
    [
      "create",
      withMode("create"),
      "Create a record of an entity.",
      object({ ...entityArg(withMode("create")), data: OBJECT }, ["entity", "data"]),
      HINTS.create,
    ],
    [
      "update",
      withMode("update"),
      "Update a record of an entity by key; only the fields in data change.",
      object({ ...entityArg(withMode("update")), key: OBJECT, data: OBJECT }, [
        "entity",
        "key",
        "data",
      ]),
      HINTS.update,
    ],
    [
      "delete",
      withMode("delete"),
      "Delete a record of an entity by key.",
      object({ ...entityArg(withMode("delete")), key: OBJECT }, ["entity", "key"]),
      HINTS.delete,
    ],
  ];
  const tools = candidates
    .filter(([action, names]) => action === "list_entities" || (names?.length ?? 0) > 0)
    .map(([action, , description, inputSchema, annotations]) =>
      compactTool(service, action, description, inputSchema, annotations),
    );
  if (ops.length) {
    const readOnly = ops.every((op) => op.kind === "function");
    tools.push(
      compactTool(
        service,
        "call_operation",
        "Call one of this service's operations with its arguments (see describe_entity / the service description).",
        object({ operation: { enum: ops.map((op) => op.name) }, args: OBJECT }, ["operation"]),
        readOnly ? READ : ACTION,
      ),
    );
  }
  return tools;
}

function compactTool(
  service: ServiceSpec,
  action: CompactAction,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: Hints,
): ToolSpec {
  return {
    name: `${service.name}_${action}`,
    title: `${service.title}: ${action}`,
    description,
    inputSchema,
    annotations,
    target: { kind: "compact", service: service.name, action },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

/** `Shop` + `Shop.Books` + `get` → `Shop_Books_get`; dots inside the service's names become `_`. */
function toolName(service: string, definition: string, suffix?: string): string {
  const local = definition.slice(service.length + 1).replaceAll(".", "_");
  return [service, local, suffix].filter(Boolean).join("_");
}

function withDescription(summary: string, description?: string): string {
  return description ? `${summary}\n\n${description}` : summary;
}

function describeTarget(tool: ToolSpec): string {
  const target = tool.target;
  if (target.kind === "entity") return `${target.mode} on ${target.entity}`;
  if (target.kind === "operation") return target.operation;
  return `${target.kind} of ${target.service}`;
}
