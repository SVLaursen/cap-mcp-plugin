/**
 * M3 — result shapes that do not need a database: what the executor makes of what a handler
 * returns. The service here is a ServiceLike stand-in (not a CAP mock): it only returns a value.
 */
import cds from "@sap/cds";
import { Executor, type ServiceLike } from "../../src/executor";
import { ExposureRegistry } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";
import { schemaError } from "../helpers/validate";

const registry = ExposureRegistry.fromModel(
  compileSnippet(
    `@mcp service S { function many() returns array of Integer; function one() returns Integer; }`,
  ),
);
const user = new cds.User({ id: "bob", roles: [], attr: {} });
const returning = (value: unknown): ServiceLike => ({
  name: "S",
  run: async () => value,
  send: async () => value,
});

test.each([
  ["S_many", undefined, { value: [] }],
  ["S_many", null, { value: [] }],
  ["S_one", undefined, { value: null }],
])("%s returning %p gives %p, which passes its outputSchema", async (name, returned, expected) => {
  const tool = registry.toolsFor(user).find((t) => t.name === name);
  if (!tool?.outputSchema) throw new Error(`${name} has no output schema`);
  const result = await new Executor(registry.spec).execute(tool, {}, returning(returned), user);
  expect(result.structuredContent).toEqual(expected);
  expect(schemaError(tool.outputSchema, result.structuredContent)).toBeUndefined();
});

describe("resources", () => {
  const keyed = ExposureRegistry.fromModel(
    compileSnippet(`@mcp service R {
      @mcp.resource entity Pairs { key a: String; key b: Integer; key c: Boolean; v: String; }
      @mcp.resource entity Ones { key ID: Integer; }
    }`),
  );
  /** Records the key of the SELECT it is sent, and returns that key as the row. */
  const echo = (): ServiceLike & { where?: unknown } => {
    const service: ServiceLike & { where?: unknown } = {
      name: "R",
      run: async (q) => {
        const from = (q as { SELECT: { from: { ref: [{ where: unknown }] } } }).SELECT.from;
        service.where = from.ref[0].where;
        return { a: "x/y;z=1", b: 7, c: true, v: "v" };
      },
      send: async () => undefined,
    };
    return service;
  };

  test("a composite key in a resource_link reads back as the same typed key", async () => {
    const executor = new Executor(keyed.spec);
    const service = echo();
    const tool = keyed.toolsFor(user).find((t) => t.name === "R_Pairs_get");
    if (!tool) throw new Error("no R_Pairs_get");
    const got = await executor.execute(tool, { a: "x/y;z=1", b: 7, c: true }, service, user);
    const uri = got.links?.[0]?.uri ?? "";
    expect(uri).toBe("cap://R/Pairs/a=x%2Fy%3Bz%3D1;b=7;c=true");
    const where = service.where;
    expect(where).toBeDefined();
    const read = await executor.readResource("R.Pairs", uri.split("/").at(-1) ?? "", service);
    expect(service.where).toEqual(where);
    expect(read.structuredContent).toEqual(got.structuredContent);
  });

  test("keys that are not the entity's are refused before CAP is asked", async () => {
    const executor = new Executor(keyed.spec);
    for (const [entity, key] of [
      ["R.Ones", "abc"],
      ["R.Ones", "%E0%A4%A"],
      ["R.Pairs", "a=x;b=1"],
      ["R.Pairs", "a=x;b=1;c=true;d=2"],
    ] as const) {
      await expect(executor.readResource(entity, key, echo())).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    await expect(executor.readResource("R.Nope", "1", echo())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
