import {
  entityInputSchema,
  entityOutputSchema,
  operationInputSchema,
  operationOutputSchema,
  type Limits,
} from "../schema-mapper";
import type {
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

  constructor(
    private readonly spec: ExposureSpec,
    private readonly options: RegistryOptions = {},
  ) {
    this.tools = this.build();
  }

  toolsFor(_user: UserLike): ToolSpec[] {
    return this.tools;
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
    return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private serviceTools(service: ServiceSpec): ToolSpec[] {
    const entities = new Map(service.entities.map((e) => [e.name, e]));
    const lookup = (name: string) => entities.get(name);
    const limits = this.options.limits;
    const tools: ToolSpec[] = [];
    for (const entity of service.entities) {
      for (const mode of entity.modes) {
        tools.push({
          name: toolName(service.name, entity.name, mode),
          title: `${entity.title}: ${mode}`,
          description: withDescription(DESCRIBE_MODE[mode](entity.title), entity.description),
          inputSchema: entityInputSchema(entity, mode, { limits, entities: lookup }),
          outputSchema: entityOutputSchema(entity, mode),
          annotations: HINTS[mode],
          target: { kind: "entity", entity: entity.name, mode },
        });
      }
    }
    for (const op of service.operations) {
      tools.push(operationTool(service, op, op.boundTo ? entities.get(op.boundTo) : undefined));
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
    target: { kind: "operation", operation: op.name },
  };
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
