# Authentication and production

An MCP client is an agent acting as one of your users. The plugin adds no access rules of its
own: CAP authenticates the request and decides what the user may do, exactly as for OData. So
hardening for production is mostly CAP's hardening, plus a few MCP-specific settings.

## How a request is authenticated

`/mcp` is mounted behind CAP's own middlewares (`cds.middlewares.before`), the same chain that
OData uses. Whatever authenticates OData authenticates MCP: `mocked`, `basic`, `jwt`, `xsuaa`,
`ias`, X.509 certificate credentials, and other plugins' middleware such as `@sap/ams`. The
caller is `cds.context.user`, with its roles, tenant and locale, for everything the call does.

There is nothing MCP-specific to configure for authentication: bind your XSUAA or IAS instance
as you do for the rest of the app.

### Telling clients where to log in (RFC 9728)

With OAuth-based auth (`xsuaa`, `ias`, `jwt`), a request without a valid token gets:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<your-app>/.well-known/oauth-protected-resource/mcp"
```

That URL is public and serves the
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected resource metadata, as MCP clients
expect:

```json
{
  "resource": "https://<your-app>/mcp",
  "authorization_servers": ["https://<subdomain>.authentication.<region>.hana.ondemand.com"],
  "bearer_methods_supported": ["header"]
}
```

The authorization server is the `url` of the bound XSUAA or IAS credentials. URLs follow
`X-Forwarded-Proto` and `X-Forwarded-Host`, so they are right behind the BTP router. With mocked
or basic auth the challenge is CAP's own (`WWW-Authenticate: Basic`), and the metadata URL
answers 404.

The plugin is not an authorization server. It does not register clients (no dynamic client
registration) and issues no tokens: how a client gets credentials is up to your XSUAA or IAS
setup, for example an OAuth client you create for the agent's host.

### Multitenant XSUAA

In a multitenant app, each subscriber logs in at its own subdomain. The metadata is read before
login, so the request's host is all the plugin can go by. Set `tenantHostPattern`, a regular
expression over the host whose first capture group is the subscriber's subdomain (like the
approuter's `TENANT_HOST_PATTERN`):

```json
{
  "cds": {
    "mcp": { "tenantHostPattern": "^(.*)-bookshop\\." }
  }
}
```

A request to `acme-bookshop.cfapps.eu10.hana.ondemand.com` then gets
`https://acme.<uaadomain>` as its authorization server. Without the setting, or when the host
does not match, the metadata names the bound `credentials.url`.

### Anonymous callers in production

With `NODE_ENV=production`, CAP's `restrict_all_services` default applies to `/mcp` as it does
to OData: anonymous callers are asked to log in, even for services with `@requires: 'any'` or
without `@requires`. Set `cds.requires.auth.restrict_all_services: false` only if you really want
public MCP tools.

## Authorization

Put `@requires` on every exposed service, and `@restrict` where users may only see some rows:

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

- **Enforced by CAP, on every call:** `@requires`, `@restrict` (including `where`, which filters
  rows the same way as over OData), `@sap/ams` policies, your handlers. A user gets over MCP
  exactly the rows they get over OData.
- **Hidden by the plugin:** `tools/list` leaves out tools CAP would always refuse for the
  caller (`@requires`, and the roles of `@restrict` grants), and the describe and compact tools
  only name what the caller can reach. That keeps agents from trying what cannot work. It is not
  a security boundary: CAP still checks every call.
- **Never exposed:** fields with `@mcp.omit` are never selected, filtered, searched or described.
  Use it for fields agents must not see, rather than trusting the agent to ignore them.

## Exposure

- Expose only what agents need. `@mcp` on a service is read-only; treat every
  `@mcp.wrap.modes`, exposed action and `@mcp.deepInsert` as a write path for an agent.
- Destructive actions: add `@mcp.elicit: ['confirm']` so the user confirms in the client before
  anything runs. Clients that cannot ask get an error instead of a silent call.
- `@mcp.describe` and `@mcp.compact` describe only what the caller can reach, but they still
  publish your model's shape. Leave them off unless agents need them.

## Settings to review

| Key (`cds.mcp`)      | Why                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `allowedOrigins`     | Browser origins that may call `/mcp`; any other `Origin` gets 403, see below                                                    |
| `tenantHostPattern`  | Multitenant XSUAA, see above                                                                                                    |
| `limits.maxRows`     | Upper bound on `top` per query call (default 200); CAP's `@cds.query.limit` per entity and `cds.query.limit.max` cap it further |
| `limits.defaultRows` | Page size when the agent gives none (default 25)                                                                                |
| `name`, `version`    | Identify the server to clients; set them to tell apps apart                                                                     |
| `instructions`       | Tell agents how to use your tools; `cds build` copies an instructions file to `gen`                                             |

All keys are in the [configuration table](../../README.md#configuration).

### Browser clients and DNS rebinding

A web page can make a browser send requests to `/mcp`, including to `localhost` through DNS
rebinding, where the attacker's name resolves to your server and the browser sends that name as
both `Host` and `Origin`. So a request with an `Origin` header gets `403` unless the origin is
listed in `allowedOrigins`. There is no implicit "own origin", since it could only come from the
`Host` header.

- Desktop and IDE clients, server-side agents and bridges such as `mcp-remote` send no `Origin`
  and are not affected.
- Browser-based clients must be listed: a web app that calls `/mcp` from the browser (even one
  served by the same CAP app), or the MCP Inspector in its direct connection mode
  (`http://localhost:6274`; its default proxy mode sends no `Origin`).

```json
{
  "cds": {
    "mcp": { "allowedOrigins": ["https://agents.example.com", "http://localhost:6274"] }
  }
}
```

## Errors

Unexpected errors (failed commits, bugs) reach clients as "Internal error" in production
(`NODE_ENV=production`), with the details in your server log. CAP's own errors (validation,
authorization, your `req.reject`) reach the agent with their code, message and target, translated
to the caller's locale, so it can correct the call.

## Before you deploy

- [ ] The startup report has no `error` lines, and every `warn` line is understood.
- [ ] Every exposed service has `@requires`; row rules are `@restrict … where`.
- [ ] Each write tool and action is intended; destructive ones have `@mcp.elicit`.
- [ ] Sensitive fields are `@mcp.omit`.
- [ ] Tested as a low-privilege user: `tools/list` shows only what that user should use.
- [ ] A request without a token gets 401 with the `resource_metadata` pointer, and the metadata
      names your authorization server.
