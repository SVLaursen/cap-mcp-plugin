# v2 plan

Condensed from the review "CAP MCP Plugin — v1 Review & v2 Roadmap" (10 Nov 2026). The full
review, including the evidence for each finding, lives in that document; this file keeps what
you need to build v2.

## Why a rewrite

1. **The protocol moved.** The MCP 2026-07-28 spec removes sessions, the `initialize` handshake
   and `Mcp-Session-Id`, and says list endpoints no longer vary per connection. v1's runtime is
   a per-session `McpServer` filtered by whoever initialised it. Server-initiated elicitation is
   replaced by Multi Round-Trip Requests; Dynamic Client Registration is deprecated in favour of
   Client ID Metadata Documents.
2. **v1 bypasses CAP** where CAP already does the job: authorization, transactions, search,
   OData parsing, service lookup.
3. **The code is hard to test.** A few large, globally coupled modules; tests that mock
   `@sap/cds` instead of running CAP.

## Goals for 2.0

- A stateless, CAP-native MCP adapter: one request, one `cds.context`, one CAP transaction.
- Authorization delegated to CAP (`@requires`, `@restrict`, AMS), never re-implemented.
- Everything opt-in; `@mcp` on a service gives a safe read-only baseline.
- Small modules behind the contract in `src/types.ts`, built test-first.
- Every v1 correctness/security issue covered by a regression test.

## Must-haves (P0) for 2.0

| Feature                                                | Notes                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Stateless transport, MCP 2026-07-28                    | SDK v2 (`@modelcontextprotocol/server`). Older-client support decided by a spike in M4               |
| Authorization delegated to CAP                         | `@requires`, `@restrict` (incl. `where`), `@sap/ams` policies                                        |
| Fix the six v1 issues                                  | `test/regression/v1-findings.test.ts`                                                                |
| `outputSchema` + `structuredContent`                   | Derived from the entity or operation return type                                                     |
| Cursor pagination with totals; real NOT_FOUND on `get` |                                                                                                      |
| Service-level `@mcp` read-only baseline                | Defaults from `@title`, `@description`, doc comments                                                 |
| Spec-compliant auth                                    | RFC 9728 metadata, Client ID Metadata Documents, no fake DCR; keep v1.9's X.509 and IAS-only support |
| MCP Apps (issue #133)                                  | `@mcp.ui` → `ui://` resource; hook for custom resource registration                                  |

## Should-haves (P1), 2.x

Draft-aware writes · multitenancy and extensibility · compact generic tool mode
(`@mcp.compact`) · `cds add mcp`, stdio via a bridge (no `cds mcp`, decided in M6), startup exposure report · confirmation via
MRTR (`@mcp.elicit`) · argument completion (`@mcp.completion`) · structured CAP errors ·
OpenTelemetry and audit logging · resources as single records with `resource_link`.

## Later (P2)

Long-running actions via the tasks extension · change notifications via
`subscriptions/listen` · binary content as resources · role-restricted, file-based prompts. (Per-tool row and call budgets: dropped, see the backlog;
CAP's `@cds.query.limit` and the SAP AI Gateway cover them.)

## Decided

- Everything is opt-in (ADR 0004). Functions are baseline; actions are not.
- Tools handle querying and writes; `@mcp.resource` is only for single records by key, linked
  from tool results with `resource_link`. The OData-syntax resource templates are dropped
  (ADR 0006).
- Annotation names: `@mcp.describe`, `@mcp.compact`, `@mcp.completion` (ADR 0008).
- v1.9 ships with PR #163 (X.509 certificates, IAS-only via IdentityService, `@sap/ams`); v2
  keeps parity through the auth matrix in `test/auth/`.
- SDK: MCP TypeScript SDK v2 implements 2026-07-28 (ADR 0001).

## Dropped from v1

OData-syntax resource templates · `explain` on query tools · lenient key normalisation on `get` ·
the singleton plugin class · `wrap_entities_to_actions` / `enable_model_description` defaults ·
the OAuth proxy's fake DCR.
