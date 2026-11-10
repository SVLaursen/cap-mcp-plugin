# Testing

v1 tested the plugin against a hand-made fake of CAP, which is why its bugs passed every test.
v2 tests against CAP itself.

## The pyramid

| Layer       | Where              | What it proves                                           | Speed                      |
| ----------- | ------------------ | -------------------------------------------------------- | -------------------------- |
| Contract    | `test/contract/`   | Given this CDS, this exact spec / schema / tool list     | ms per test                |
| Behaviour   | `test/behaviour/`  | Over HTTP against the demo: data, errors, auth           | ~10 ms per test after boot |
| Regression  | `test/regression/` | Each v1 finding stays fixed                              | as behaviour               |
| Auth matrix | `test/auth/`       | v1.9 auth parity (mocked, XSUAA, IAS, certificates, AMS) | as behaviour               |
| Conformance | CI (M7)            | Protocol compliance against the official suite           | minutes                    |

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
  expect(mcp.data.result.structuredContent.rows).toEqual(odata.data.value.map(/* … */));
});
```

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

`mocked` runs directly against the demo. For XSUAA and IAS rows, run a local token issuer in
the test (sign JWTs with a test key and point the credentials' `url`/`certificate` at it) so
`@sap/xssec` validates real tokens. Certificate rows need a test CA; generate it in the test
setup with Node's `crypto`. Do not stub `@sap/xssec`. Work this out in M5 and document the
recipe here.

## Coverage

Thresholds in `jest.config.js` (90/85/90/90) apply once modules are implemented. Coverage is a
consequence of TDD here, not a target to chase.
