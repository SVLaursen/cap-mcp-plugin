# v1 reference

How v1 (gavdilabs/cap-mcp-plugin 1.8.0, commit `71acc74`, plus 1.9 / PR #163) maps to v2, and
what not to carry over. Read v1 to understand behaviour; port it through tests, never by
copying files.

## The six issues v2 must not repeat

Each has a test in `test/regression/v1-findings.test.ts`.

| #   | Issue                                                                                                               | Where in v1                                             | v2 rule                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Write tools swallow commit errors (`try { await tx.commit() } catch {}`), so a failed commit is reported as success | `src/mcp/entity-tools.ts` create/update/delete handlers | No manual transactions; let CAP commit and surface failures                 |
| 2   | `q` searches every String field, including `@mcp.omit` ones, so hidden values can be probed with `contains`         | `entity-tools.ts` `buildQuery`                          | `SELECT.search` with `@cds.search`; omitted fields never searchable         |
| 3   | `cap_describe_model` reflects the whole CSN regardless of annotations or roles                                      | `src/mcp/describe-model.ts`                             | `@mcp.describe` is per service and only describes what that service exposes |
| 4   | Sessions are not bound to their user and never evicted in JSON-response mode                                        | `src/mcp/session-manager.ts`, `src/mcp.ts`              | Stateless; no sessions                                                      |
| 5   | Reads use `svc.run` with the ambient context; writes use `svc.tx({ user })`                                         | `entity-tools.ts`                                       | One `cds.context` per request; same path for every operation                |
| 6   | `return: "count"` reuses the page's `limit`/`orderBy`, so a count with `skip > 0` returns nothing                   | `entity-tools.ts` `executeQuery`                        | Count query has no limit, offset or order                                   |

## Module map

| v1 file                                                                | Lines  | v2 home                         | Notes                                                    |
| ---------------------------------------------------------------------- | ------ | ------------------------------- | -------------------------------------------------------- |
| `src/annotations/*`                                                    | ~1,570 | `model-reader`                  | Replace 16-arg constructors with plain data (`types.ts`) |
| `src/mcp/utils.ts` `determineMcpParameterType`                         | 60     | `schema-mapper`                 | Table, not `switch`; no `"Optional"` suffix              |
| `src/mcp/factory.ts`                                                   | 94     | `exposure-registry`             | No `instanceof` chain                                    |
| `src/mcp/entity-tools.ts`                                              | 1,234  | `executor` + `schema-mapper`    | CQN objects, no `withTimeout`, no string-built filters   |
| `src/mcp/tools.ts`                                                     | 253    | `executor`                      | `srv.send` for operations, unchanged in spirit           |
| `src/mcp/resources.ts`, `validation.ts`, `custom-resource-template.ts` | ~850   | dropped                         | Resources become single records by key                   |
| `src/mcp/elicited-input.ts`                                            | 203    | `adapter` (MRTR)                | Server-initiated elicitation is gone in 2026-07-28       |
| `src/mcp/prompts.ts`                                                   | 84     | `exposure-registry` + `adapter` | Add role visibility (P2)                                 |
| `src/mcp/describe-model.ts`                                            | 129    | `exposure-registry`             | Scoped per service                                       |
| `src/mcp/session-manager.ts`, `src/mcp.ts`                             | ~370   | `adapter`                       | Stateless                                                |
| `src/auth/*`                                                           | ~1,400 | `adapter` + CAP                 | CAP authenticates; we serve metadata                     |
| `src/config/*`                                                         | ~580   | `cds.env`                       | camelCase keys, no hand-written JSON parser              |
| `src/logger.ts`                                                        | 55     | `cds.log("mcp")`                | One channel                                              |

## Keep from v1

- Tool annotations from `function` vs `action` (`readOnlyHint` / `destructiveHint`).
- Using the host app's `cds` instead of a second copy (now passed in, not read from global).
- Coercion of precision-sensitive keys (`Int64`, `Decimal`) as strings.
- The `cds build` task that copies an instructions file (`src/config/build.ts`).

## v1.9 — PR #163 (Willem Pardaens): what v2 must keep

- **X.509 certificate credentials** for XSUAA and IAS token requests (mTLS via an undici
  `Agent`). v2: one token client handles secret and certificate, not three copies.
- **IAS-only** setups use `xssec.IdentityService` when there is no XSUAA binding.
- **`@sap/ams`** roles: AMS registers its middleware after v1 copied CAP's `before` chain, so
  the PR re-implements AMS's middleware and patches `user.is`. v2 mounts inside CAP's pipeline
  so AMS applies with no special code (ADR 0002). The auth matrix proves it.

## Issue #133 — MCP Apps

Requested: an `@mcp` `ui` property on a CDS operation pointing at a `ui://` resource; register
with the SDK's app-tool and app-resource APIs; a hook for custom resource registration. The
maintainer committed to it for v2. v2: `@mcp.ui`, implemented with
`@modelcontextprotocol/ext-apps` in M5. Demo target: `CatalogService.bookCard`.
