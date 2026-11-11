/**
 * M3 — result shapes that do not need a database: what the executor makes of what a handler
 * returns. The service here is a ServiceLike stand-in (not a CAP mock): it only returns a value.
 */
import cds from "@sap/cds";
import { ConfirmationRequired, Executor, type ServiceLike } from "../../src/executor";
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

describe("confirmation (@mcp.elicit)", () => {
  const elicit = ExposureRegistry.fromModel(
    compileSnippet(`@mcp service E {
      @mcp @mcp.elicit: ['confirm', 'amount'] action pay(amount: Integer, memo: String);
    }`),
  );
  const tool = elicit.toolsFor(user).find((t) => t.name === "E_pay");
  const sending = () => {
    const sent: unknown[] = [];
    const service: ServiceLike = {
      name: "E",
      run: async () => undefined,
      send: async (req) => void sent.push(req.data),
    };
    return { sent, service };
  };

  test("unconfirmed, nothing is sent; the error carries the form, pre-filled", async () => {
    if (!tool) throw new Error("no E_pay");
    const { sent, service } = sending();
    const call = new Executor(elicit.spec).execute(tool, { amount: 5, memo: "m" }, service, user);
    await expect(call).rejects.toBeInstanceOf(ConfirmationRequired);
    await expect(call).rejects.toMatchObject({
      request: {
        message: 'Confirm E.pay with {"amount":5,"memo":"m"}?',
        requestedSchema: {
          type: "object",
          properties: { amount: expect.objectContaining({ type: "integer", default: 5 }) },
        },
      },
    });
    expect(sent).toEqual([]);
  });

  test("confirmed, the user's answers replace the agent's values for the asked parameters only", async () => {
    if (!tool) throw new Error("no E_pay");
    const { sent, service } = sending();
    await new Executor(elicit.spec).execute(tool, { amount: 5, memo: "m" }, service, user, {
      confirmed: true,
      confirmedArgs: { amount: 3, memo: "changed" },
    });
    expect(sent).toEqual([{ amount: 3, memo: "m" }]);
    // The answers are checked like the agent's arguments.
    await expect(
      new Executor(elicit.spec).execute(tool, { amount: 5 }, service, user, {
        confirmed: true,
        confirmedArgs: { amount: "lots" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
