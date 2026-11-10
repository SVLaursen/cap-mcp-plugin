/**
 * M3 — describe tools need no database: they describe the spec, as the caller can reach it.
 */
import cds from "@sap/cds";
import { Executor, errorResult, type ServiceLike, type ToolResult } from "../../src/executor";
import { ExposureRegistry } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

const source = `
  @mcp @mcp.describe @mcp.compact
  /** Shop for books */
  service Shop {
    /** Books on sale */
    entity Books { key ID: Integer; title: String(100) not null; @mcp.omit costPrice: Decimal; }
    @requires: 'admin' entity Secrets { key ID: Integer; }
    function stock(genre: Integer) returns Integer;
    @requires: 'admin' @mcp action wipe();
  }
  service Hidden { entity Internal { key ID: Integer; } }
`;

const registry = ExposureRegistry.fromModel(compileSnippet(source));
const executor = new Executor(registry.spec);
const noService = {} as ServiceLike; // describing never touches the service
const bob = new cds.User({ id: "bob", roles: [], attr: {} });
const alice = new cds.User({ id: "alice", roles: ["admin"], attr: {} });

/** As the adapter does: errors become tool results once the call is over. */
const settle = (call: Promise<ToolResult>) =>
  call.catch((error: unknown) => errorResult(error) ?? Promise.reject(error));

async function describe_(user: cds.User, name: string, args: Record<string, unknown> = {}) {
  const tool = registry.toolsFor(user).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not listed`);
  return settle(executor.execute(tool, args, noService, user));
}

describe("executor: compact call_operation", () => {
  test("only calls operations of its own service, and never @mcp.ui ones", async () => {
    const r = ExposureRegistry.fromModel(
      compileSnippet(`
        @mcp @mcp.compact service A {
          function count() returns Integer;
          @mcp.ui: 'ui://a/card.html' function card() returns Integer;
        }
        @mcp service B { function other() returns Integer; }
      `),
    );
    const tool = r.toolsFor(bob).find((t) => t.name === "A_call_operation");
    if (!tool) throw new Error("A_call_operation not listed");
    const ex = new Executor(r.spec);
    for (const operation of ["B.other", "A.card", "A.nope"]) {
      const result = await settle(ex.execute(tool, { operation }, noService, bob));
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({ code: "INVALID_ARGUMENT", target: "operation" }),
      });
    }
  });
});

describe("executor: describe tools", () => {
  test("<Service>_describe describes what the service exposes to this caller, and nothing else", async () => {
    const result = await describe_(bob, "Shop_describe");
    expect(result.structuredContent).toEqual({
      service: { name: "Shop", title: "Shop", description: "Shop for books" },
      entities: [
        {
          name: "Shop.Books",
          title: "Shop.Books",
          description: "Books on sale",
          keys: ["ID"],
          modes: ["get", "query"],
          fields: [
            { name: "ID", type: "Integer", key: true },
            { name: "title", type: "String", mandatory: true, length: 100 },
          ],
        },
      ],
      operations: [
        {
          name: "Shop.stock",
          title: "Shop.stock",
          kind: "function",
          params: [{ name: "genre", type: "Integer" }],
          returns: "Integer",
        },
      ],
    });
  });

  test("<Service>_describe for an admin also covers what only admins can reach", async () => {
    const result = (await describe_(alice, "Shop_describe")).structuredContent as {
      entities: { name: string }[];
      operations: { name: string }[];
    };
    expect(result.entities.map((e) => e.name)).toEqual(["Shop.Books", "Shop.Secrets"]);
    expect(result.operations.map((o) => o.name)).toEqual(["Shop.stock", "Shop.wipe"]);
  });

  test("describe with an entity describes just that one; one the caller cannot reach is unknown", async () => {
    const one = await describe_(bob, "Shop_describe", { entity: "Shop.Books" });
    expect((one.structuredContent as { entities: unknown[] }).entities).toHaveLength(1);
    const hidden = await describe_(bob, "Shop_describe_entity", { entity: "Shop.Secrets" });
    expect(hidden.structuredContent).toEqual({
      error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    });
  });

  test("compact list_entities and describe_entity follow the same view", async () => {
    const list = await describe_(bob, "Shop_list_entities");
    expect(list.structuredContent).toEqual({
      entities: [
        {
          name: "Shop.Books",
          title: "Shop.Books",
          description: "Books on sale",
          modes: ["get", "query"],
        },
      ],
    });
    const entity = await describe_(alice, "Shop_describe_entity", { entity: "Shop.Secrets" });
    expect(entity.structuredContent).toEqual(
      expect.objectContaining({ name: "Shop.Secrets", keys: ["ID"] }),
    );
  });
});
