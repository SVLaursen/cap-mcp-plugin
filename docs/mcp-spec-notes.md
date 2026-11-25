# MCP spec notes for v2

Target: [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Previous:
2025-11-25. Re-check the changelog when a new revision ships.

## Changes that shape v2

| Change in 2026-07-28                                                                      | Consequence for v2                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No protocol-level sessions, no `Mcp-Session-Id`; list endpoints don't vary per connection | Stateless adapter. Per-user tool lists come from the request's `cds.context.user`, not a session |
| No `initialize` handshake; version and client capabilities in each request's `_meta`      | Read and validate the version per request                                                        |
| New `server/discover` (MUST)                                                              | Advertise versions, capabilities, identity                                                       |
| `subscriptions/listen` replaces GET stream and `resources/subscribe`                      | Only relevant for P2 change notifications                                                        |
| `ping`, `logging/setLevel` removed; log level per request in `_meta`                      | Don't implement them                                                                             |
| Tasks moved to an extension (`io.modelcontextprotocol/tasks`)                             | P2 long-running actions                                                                          |
| Multi Round-Trip Requests: `input_required` + `inputResponses` on retry                   | How `@mcp.elicit` confirmation works                                                             |
| Every result has `resultType`                                                             | `complete` or `input_required`                                                                   |
| SSE resumability removed                                                                  | Broken streams just fail; nothing to implement                                                   |
| `extensions` capability                                                                   | MCP Apps (`ext-apps`) and tasks are extensions                                                   |
| OpenTelemetry trace context in `_meta`                                                    | P1 observability                                                                                 |
| Deterministic `tools/list` order (SHOULD)                                                 | Registry sorts by name                                                                           |
| `Mcp-Method`, `Mcp-Name` headers required on POST                                         | Verify in M4; helper sends `mcp-method`                                                          |
| `ttlMs` + `cacheScope` required on list/read results                                      | Set them; `private` scope since lists depend on the user                                         |
| Resource not found is `-32602`                                                            | Use it for missing records                                                                       |
| `iss` in authorization responses (RFC 9207); clients bind credentials to the issuer       | Proxying the authorization server must not hide `iss`                                            |
| Any JSON Schema 2020-12 in input/output schemas; `structuredContent` any JSON             | schema-mapper can emit full constraints                                                          |
| Error code ranges: `-32020…-32099` reserved for MCP                                       | `UnsupportedProtocolVersion` is `-32022`                                                         |

## Official extensions

The 2026-07-28 revision adds `extensions` to client and server capabilities and lists the
official extensions ([overview](https://modelcontextprotocol.io/extensions)); some, such as MCP
Apps, have dated specifications of their own from before it. Extensions are off by default. Checked
2026-11-25; stages from the overview page.

| Extension                        | Identifier                                                 | Stage                             | Where v2 stands                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP Apps                         | `io.modelcontextprotocol/ui`                               | Stable (spec 2026-01-26)          | Served: `@mcp.ui` (ADR 0012). The extension's specification defines only the client's declaration, so `server/discover` declares nothing (ADR 0012, addendum); the extensions overview shows a server declaring `{}` in an example, without normative language. UI links go to every client |
| Skills over MCP (SEP-2640)       | `io.modelcontextprotocol/skills`                           | Beta (the Skills page says Final) | Planned for 2.0, opt-in through `cds.mcp.skills` (ADR 0016, proposed); not built yet                                                                                                                                                                                                        |
| Tasks                            | `io.modelcontextprotocol/tasks`                            | Beta, to core                     | Not offered (P2, long-running actions). Moved out of core into this extension in 2026-07-28 (SEP-2663); "to core" is the overview's stated destination, back into the core protocol later                                                                                                   |
| OAuth client credentials         | `io.modelcontextprotocol/oauth-client-credentials`         | Stable                            | Not declared (2.x). Machine clients with a token from the client credentials grant should work wherever CAP accepts the token, since validation is CAP's; not verified (no test, and IAS token audience is open, docs/guide/production.md)                                                  |
| Enterprise-managed authorization | `io.modelcontextprotocol/enterprise-managed-authorization` | Stable                            | Not offered (2.x). Mostly the authorization server's job (ID-JAG validation); the resource server's part is not specified in a concrete field yet                                                                                                                                           |

Also listed, not considered for 2.0: Server Cards and Events (Beta), and five experimental
extensions (interceptors, variants, tool annotations, file uploads, filesystems).

## Conformance

`@modelcontextprotocol/conformance` 0.1.16 (`latest`, what `npm run conformance` uses) has no
2026-07-28 scenarios; `test/behaviour/protocol.test.ts` › "wire contract the SDK guarantees"
pins that contract instead. The 0.2.0 prereleases (`alpha` dist-tag, 0.2.0-alpha.12 on
2026-11-25) add `--spec-version 2026-07-28` and a requirements file for it
(`requirements/2026-07-28.yaml`, anchored to 0.2.0-alpha.10): server scenarios such as
`server-stateless`, `tools-list`, `tools-call-*` and `input-required-result-*`, with the
extension scenarios (`tasks-*`, `auth/client-credentials-*`,
`auth/enterprise-managed-authorization`) run but not scored. Re-check on each release of the
suite; move `npm run conformance` to 2026-07-28 once 0.2.0 is `latest`.

## Deprecated (don't adopt)

Roots, Sampling, Logging features · HTTP+SSE transport · Dynamic Client Registration (use
Client ID Metadata Documents) · `includeContext` `thisServer`/`allServers`.

## SDK

MCP TypeScript SDK v2 (stable since 27 Jul 2026) implements 2026-07-28 and replaces the single
`@modelcontextprotocol/sdk` package:

| Package                             | Use                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `@modelcontextprotocol/server`      | `McpServer`, tools, resources, prompts                                   |
| `@modelcontextprotocol/node`        | Streamable HTTP transport for Node `IncomingMessage`/`ServerResponse`    |
| `@modelcontextprotocol/express`     | Optional helpers: bearer auth, RFC 9728 metadata router, host validation |
| `@modelcontextprotocol/client`      | Test client (dev dependency)                                             |
| `@modelcontextprotocol/ext-apps`    | MCP Apps (issue #133)                                                    |
| `@modelcontextprotocol/conformance` | Conformance suite (M7)                                                   |

v1.x of the SDK stays on 2025-11-25 and gets fixes for at least six months after the v2
release. Whether SDK v2 can also serve 2025-11-25 clients is the M4 spike.

Docs: https://ts.sdk.modelcontextprotocol.io/v2/ · migration guide:
https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
