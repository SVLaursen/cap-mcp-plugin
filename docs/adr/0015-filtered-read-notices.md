# 0015 — Tell the agent when its reads are filtered

Status: proposed · 2026-11-18

## Context

CAP's `@restrict` grants can carry a `where`. CAP adds it to every read of the entity, so a
user restricted to some rows gets an ordinary result that is smaller, or empty. Over OData a
person knows their own role. An agent does not: in an evaluation of three rounds, a user
restricted to one site asked about another site, every query came back empty, and in 9 of 10
runs the agent said the data did not exist. When the agent had been told by other means that
access is limited by role, it answered correctly ("that is outside what you may see").
Knowledge served beside the data (`mcp:resources`, `mcp:hints`) did not fix it, because nothing
said that a filter was in play for that read.

Entities a user may not read at all are already left out of `tools/list` (ADR 0004, access.ts).
Agents handle that acceptably, so this ADR does not change it.

How CAP decides (`libx/_runtime/common/generic/auth/restrict.js` and `restrictions.js`):

- The grants that apply to a READ are those for `READ` or `*` whose `to` names one of the
  user's roles (`any` and `authenticated-user` included).
- If the entity is restricted only for bound operations, CRUD is open (no filter).
- If no grant applies, the request is refused (403); our registry already hides the tools.
- If any applicable grant has no `where`, the user reads unrestricted.
- Otherwise CAP adds the `where`s of the applicable grants, joined with `or`, to the query.
- A composition child without its own `@requires`/`@restrict` takes its ancestor's grants for
  the role check (`_auth_depends_on`). The ancestor's `where` is added only to the ancestor's
  segment of a path; a direct read of the child gets no condition.
- A service-level `@restrict` is a role check only; it filters no rows.

## Decision

The plugin tells the agent that its reads of an entity are filtered, only when they are.

**Filtered** means: for the current user, the entity's own `@restrict` has at least one grant
for `READ` or `*` to one of the user's roles, and every such grant has a `where`. This mirrors
CAP's rule above and is decided per request from the compiled model and `cds.context.user`.
No query is run to find out whether rows were actually dropped: the notice says that a filter
applies, not what it removed.

The model reader keeps only _whether_ a grant has a `where` (`GrantSpec.where: true`), never the
condition. Grants a composition child inherits are kept without it, because CAP adds no
condition to a direct read of the child.

What a filtered user gets, for the generated query and get tools of that entity:

- **Query results:** a `notice` property, first in the structured result, so it also comes
  first in the JSON text content:

  > Your authorization limits which `<entity>` records you can see. Records outside it are not
  > included in this result. An empty or smaller result does not mean that no other records
  > exist.

  `notice` is declared (optional, `type: string`) in the output schema of that user's query
  tool.

- **Get-by-key, record not found:** still `NOT_FOUND`, with the message
  `No <entity> with <key>, or it is not visible to you: your authorization limits which <entity>
records you can see.` A found record has no notice.
- **Tool descriptions:** the query and get tools get one more paragraph,
  `Your access to these records is limited by authorization.` The tool list is built per
  request already; the filtered variant of each read tool is built once per model and picked
  per caller, so the cost per request is one check per read tool.
- **Compact tools** (`@mcp.compact`): `_query` and `_get` results get the same notice and
  not-found message for the entity they name. Their descriptions get no line, because one tool
  covers many entities.

`<entity>` is the entity's title as the other tool texts use it (its `@title`, else its
qualified name).

For every user and read that is not filtered, the tools, their schemas and descriptions, and
the results are exactly what they were before this ADR. The schema property is added only to
filtered users' tools, which is stricter than "optional for everyone".

Writes, actions and functions are unchanged. So is `resources/read` of `cap://` records.

### What the notice does not say

It names no condition, no attribute, no `$user` value, no role, and no count of what was left
out. The condition is the app's security model; an agent does not need it to answer "that is
outside what you may see", and a client should not learn it. A count would need an extra,
unfiltered query, which ADR 0003 rules out (the plugin never reads past CAP's authorization).
The model reader does not keep the condition, so no code path can leak it.

### Where the plugin stays silent

The plugin only knows what `@restrict` says. It says nothing, rather than guess, when rows are
filtered by anything else:

- custom `before`/`on`/`after` READ handlers that add conditions, drop rows or mask fields;
- `@sap/ams` attribute policies, or an app that overrides how CAP computes restrictions in code
  (`srv.getRestrictions`);
- database-level rules (HANA analytic privileges, views that filter by session user) and
  remote services that filter on their side;
- draft visibility (a user sees only their own drafts; the active rows are still covered by the
  notice when `@restrict` filters them);
- tenant isolation in multitenant apps (each tenant's data is all there is for that user).

These reads are not filtered in CAP's sense, so the plugin is also silent:

- the user holds at least one applicable grant without `where` (also when they hold a `where`
  grant as well);
- the entity has no `@restrict`, or it restricts only bound operations;
- a composition child that inherits its ancestor's grants (CAP adds no condition to a direct
  read of it);
- a service-level `@restrict` (a role check only).

A `where` that compares only `$user` attributes with constants (`$user.level > 2`) is resolved
by CAP per user, to all rows or none. The plugin cannot tell which without evaluating the
user's attributes the way CAP does, and still says a filter applies: CAP does add the
condition.

### Configuration

On by default; `cds.mcp.filterNotices: false` turns it off for everyone. It is a registered
key, so it never trips `UNKNOWN_CONFIG`; anything but a boolean is `INVALID_CONFIG` and the
default is used. ADR 0004 (everything opt-in) is about what is exposed. This exposes nothing:
it only explains a result the user already gets, and it is the maintainer's decision
(2026-11-18) that it be on unless switched off.

## Alternatives considered

- **Count what was left out** (an unfiltered count beside the filtered one). Reveals what the
  user may not see, and reads past CAP's authorization. Rejected.
- **Say it only when the result is empty.** A smaller result misleads as much ("that site has
  no stock" from the rows the user happens to see). Rejected.
- **A notice on every restricted entity.** Noise for users with an unconditional grant, and the
  maintainer's decision was "only when a filter actually applies". Rejected.
- **Hints from code only (`mcp:hints`, ADR 0014).** An app could write the line itself, but
  every app would have to re-derive CAP's grant rules, and results could not carry it.
- **Declare `notice` in every query tool's schema.** Simpler, but changes every caller's
  `tools/list`; building the variant per filtered caller keeps everyone else byte-identical.

## Consequences

- `GrantSpec` (`src/types.ts`) has `where?: true`; `src/access.ts` has `readsFiltered`.
- The registry keeps two variants of each read tool of an entity with a `where` grant, and the
  executor decides the notice from the same rule, so description, schema and result agree.
- The text is fixed English, like the plugin's other tool texts. Apps that need another
  wording can turn it off and add their own through `mcp:hints`.
