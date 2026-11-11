# Lock it down for production

An MCP client is an autonomous agent acting as one of your users. The plugin adds no access
rules of its own: CAP decides, exactly as for OData. So production hardening is mostly CAP's
hardening, plus a few MCP-specific settings.

## Authentication

- Use CAP's real auth (`xsuaa`, `ias`, `jwt`); `/mcp` runs behind CAP's own middlewares, so
  whatever authenticates OData authenticates MCP (including `@sap/ams` policies).
- A client without a valid token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
  That public RFC 9728 document names your authorization server (`credentials.url` of the
  binding), so clients can find where to log in. There is no dynamic client registration.
- Multitenant XSUAA: set `cds.mcp.tenantHostPattern` (like the approuter's
  `TENANT_HOST_PATTERN`) so subscribers are sent to their own subdomain.
- With `NODE_ENV=production`, CAP's `restrict_all_services` default applies to `/mcp` too:
  anonymous callers are challenged even for `@requires: 'any'` services, unless you set it to
  `false`.

## Authorization

- Put `@requires` on every exposed service, and `@restrict` where users may only see some rows:

```cds
@requires: 'authenticated-user'
service OrdersService {
  @restrict: [
    { grant: 'READ', to: 'support' },
    { grant: '*', to: 'authenticated-user', where: 'createdBy = $user' }
  ]
  entity Orders { key ID : UUID; createdBy : String; total : Decimal; }
}
annotate OrdersService with @mcp;
```

- `tools/list` hides tools CAP would always refuse for the caller, but that is advertising, not
  enforcement: CAP checks every call, and `where` filters rows the same way as over OData.
- Hide fields agents must never see with `@mcp.omit` (never selected, filtered, searched or
  described), not by trusting the agent to ignore them.

## Exposure

- Expose only what agents need. `@mcp` on a service is read-only; review every
  `@mcp.wrap.modes`, exposed action and `@mcp.deepInsert` as a write path for an agent.
- Destructive actions: add `@mcp.elicit: ['confirm']` so the user confirms in the client
  before anything runs. Clients that cannot ask get an error instead of a silent call.
- `@mcp.describe` and `@mcp.compact` only describe what the caller can reach, but they still
  publish your model's shape. Leave them off unless agents need them.

## Settings to review (`cds.mcp`)

| Key                  | Why                                                                               |
| -------------------- | --------------------------------------------------------------------------------- |
| `allowedOrigins`     | Browser origins that may call `/mcp`; any other `Origin` gets 403 (DNS rebinding) |
| `limits.maxRows`     | Upper bound on `top` per query call (default 200)                                 |
| `limits.defaultRows` | Page size when the agent gives none (default 25)                                  |
| `name`, `version`    | Identify the server to clients; set them to tell apps apart                       |
| `instructions`       | Tell agents how to use your tools; `cds build` copies an instructions file        |

## Before you deploy

- [ ] The startup report has no `error` lines, and every `warn` line is understood.
- [ ] Every exposed service has `@requires`; row rules are `@restrict … where`.
- [ ] Each write tool and action is intended; destructive ones have `@mcp.elicit`.
- [ ] Sensitive fields are `@mcp.omit`.
- [ ] Tested as a low-privilege user: `tools/list` shows only what that user should use.
- [ ] Outside development, error details stay hidden: unexpected errors reach clients as
      "Internal error" when `NODE_ENV=production`.
