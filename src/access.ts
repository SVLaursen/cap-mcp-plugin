import type {
  EntityMode,
  EntitySpec,
  GrantSpec,
  OperationSpec,
  ServiceSpec,
  UserLike,
} from "./types";

/**
 * Who can reach what, as CAP decides it: @requires and the roles of @restrict grants. Used to
 * hide tools (registry) and to scope describe output (executor). Never the authorization
 * boundary: CAP checks every call itself.
 */

/** CAP's event for each entity mode, as @restrict grants name it. */
const EVENTS: Record<EntityMode, string> = {
  query: "READ",
  get: "READ",
  create: "CREATE",
  update: "UPDATE",
  delete: "DELETE",
};
const CRUD = new Set(["READ", "CREATE", "UPDATE", "DELETE"]);

const has = (user: UserLike, role: string) => role === "any" || user.is(role);

/** @requires: any one of the roles. */
function meets(user: UserLike, roles: string[] | undefined): boolean {
  return !roles || roles.some((role) => has(user, role));
}

/**
 * @restrict as CAP decides it (generic/auth/restrictions.js): some grant for the event (or `*`)
 * to one of the user's roles. CRUD stays open when every grant is for a bound operation.
 */
function permits(user: UserLike, restrict: GrantSpec[] | undefined, event: string): boolean {
  return grantFor(user, restrict, event) !== "refused";
}

/**
 * The grants that apply to this user for the event (restrictions.js: `*` or the event, to one
 * of the user's roles), or undefined when the entity is not restricted for it: no @restrict,
 * or CRUD while every grant is for a bound operation.
 */
function applicable(
  user: UserLike,
  restrict: GrantSpec[] | undefined,
  event: string,
): GrantSpec[] | undefined {
  if (!restrict) return undefined;
  if (CRUD.has(event) && restrict.every((g) => g.grant !== "*" && !CRUD.has(g.grant)))
    return undefined;
  return restrict.filter(
    (g) => (g.grant === "*" || g.grant === event) && g.to.some((role) => has(user, role)),
  );
}

/** "open": not restricted for the event; "granted": by some grant; "refused": by none. */
function grantFor(
  user: UserLike,
  restrict: GrantSpec[] | undefined,
  event: string,
): "open" | "granted" | "refused" {
  const grants = applicable(user, restrict, event);
  if (!grants) return "open";
  return grants.length > 0 ? "granted" : "refused";
}

/**
 * Whether CAP filters this user's reads of the entity by a `where` (ADR 0015): every grant
 * that lets the user READ it has one. Not filtered when one grant has none, when the entity is
 * not restricted for READ, when the user may not read it at all (the tools are hidden then),
 * or for a privileged user, whom CAP does not check at all.
 */
export function readsFiltered(user: UserLike, entity: EntitySpec): boolean {
  if ((user as { _is_privileged?: boolean })._is_privileged) return false;
  const grants = applicable(user, entity.restrict, "READ");
  return !!grants?.length && grants.every((g) => g.where);
}

export function canUseMode(
  user: UserLike,
  service: ServiceSpec,
  entity: EntitySpec,
  mode: EntityMode,
) {
  return (
    meets(user, service.requires) &&
    meets(user, entity.requires) &&
    permits(user, entity.restrict, EVENTS[mode])
  );
}

/** A bound operation: its own @requires, else its entity's; grants of both, named after it. */
export function canCall(
  user: UserLike,
  service: ServiceSpec,
  op: OperationSpec,
  bound?: EntitySpec,
) {
  const grants =
    op.restrict || bound?.restrict
      ? [...(op.restrict ?? []), ...(bound?.restrict ?? [])]
      : undefined;
  return (
    meets(user, service.requires) &&
    meets(user, op.requires ?? bound?.requires) &&
    permits(user, grants, op.name.slice(op.name.lastIndexOf(".") + 1))
  );
}

/** The service as this user can reach it: entities with only their usable modes, callable operations. */
export function view(service: ServiceSpec, user: UserLike): ServiceSpec | undefined {
  if (!meets(user, service.requires)) return undefined;
  const entities = new Map(service.entities.map((e) => [e.name, e]));
  return {
    ...service,
    entities: service.entities
      .map((e) => ({
        ...e,
        modes: new Set([...e.modes].filter((m) => canUseMode(user, service, e, m))),
      }))
      .filter((e) => e.modes.size > 0),
    operations: service.operations.filter((op) =>
      canCall(user, service, op, op.boundTo ? entities.get(op.boundTo) : undefined),
    ),
  };
}

export function viewKey(service: ServiceSpec | undefined): unknown {
  return (
    service && [
      service.entities.map((e) => [e.name, [...e.modes]]),
      service.operations.map((o) => o.name),
    ]
  );
}
