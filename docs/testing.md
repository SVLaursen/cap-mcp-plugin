# Testing

v1 tested the plugin against a hand-made fake of CAP, which is why its bugs passed every test.
v2 tests against CAP itself.

## The pyramid

| Layer       | Where                      | What it proves                                                                    | Speed                      |
| ----------- | -------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| Contract    | `test/contract/`           | Given this CDS, this exact spec / schema / tool list                              | ms per test                |
| Behaviour   | `test/behaviour/`          | Over HTTP against the demo: data, errors, auth                                    | ~10 ms per test after boot |
| Regression  | `test/regression/`         | Each v1 finding stays fixed                                                       | as behaviour               |
| Auth matrix | `test/auth/`               | v1.9 auth parity (mocked, XSUAA, IAS, certificates, AMS)                          | as behaviour               |
| Conformance | `npm run conformance` (CI) | The official suite against the demo; known failures in `conformance-baseline.yml` | ~10 s                      |

## Contract tests

Compile a CDS snippet, run a pure function, compare the output.

```ts
import { compileSnippet } from "../helpers/snippet";
import { readModel } from "../../src/model-reader";

test("@mcp on a service exposes every entity with modes {query, get}", () => {
  const csn = compileSnippet(`
    @mcp service S {
      entity Books { key ID : Integer; title : String; }
    }
  `);
  const { spec, diagnostics } = readModel(csn);
  expect(diagnostics).toEqual([]);
  expect(spec.services[0]?.entities.map((e) => [e.name, [...e.modes]])).toEqual([
    ["S.Books", ["query", "get"]],
  ]);
});
```

- One behaviour per test. Name the test as the rule it proves.
- Keep snippets minimal: only the definitions the rule needs.
- Prefer `toEqual` on the whole relevant structure over many small `toBe` checks.

## Behaviour tests

Boot the demo once per file, then call it like a client.

```ts
import { as, bootDemo } from "../helpers/demo";
import { callTool } from "../helpers/mcp";

const demo = bootDemo();

test("bob's Orders over MCP equal bob's Orders over OData", async () => {
  const odata = await demo.GET("/orders/Orders?$select=orderNo", as("bob"));
  const mcp = await callTool(demo.POST, "bob", "OrdersService_Orders_query", {
    select: ["orderNo"],
  });
  expect(mcp.message?.result?.structuredContent).toMatchObject({ rows: odata.data.value });
});
```

`test/helpers/mcp.ts` sends what the SDK requires of a 2026-07-28 request (the
`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers; protocol version, client
capabilities and client info in `_meta`) and parses JSON or SSE responses into `message`.
`legacyRpc` / `legacyInitialize` speak the 2025 era (ADR 0010). `rpc(..., "anonymous", ...)`
sends no credentials.

- Each file gets a fresh in-memory database. Within a file, tests share state; keep write
  tests independent or order them deliberately.
- Use the demo users (`alice`, `bob`, `carol`). Need another role? Add a user to
  `demo/package.json` and document it in `demo/README.md`.
- Assert "same as OData" for anything CAP decides (authorization, validation, search).
- Need a feature target? Add it to the demo first (annotation, data, handler), with a row in
  `demo/README.md`.

## Never

- `jest.mock("@sap/cds")` or stubbing `global.cds` (ESLint fails the build).
- Asserting on log output instead of behaviour.
- Snapshot tests of whole tool lists: they turn every change into a blind "update snapshot".
  Assert the parts the rule is about.

## The auth matrix

`mocked` runs directly against the demo (`auth-matrix.test.ts`). Every other row is its own
file, because CAP builds its auth middleware once per boot: `xsuaa-secret`, `xsuaa-certificate`,
`ias-secret`, `ias-certificate` and `ias-ams.test.ts`. Each calls `authMatrixRow` from
`test/auth/scenario.ts` right after `bootDemo()`, which binds the demo to that kind and
credentials and runs the same scenario (admin token, token without roles, forged token, no token
in production, RFC 9728 metadata).

The recipe (`test/helpers/issuer.ts`):

- **Tokens are real.** `createIssuer()` makes an RSA key pair and signs RS256 JWTs with Node's
  `crypto`, with the claims XSUAA (`scope` prefixed with the xsappname) or IAS (`iss` in
  `domains`, `aud` = client id, roles in `ias_apis`) would issue.
- **Keys reach xssec through its own config**, not a stub: `cds.requires.auth.config` is passed
  to `@sap/xssec`'s service, and `validation.jwks.impl` is xssec's documented custom store for
  its JWKS cache. The issuer's store answers every lookup with its public key, so xssec checks
  signature, issuer, audience and expiry for real, offline. A token signed by another issuer
  fails (`MissingKidError`, 401).
- **Certificate rows** carry a self-signed certificate and key (made with the `openssl` CLI;
  Node's `crypto` cannot issue certificates) and no client secret. xssec uses them only to fetch
  tokens over mTLS, so validation is the same; the row proves `/mcp` and its metadata work with
  such a binding (the authorization server is still `url`, never `certurl`).
- **AMS**: real policy evaluation needs DCL compiled to DCN and an AMS bundle, which is
  `@sap/ams`'s own concern. The `ias-ams` row instead adds a middleware after `auth` that grants
  roles by wrapping `user.is`, as `AmsCapMiddleware.appendRoles` does, to an IAS token without
  `ias_apis`: the tool list and CAP's checks must both see those roles.
- Add `cds.middlewares.add(…)` only after `authMatrixRow(…)`: reading `cds.middlewares` builds
  CAP's auth middleware with whatever `cds.requires.auth` is at that moment.

## Coverage

`npm run test:coverage` (what CI runs) fails below the thresholds in `jest.config.js`
(statements 94, branches 88, functions 96, lines 95: what 2.0 measured, rounded down). The
`cds add` facet and the build task run in a child process (`cds-cli.test.ts`), so coverage does
not count them. Most of what stays uncovered is the executor's own argument checks, which the SDK's
schema validation reaches first. Coverage is a consequence of TDD here, not a target to chase:
never weaken a test to keep a number.
