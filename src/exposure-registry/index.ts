import { readModel } from "../model-reader";
import { canCall, canUseMode, view, viewKey } from "../access";
import { appMeta } from "./app-meta";
import {
  DEFAULT_LIMITS,
  OPERATORS,
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
  PromptSpec,
  ResourceSpec,
  ServiceSpec,
  ToolSpec,
  UserLike,
  V1Options,
} from "../types";
import { byNameOrder, typeName } from "../util";

/**
 * exposure-registry
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
  /** What a v1 app's config said (v1 shim): only for V1_DEFAULT_CHANGED diagnostics. */
  v1?: V1Options;
}

type Hints = ToolSpec["annotations"];

/** MCP tool names (SEP-986, kept in 2026-07-28); the SDK enforces the same pattern. */
const TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** Many LLM tool APIs accept at most 64 characters; longer names get a warning. */
const PORTABLE_NAME_LENGTH = 64;

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

/** A tool built once, with the check that decides who sees it. */
interface Entry {
  tool: ToolSpec;
  visible: (user: UserLike) => boolean;
}

export class ExposureRegistry {
  /** Problems found while reading the model and building tools. Reported at startup. */
  readonly diagnostics: Diagnostic[] = [];
  /** Entity and operation tools, shared by everyone. */
  private readonly entries: Entry[] = [];
  /** Names the describe and compact tools may use (clashes and invalid names removed). */
  private readonly builtinNames = new Set<string>();
  /** Prompts by name, after clashes are removed. */
  private readonly prompts: PromptSpec[] = [];
  /** Tool lists per distinct access pattern, so equal access shares the same objects. */
  private readonly lists = new Map<string, ToolSpec[]>();

  constructor(
    readonly spec: ExposureSpec,
    private readonly options: RegistryOptions = {},
    readDiagnostics: Diagnostic[] = [],
  ) {
    this.diagnostics.push(...readDiagnostics);
    this.build();
    this.buildPrompts();
  }

  /** The limits the tools advertise; the executor must enforce the same. */
  get limits(): Limits {
    return this.options.limits ?? DEFAULT_LIMITS;
  }

  /** Read a compiled model and build its registry; diagnostics cover both steps. */
  static fromModel(model: unknown, options: RegistryOptions = {}): ExposureRegistry {
    const { spec, diagnostics } = readModel(model, { v1: options.v1 });
    return new ExposureRegistry(spec, options, diagnostics);
  }

  /**
   * The tools this user could ever call: what CAP's @requires and role grants of @restrict
   * would not always refuse. `where` conditions only filter rows, so they never hide a tool.
   * Describe and compact tools only name the entities and operations the user can reach.
   */
  toolsFor(user: UserLike): ToolSpec[] {
    const views = this.spec.services.map((service) => view(service, user));
    const entries = this.entries.filter((entry) => entry.visible(user));
    const key = JSON.stringify([entries.map((e) => e.tool.name), views.map(viewKey)]);
    let list = this.lists.get(key);
    if (!list) {
      const builtins = views
        .flatMap((service) => builtinTools(service, this.options.limits))
        .filter((tool) => this.builtinNames.has(tool.name))
        .map(deepFreeze);
      list = sortByName([...entries.map((e) => e.tool), ...builtins]);
      this.lists.set(key, list);
    }
    return list;
  }

  /**
   * Resource templates for @mcp.resource entities this user may read (`get`, as CAP's grants
   * decide it): one record by key at `cap://<Service>/<Entity>/{key}` (ADR 0006). Entities
   * without an addressable key have no get, so no template.
   */
  resourcesFor(user: UserLike): ResourceSpec[] {
    return this.spec.services.flatMap((service) =>
      service.entities
        .filter((e) => e.resource && e.modes.has("get") && canUseMode(user, service, e, "get"))
        .map((e) => resourceSpec(service, e)),
    );
  }

  /**
   * The @mcp.prompts of every service this user can reach (its @requires), sorted by name.
   * A prompt is text for the user to send; it reads nothing, but it names the service's data,
   * so it is shown only where the service is.
   */
  promptsFor(user: UserLike): PromptSpec[] {
    const reachable = new Set(
      this.spec.services.filter((s) => view(s, user) !== undefined).map((s) => s.name),
    );
    return this.prompts.filter((p) => reachable.has(p.service));
  }

  private buildPrompts(): void {
    const byName = new Map<string, PromptSpec[]>();
    for (const prompt of this.spec.services.flatMap((s) => s.prompts)) {
      byName.set(prompt.name, [...(byName.get(prompt.name) ?? []), prompt]);
    }
    for (const [name, prompts] of byName) {
      const [only] = prompts;
      if (prompts.length === 1 && only) {
        this.prompts.push(deepFreeze(only));
        continue;
      }
      const services = [...new Set(prompts.map((p) => p.service))].sort();
      this.diagnostics.push({
        level: "error",
        code: "PROMPT_NAME_CLASH",
        target: name,
        message:
          services.length > 1
            ? `${services.join(" and ")} both have a prompt named ${name}; neither is exposed`
            : `${services[0]} has ${prompts.length} prompts named ${name}; none is exposed`,
      });
    }
    this.prompts.sort(byNameOrder);
  }

  /** Name checks and clashes are decided once, on the full (unfiltered) tool set. */
  private build(): void {
    const byName = new Map<string, Entry[]>();
    for (const service of this.spec.services) {
      const all = [
        ...builtinTools(service, this.options.limits).map((tool) => ({
          tool,
          visible: () => true,
        })),
        ...this.modelEntries(service),
      ];
      for (const entry of all) {
        const name = entry.tool.name;
        if (!TOOL_NAME.test(name)) {
          this.diagnostics.push({
            level: "error",
            code: "INVALID_TOOL_NAME",
            target: name,
            message: `${describeTarget(entry.tool)} would be the tool "${name}", which MCP does not allow (1-128 of A-Z a-z 0-9 _ - .); not exposed`,
          });
          continue;
        }
        if (name.length > PORTABLE_NAME_LENGTH) {
          this.diagnostics.push({
            level: "warn",
            code: "LONG_TOOL_NAME",
            target: name,
            message: `${name} is longer than ${PORTABLE_NAME_LENGTH} characters; some LLM tool APIs reject it`,
          });
        }
        byName.set(name, [...(byName.get(name) ?? []), entry]);
      }
    }
    for (const [name, candidates] of byName) {
      // The plugin's own tools (describe, the compact set) keep their name; model tools yield.
      const builtin = candidates.filter((c) => isBuiltin(c.tool));
      const kept =
        candidates.length === 1 ? candidates[0] : builtin.length === 1 ? builtin[0] : undefined;
      if (kept && isBuiltin(kept.tool)) this.builtinNames.add(name);
      else if (kept) this.entries.push({ ...kept, tool: deepFreeze(kept.tool) });
      if (candidates.length === 1) continue;
      this.diagnostics.push({
        level: "error",
        code: "TOOL_NAME_CLASH",
        target: name,
        message: kept
          ? `${candidates
              .filter((c) => c !== kept)
              .map((c) => describeTarget(c.tool))
              .join(
                " and ",
              )} would be the tool ${name}, which ${describeTarget(kept.tool)} uses; not exposed`
          : `${candidates.map((c) => describeTarget(c.tool)).join(" and ")} would all be the tool ${name}; none is exposed`,
      });
    }
  }

  private modelEntries(service: ServiceSpec): Entry[] {
    const entities = new Map(service.entities.map((e) => [e.name, e]));
    const lookup = (name: string) => entities.get(name);
    const limits = this.options.limits;
    const entries: Entry[] = [];
    // In a compact service only @mcp.ui operations keep a tool of their own (a host binds the
    // MCP App to it); everything else goes through the generic set.
    if (!service.compact) {
      for (const entity of service.entities) {
        for (const mode of entity.modes) {
          entries.push({
            tool: {
              name: toolName(service.name, entity.name, mode),
              title: `${entity.title}: ${mode}`,
              description: withDescription(DESCRIBE_MODE[mode](entity.title), entity.description),
              inputSchema: entityInputSchema(entity, mode, { limits, entities: lookup }),
              outputSchema: entityOutputSchema(entity, mode),
              annotations: HINTS[mode],
              target: { kind: "entity", entity: entity.name, mode },
            },
            visible: (user) => canUseMode(user, service, entity, mode),
          });
        }
      }
    }
    for (const op of service.operations) {
      if (service.compact && !op.ui) continue;
      const bound = op.boundTo ? entities.get(op.boundTo) : undefined;
      entries.push({
        tool: operationTool(service, op, bound),
        visible: (user) => canCall(user, service, op, bound),
      });
    }
    return entries;
  }
}

function resourceSpec(service: ServiceSpec, entity: EntitySpec): ResourceSpec {
  const local = entity.name.slice(service.name.length + 1);
  return {
    uriTemplate: `cap://${service.name}/${local}/{key}`,
    name: toolName(service.name, entity.name),
    title: entity.title,
    ...(entity.description && { description: entity.description }),
    mimeType: "application/json",
    entity: entity.name,
    completion: entity.keys.length === 1 && entity.keys[0]?.completion === true,
  };
}

/** Describe and compact tools of a service (or of one user's view of it). */
function builtinTools(service: ServiceSpec | undefined, limits?: Limits): ToolSpec[] {
  if (!service) return [];
  const tools: ToolSpec[] = [];
  if (service.describe) tools.push(describeTool(service));
  if (service.compact) {
    tools.push(
      ...compactTools(
        service,
        service.operations.filter((op) => !op.ui),
        limits,
      ),
    );
  }
  return tools;
}

function isBuiltin(tool: ToolSpec): boolean {
  return tool.target.kind === "describe" || tool.target.kind === "compact";
}

function sortByName(tools: ToolSpec[]): ToolSpec[] {
  return tools.sort(byNameOrder);
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
    ...(op.ui && { _meta: appMeta(op.ui) }),
    target: { kind: "operation", operation: op.name },
  };
}

/** `<Service>_describe`: what this service exposes over MCP, and nothing else: no other
 * service's entities, no db-layer names, no omitted fields. */
function describeTool(service: ServiceSpec): ToolSpec {
  return {
    name: `${shortName(service.name)}_describe`,
    title: `${service.title}: describe`,
    description: withDescription(
      `Describe what ${service.title} exposes: its entities, fields, keys and operations. Pass an entity to describe just that one.`,
      service.description,
    ),
    inputSchema: {
      type: "object",
      properties: service.entities.length
        ? { entity: { enum: service.entities.map((e) => e.name) } }
        : {},
      additionalProperties: false,
    },
    annotations: READ,
    target: { kind: "describe", service: service.name },
  };
}

/**
 * The generic tool set of an @mcp.compact service. Field-level shapes are not in these schemas
 * (they depend on the entity argument): agents get them from describe_entity, and the executor
 * checks every argument against the target's own schema.
 */
function compactTools(
  service: ServiceSpec,
  ops: OperationSpec[],
  limits = DEFAULT_LIMITS,
): ToolSpec[] {
  const withMode = (mode: EntityMode) =>
    service.entities.filter((e) => e.modes.has(mode)).map((e) => e.name);
  const all = service.entities.map((e) => e.name);
  const record = { type: "object", description: "Field values, as describe_entity lists them" };
  const key = { type: "object", description: "The record's key fields" };
  const args = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const generic: {
    action: CompactAction;
    entities: string[];
    description: string;
    input: (entity: { enum: string[] }) => Record<string, unknown>;
    hints: Hints;
  }[] = [
    {
      action: "describe_entity",
      entities: all,
      description: "Describe one entity: fields, keys, types and the modes it allows.",
      input: (entity) => args({ entity }, ["entity"]),
      hints: READ,
    },
    {
      action: "query",
      entities: withMode("query"),
      description:
        "Query records of an entity: where/orderby/select by field name, top, cursor, q.",
      input: (entity) =>
        args(
          {
            entity,
            q: { type: "string" },
            where: {
              type: "array",
              items: args({ field: { type: "string" }, op: { enum: OPERATORS }, value: {} }, [
                "field",
                "op",
                "value",
              ]),
            },
            orderby: {
              type: "array",
              items: args({ field: { type: "string" }, dir: { enum: ["asc", "desc"] } }, ["field"]),
            },
            select: { type: "array", items: { type: "string" }, uniqueItems: true },
            top: {
              type: "integer",
              minimum: 1,
              maximum: limits.maxRows,
              default: limits.defaultRows,
            },
            cursor: { type: "string" },
          },
          ["entity"],
        ),
      hints: READ,
    },
    {
      action: "get",
      entities: withMode("get"),
      description: "Get one record of an entity by key.",
      input: (entity) => args({ entity, key }, ["entity", "key"]),
      hints: HINTS.get,
    },
    {
      action: "create",
      entities: withMode("create"),
      description: "Create a record of an entity.",
      input: (entity) => args({ entity, data: record }, ["entity", "data"]),
      hints: HINTS.create,
    },
    {
      action: "update",
      entities: withMode("update"),
      description: "Update a record of an entity by key; only the fields in data change.",
      input: (entity) => args({ entity, key, data: record }, ["entity", "key", "data"]),
      hints: HINTS.update,
    },
    {
      action: "delete",
      entities: withMode("delete"),
      description: "Delete a record of an entity by key.",
      input: (entity) => args({ entity, key }, ["entity", "key"]),
      hints: HINTS.delete,
    },
  ];
  const tools = [
    ...(all.length
      ? [
          compactTool(
            service,
            "list_entities",
            "List the entities this service exposes.",
            args({}, []),
            READ,
          ),
        ]
      : []),
    ...generic
      .filter((g) => g.entities.length > 0)
      .map((g) =>
        compactTool(service, g.action, g.description, g.input({ enum: g.entities }), g.hints),
      ),
  ];
  if (ops.length) {
    tools.push(
      compactTool(
        service,
        "call_operation",
        `Call an operation of ${service.title} with its parameters in args: ${ops.map(signature).join("; ")}.`,
        args({ operation: { enum: ops.map((op) => op.name) }, args: { type: "object" } }, [
          "operation",
        ]),
        ops.every((op) => op.kind === "function") ? READ : ACTION,
      ),
    );
  }
  return tools;
}

/** `C.stock(genre: Integer, region: String required)`, so call_operation's args can be found. */
function signature(op: OperationSpec): string {
  const params = op.params.map((param) => {
    const type = typeName(param.cdsType);
    const shape = param.many ? `array of ${type}` : type;
    return `${param.name}: ${shape}${param.mandatory ? " required" : ""}`;
  });
  return `${op.name}(${params.join(", ")})`;
}

function compactTool(
  service: ServiceSpec,
  action: CompactAction,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: Hints,
): ToolSpec {
  return {
    name: `${shortName(service.name)}_${action}`,
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

/**
 * `my.shop.Shop` + `my.shop.Shop.Books` + `get` → `Shop_Books_get`. The service's namespace is
 * dropped and dots in local names become `_`, because many LLM tool APIs only accept
 * [a-zA-Z0-9_-]. Two services with the same short name then clash, which is reported.
 */
function toolName(service: string, definition: string, suffix?: string): string {
  const local = definition.slice(service.length + 1).replaceAll(".", "_");
  return [shortName(service), local, suffix].filter(Boolean).join("_");
}

function shortName(service: string): string {
  return service.slice(service.lastIndexOf(".") + 1);
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
