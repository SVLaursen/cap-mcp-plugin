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
