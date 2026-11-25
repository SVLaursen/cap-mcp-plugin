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

### How MCP clients register with XSUAA and IAS

An MCP client needs a client ID at the authorization server. MCP 2026-07-28 has it try, in
order: client information it was configured with (pre-registration), a Client ID Metadata
Document (when the authorization server's metadata has `client_id_metadata_document_supported`),
Dynamic Client Registration (when it has a `registration_endpoint`; deprecated in 2026-07-28),
and otherwise asking the user.

**Plan for a pre-registered OAuth client**, for XSUAA and for IAS. Neither service documents
Client ID Metadata Documents, and the dynamic registration IAS mentions is not documented far
enough to rely on (see below).

**XSUAA.** Clients come from the app's own XSUAA service instance: a binding or a service key
carries a client ID and secret. Allow the MCP client's redirect URI in `xs-security.json` (XSUAA
rejects any other; wildcards are allowed, and `localhost` is always allowed in cloud landscapes):

```json
{
  "xsappname": "bookshop",
  "oauth2-configuration": {
    "redirect-uris": ["<the MCP client's callback URL>"]
  }
}
```

Update the service instance with it, create a service key (`cf create-service-key bookshop-auth
mcp-client`), and enter its `clientid` and `clientsecret` in the client's OAuth settings. The
client then finds the authorization server through the RFC 9728 metadata above.

That secret belongs to the app's own OAuth client. It also allows the client credentials grant,
so whoever holds it can get tokens with the app's `authorities` without any user logging in:
give it only to an MCP client that keeps secrets on the user's machine, never to a public or
shared one. Whether each service key is a client of its own or shares the instance's client ID
(with only the secret per key) is not verified here; decode tokens from two keys and compare
`client_id` before you count on keys to tell MCP clients apart. A separate XSUAA instance per
MCP client, granted the app's scopes, would give each its own client; that setup is not
verified here either.

**IAS.** Create an OpenID Connect application for the MCP client in the administration console
of SAP Cloud Identity Services, with the client's redirect URI and the authorization code grant.
Give it a secret, or make it a public client: IAS asks for PKCE with public clients and
recommends it for confidential ones. Enter its client ID (and secret) in the MCP client. Open
step: a token issued to that application carries its client ID as audience, and whether the CAP
app accepts it depends on how the two applications are connected in IAS (for example, the app
providing an API that the client's application consumes). That part is not verified here;
check it before you rely on this setup.

**What was checked, and what was not** (25 Nov 2026):

- Verified in SAP's documentation (the
  [SAP-docs/btp-cloud-platform](https://github.com/SAP-docs/btp-cloud-platform) pages for the
  SAP Authorization and Trust Management service, and help.sap.com for Cloud Identity Services):
  XSUAA clients come from bindings and service keys, with client ID and secret; `redirect-uris`
  in `oauth2-configuration` are enforced, wildcards allowed, `localhost` always allowed;
  XSUAA supports the authorization code, client credentials and SAML 2.0 bearer grants and
  refresh tokens. IAS ([Configuring OpenID Connect](https://help.sap.com/docs/cloud-identity-services/cloud-identity-services/openid-connect))
  supports OIDC Discovery and lists the "OAuth 2.0 Dynamic Client Registration Protocol"; its
  [discovery document](https://help.sap.com/docs/cloud-identity-services/cloud-identity-services/call-identity-authentication-discovery-endpoint)
  is at `https://<tenant>.accounts.ondemand.com/.well-known/openid-configuration` (or
  `.accounts.cloud.sap`, or a custom domain) and lists `code_challenge_methods_supported:
["plain", "S256"]`, `authorization_response_iss_parameter_supported: true` and
  `offline_access` among its scopes; IAS requires PKCE for public clients.
- Not found in SAP's documentation: Client ID Metadata Documents for either service; dynamic
  client registration, a discovery URL, PKCE or public clients for XSUAA; how dynamic
  registration is used in IAS (its endpoint and who may call it). The documented IAS discovery
  example has no `registration_endpoint`, so an MCP client that follows discovery would not find
  one there.
- Not verified at all: a live tenant's metadata; any MCP client completing dynamic registration
  against IAS; whether a CAP app with IAS accepts a token issued to a separate IAS application
  (its audience is that application's client ID); whether XSUAA service keys are separate
  OAuth clients. Check these in the smoke test on BTP before
  you rely on them. IAS also notes that an issuer without HTTPS is not OIDC-compliant; MCP
  clients check the issuer (RFC 9207), so use an HTTPS issuer.

### Asking for scopes

MCP clients choose the scopes they request from the challenge's `scope`, else from the
metadata's `scopes_supported`, else they ask for none. To tell them, list the scopes:

```json
{
  "cds": {
    "mcp": { "scopes": ["bookshop!t1234.read", "openid"] }
  }
}
```

The challenge then reads
`Bearer resource_metadata="…", scope="bookshop!t1234.read openid"`, and the metadata has
`"scopes_supported": ["bookshop!t1234.read", "openid"]`. Write the scopes as your authorization
server issues them: for XSUAA, with the `xsappname` prefix. Without the setting both are as
above. `offline_access` is refused (`INVALID_CONFIG`): the MCP specification says servers should
not ask for refresh tokens; clients add it themselves when the authorization server offers it.
The scopes only tell the client what to ask for; CAP still checks `@requires` and `@restrict`
on every call.

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

### When a `where` filters the caller's rows

An agent that gets an empty result tends to tell the user that the data does not exist. So when
CAP filters a caller's reads, the plugin says so (ADR 0015). In the example above, a user
without `support` reads `Orders` only through the `where` grant, and gets:

- one more line in the `query` and `get` tools' descriptions: "Your access to these records is
  limited by authorization.";
- a `notice` first in every query result: "Your authorization limits which OrdersService.Orders
  records you can see. Records outside it are not included in this result. An empty or smaller
  result does not mean that no other records exist.";
- from `get`, for a key it cannot find: "No OrdersService.Orders with {…}, or it is not visible
  to you: your authorization limits which OrdersService.Orders records you can see."

A `support` user also holds a grant without `where`, reads everything, and sees none of this.
The notices never name the condition, an attribute, a value or a count.

The plugin only knows `@restrict`. Rows filtered by your own `READ` handlers, `@sap/ams`
attribute policies or the database are not announced; add your own text through `mcp:hints` if
agents need it. Set `cds.mcp.filterNotices: false` to turn the notices off.

## Exposure

- Expose only what agents need. `@mcp` on a service is read-only; treat every
  `@mcp.wrap.modes`, exposed action and `@mcp.deepInsert` as a write path for an agent.
- Destructive actions: add `@mcp.elicit: ['confirm']` so the user confirms in the client before
  anything runs. Clients that cannot ask get an error instead of a silent call.
- `@mcp.describe` and `@mcp.compact` describe only what the caller can reach, but they still
  publish your model's shape. Leave them off unless agents need them.
- Skills (`cds.mcp.skills`) are instructions for agents, not data and not authorization: every
  caller the endpoint lets in reads the same skills, and CAP still checks every call a skill
  leads to. Write nothing in a skill that a caller of `/mcp` may not read.

## Settings to review

| Key (`cds.mcp`)      | Why                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `allowedOrigins`     | Browser origins that may call `/mcp`; any other `Origin` gets 403, see below                                                    |
| `tenantHostPattern`  | Multitenant XSUAA, see above                                                                                                    |
| `skills`             | Skills over MCP: a folder of skills every caller can read, see Exposure above                                                   |
| `scopes`             | OAuth scopes clients should ask for, in the challenge and the RFC 9728 metadata, see above                                      |
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
