import type { EntitySpec, FieldSpec, OperationSpec, ServiceSpec } from "../types";
import { typeName } from "../util";
import { allowOnly, type Args } from "./arguments";
import { ToolError } from "./errors";
import { clean, result, type ToolResult } from "./results";

/**
 * The describe tools: `<Service>_describe` and the compact `list_entities` and
 * `describe_entity`. They describe the service as the caller can reach it, and nothing outside
 * it (no other service's entities, no db-layer names, no @mcp.omit fields, which never reach the
 * spec): an agent must not learn about entities it cannot use.
 */

/** `<Service>_describe`, optionally narrowed to one entity. */
export function describeService(service: ServiceSpec, args: Args): ToolResult {
  const entities = narrowed(service, args);
  return result({
    service: clean({ name: service.name, title: service.title, description: service.description }),
    entities: entities.map(describeEntity),
    operations: args.entity === undefined ? service.operations.map(describeOperation) : [],
  });
}

/** The compact `describe_entity`: one entity, which must be named. */
export function describeOneEntity(service: ServiceSpec, args: Args): ToolResult {
  const [entity] = narrowed(service, args);
  if (!entity || args.entity === undefined) {
    throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${String(args.entity)}`, "entity");
  }
  return result(describeEntity(entity));
}

/** The compact `list_entities`. */
export function listEntities(service: ServiceSpec, args: Args): ToolResult {
  allowOnly(args, []);
  return result({
    entities: service.entities.map((entity) =>
      clean({
        name: entity.name,
        title: entity.title,
        description: entity.description,
        modes: [...entity.modes].sort(),
      }),
    ),
  });
}

/** The service's entities, or the one `args.entity` names (which must be one of them). */
function narrowed(service: ServiceSpec, args: Args): EntitySpec[] {
  allowOnly(args, ["entity"]);
  if (args.entity === undefined) return service.entities;
  const wanted = String(args.entity);
  const entities = service.entities.filter((entity) => entity.name === wanted);
  if (entities.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", `Unknown entity ${wanted}`, "entity");
  }
  return entities;
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
