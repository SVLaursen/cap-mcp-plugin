import { DEFAULT_LIMITS, OPERATORS, type Limits } from "../schema-mapper";
import type { CompactAction, EntityMode, OperationSpec, ServiceSpec, ToolSpec } from "../types";
import { typeName } from "../util";
import { Hints, READ, HINTS, ACTION, shortName, withDescription } from "./tools";

/**
 * The plugin's own tools for a service: `<Service>_describe` (@mcp.describe) and the compact
 * set (@mcp.compact) that replaces per-entity tools. Built per caller from the service as the
 * caller can reach it, so they only name what that caller can use.
 */

/** Describe and compact tools of a service (or of one user's view of it). */
export function builtinTools(service: ServiceSpec | undefined, limits?: Limits): ToolSpec[] {
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

export function isBuiltin(tool: ToolSpec): boolean {
  return tool.target.kind === "describe" || tool.target.kind === "compact";
}

/** `<Service>_describe`: what this service exposes over MCP, and nothing else: no other
 * service's entities, no db-layer names, no omitted fields. */
export function describeTool(service: ServiceSpec): ToolSpec {
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
export function compactTools(
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
export function signature(op: OperationSpec): string {
  const params = op.params.map((param) => {
    const type = typeName(param.cdsType);
    const shape = param.many ? `array of ${type}` : type;
    return `${param.name}: ${shape}${param.mandatory ? " required" : ""}`;
  });
  return `${op.name}(${params.join(", ")})`;
}

export function compactTool(
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
