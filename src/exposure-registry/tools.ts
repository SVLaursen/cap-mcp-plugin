import { appMeta } from "./app-meta";
import {
  entityInputSchema,
  entityOutputSchema,
  operationInputSchema,
  withNotice,
  operationOutputSchema,
  type SchemaOptions,
} from "../schema-mapper";
import type {
  EntityMode,
  EntitySpec,
  OperationSpec,
  ResourceSpec,
  ServiceSpec,
  ToolSpec,
} from "../types";

/**
 * Building one tool: its name (`<Service>_<Entity>_<mode>`, `<Service>_<operation>`), title,
 * description, schemas and hints, and the resource template of an @mcp.resource entity.
 */

export type Hints = ToolSpec["annotations"];

export const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

export const HINTS: Record<EntityMode, Hints> = {
  query: READ,
  get: READ,
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export const ACTION: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

export const DESCRIBE_MODE: Record<EntityMode, (title: string) => string> = {
  query: (t) => `Query ${t} records: filter, sort, select fields and page through results.`,
  get: (t) => `Get one ${t} record by key.`,
  create: (t) => `Create a ${t} record.`,
  update: (t) => `Update a ${t} record by key; only the fields given change.`,
  delete: (t) => `Delete a ${t} record by key.`,
};

/** The tool for one mode of an entity: `<Service>_<Entity>_<mode>`. */
export function entityTool(
  service: ServiceSpec,
  entity: EntitySpec,
  mode: EntityMode,
  options: SchemaOptions,
): ToolSpec {
  return {
    name: toolName(service.name, entity.name, mode),
    title: `${entity.title}: ${mode}`,
    description: withDescription(DESCRIBE_MODE[mode](entity.title), entity.description),
    inputSchema: entityInputSchema(entity, mode, options),
    outputSchema: entityOutputSchema(entity, mode),
    annotations: HINTS[mode],
    target: { kind: "entity", entity: entity.name, mode },
  };
}

/** ADR 0015: the line read tools carry for callers whose reads CAP filters. */
export const FILTERED_LINE = "Your access to these records is limited by authorization.";

/** A read tool as a caller whose reads are filtered sees it: one more line, and `notice`. */
export function filteredTool(tool: ToolSpec): ToolSpec {
  const query = tool.target.kind === "entity" && tool.target.mode === "query";
  return {
    ...tool,
    description: `${tool.description}\n\n${FILTERED_LINE}`,
    ...(query && tool.outputSchema && { outputSchema: withNotice(tool.outputSchema) }),
  };
}

export function resourceSpec(service: ServiceSpec, entity: EntitySpec): ResourceSpec {
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

export function operationTool(
  service: ServiceSpec,
  op: OperationSpec,
  bound?: EntitySpec,
): ToolSpec {
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

/**
 * `my.shop.Shop` + `my.shop.Shop.Books` + `get` → `Shop_Books_get`. The service's namespace is
 * dropped and dots in local names become `_`, because many LLM tool APIs only accept
 * [a-zA-Z0-9_-]. Two services with the same short name then clash, which is reported.
 */
export function toolName(service: string, definition: string, suffix?: string): string {
  const local = definition.slice(service.length + 1).replaceAll(".", "_");
  return [shortName(service), local, suffix].filter(Boolean).join("_");
}

export function shortName(service: string): string {
  return service.slice(service.lastIndexOf(".") + 1);
}

export function withDescription(summary: string, description?: string): string {
  return description ? `${summary}\n\n${description}` : summary;
}

export function describeTarget(tool: ToolSpec): string {
  const target = tool.target;
  if (target.kind === "entity") return `${target.mode} on ${target.entity}`;
  if (target.kind === "operation") return target.operation;
  return `${target.kind} of ${target.service}`;
}
