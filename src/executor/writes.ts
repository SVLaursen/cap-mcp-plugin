import type { EntitySpec } from "../types";
import {
  addressed,
  allowOnly,
  byName,
  field,
  keyOf,
  keyWhere,
  object,
  project,
  value,
  type Args,
} from "./arguments";
import { ToolError, notFound } from "./errors";
import type { ServiceLike } from "./index";
import { get } from "./reads";
import { result, type ToolResult } from "./results";

/**
 * The write tools, through the service so the app's handlers run, with the data OData would
 * give them: keys in req.data for key-addressed writes, and draft-enabled entities through CAP's
 * draft events (NEW → SAVE, EDIT → patch → SAVE) as a Fiori client does.
 */

/** Finds a composition target's EntitySpec, for deep insert. */
export type EntityLookup = (name: string) => EntitySpec | undefined;

export async function create(
  entity: EntitySpec,
  data: Args,
  service: ServiceLike,
  entities: EntityLookup,
): Promise<ToolResult> {
  refuseDraftChild(entity);
  const entry = writable(entity, structuredClone(data), "create", entities);
  if (entity.draftRoot) {
    // A plain CREATE would only start a draft: NEW it, then SAVE (activate) it, so the app's
    // NEW and SAVE handlers run. One transaction: if SAVE fails, no draft is left behind.
    const [draft] = (await service.send({
      event: "NEW",
      entity: `${entity.name}.drafts`,
      data: entry,
    })) as Args[];
    const key = keysOf(draft ?? {}, entity);
    await service.send(activate(entity, key));
    return get(entity, key, service);
  }
  const written = (await service.run({
    INSERT: { into: { ref: [entity.name] }, entries: [entry] },
  })) as Args[];
  // Without an address (no keys, or an omitted one) a read-back could find another record.
  if (!entity.modes.has("get")) {
    return result(
      project(
        entry,
        entity.fields.map((f) => f.name),
      ),
    );
  }
  // CAP returns the written keys, generated ones included.
  return get(entity, keysOf(written[0] ?? entry, entity), service);
}

export async function update(
  entity: EntitySpec,
  key: Args,
  data: Args,
  service: ServiceLike,
  entities: EntityLookup,
): Promise<ToolResult> {
  refuseDraftChild(entity);
  const address = keyOf(entity, key);
  const changes = writable(entity, structuredClone(data), "update", entities);
  if (entity.draftRoot) return updateDraft(entity, address, changes, service);
  // req.data = changes plus keys, as with OData's PATCH /Books(201).
  const done = (await service.send({
    query: { UPDATE: { entity: addressed(entity, address), data: changes } },
    data: { ...changes, ...address },
  })) as Affected;
  if (affected(done) === 0) throw notFound(entity, address);
  return get(entity, address, service);
}

export async function remove(
  entity: EntitySpec,
  key: Args,
  data: Args,
  service: ServiceLike,
): Promise<ToolResult> {
  allowOnly(data, []);
  const address = keyOf(entity, key);
  // Keys in req.data as with OData's DELETE /Books(201): handlers rely on req.data.ID.
  const done = (await service.send({
    query: { DELETE: { from: addressed(entity, address) } },
    data: address,
  })) as Affected;
  if (affected(done) === 0) throw notFound(entity, address);
  return result({ deleted: address });
}

/**
 * EDIT → patch → SAVE, as a Fiori client does over OData, so SAVE handlers see the whole
 * record. (CAP's direct update of an active draft record gives them only the changed fields.)
 * EDIT is refused while someone else holds a draft; a failure rolls the draft back with the call.
 */
async function updateDraft(
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
  return get(entity, address, service);
}

/**
 * Data the agent may write: fields that are not readonly, each of its type (null only where
 * optional), and @mcp.deepInsert compositions checked the same way against the child's own
 * fields, without its back link (CAP fills it). Keys can be given on create but never changed
 * by update. CAP checks the rest (@mandatory, @assert.*, handlers).
 */
function writable(
  entity: EntitySpec,
  data: Args,
  mode: "create" | "update",
  entities: EntityLookup,
  backlink?: string,
): Args {
  const fields = byName(
    entity.fields.filter(
      (f) =>
        !f.readonly && (mode === "create" || !f.key) && (!backlink || f.association !== backlink),
    ),
  );
  const nested = new Map(entity.deepInsert.map((deep) => [deep.element, deep]));
  for (const [name, given] of Object.entries(data)) {
    const deep = nested.get(name);
    if (deep) {
      const child = entities(deep.target);
      if (!child) throw new ToolError("INVALID_ARGUMENT", `Unknown field ${name}`, `data.${name}`);
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
        writable(child, object(item, `data.${name}[${i}]`), "create", entities, deep.backlink),
      );
      continue;
    }
    const target = field(fields, name, `data.${name}`);
    if (given !== null || target.mandatory) value(target, given, `data.${name}`);
  }
  return data;
}

/** A draft's composition children are written through their root (deep insert), not directly. */
function refuseDraftChild(entity: EntitySpec): void {
  if (entity.draft && !entity.draftRoot) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${entity.title} is part of a draft; write it through its root`,
    );
  }
}

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

/** The entity's key values in a row CAP returned. */
const keysOf = (row: Args, entity: EntitySpec) =>
  Object.fromEntries(entity.keys.map((k) => [k.name, row[k.name]]));

/** What CAP returns for UPDATE and DELETE: the number of affected rows, in one form or another. */
type Affected = { affected?: number } | number | undefined;
const affected = (done: Affected) => (typeof done === "number" ? done : (done?.affected ?? 0));
