/**
 * M2 — exposure-registry: ExposureSpec → ToolSpec[], filtered per user.
 */
import { ExposureRegistry } from "../../src/exposure-registry";
import { readModel } from "../../src/model-reader";
import type { ToolSpec, UserLike } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";

/** A user with exactly these roles. CAP's pseudo roles are not modelled here. */
function user(...roles: string[]): UserLike {
  return { id: roles.join("+") || "nobody", is: (role) => roles.includes(role) };
}

function registry(source: string): ExposureRegistry {
  return new ExposureRegistry(readModel(compileSnippet(source)).spec);
}

const names = (tools: ToolSpec[]) => tools.map((t) => t.name);

const shop = `
  @mcp service Shop {
    @mcp.wrap.modes: ['create', 'update', 'delete']
    entity Books { key ID: Integer; title: String; } actions {
      function price() returns Decimal;
      @mcp action reprice(by: Decimal);
    }
    entity Authors { key ID: Integer; }
    function count() returns Integer;
    @mcp action order(book: Integer);
  }
`;

describe("exposure-registry: tool list", () => {
  test("names follow <Service>_<Entity>_<mode> and <Service>_<operation>", () => {
    expect(names(registry(shop).toolsFor(user()))).toEqual([
      "Shop_Authors_get",
      "Shop_Authors_query",
      "Shop_Books_create",
      "Shop_Books_delete",
      "Shop_Books_get",
      "Shop_Books_price",
      "Shop_Books_query",
      "Shop_Books_reprice",
      "Shop_Books_update",
      "Shop_count",
      "Shop_order",
    ]);
  });

  test("order is deterministic (sorted by name) across calls and processes", () => {
    const tools = registry(shop).toolsFor(user());
    // Plain code-point order, independent of locale and of the model's declaration order.
    expect(names(tools)).toEqual([...names(tools)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(names(registry(shop).toolsFor(user()))).toEqual(names(tools));
  });

  test("functions get readOnlyHint; actions get destructiveHint; delete gets destructiveHint", () => {
    const hints = Object.fromEntries(
      registry(shop)
        .toolsFor(user())
        .map((t) => [t.name, t.annotations]),
    );
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    expect(hints).toEqual({
      Shop_Authors_get: read,
      Shop_Authors_query: read,
      Shop_Books_get: read,
      Shop_Books_query: read,
      Shop_Books_price: read,
      Shop_count: read,
      // Additive: a new record each time.
      Shop_Books_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      // Overwrites existing data, but repeating it changes nothing more.
      Shop_Books_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      Shop_Books_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      // An action can do anything its handler does.
      Shop_Books_reprice: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      Shop_order: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    });
  });

  test("each tool carries its schemas, a title, a description and a back-reference", () => {
    const tools = Object.fromEntries(
      registry(shop)
        .toolsFor(user())
        .map((t) => [t.name, t]),
    );
    expect(tools.Shop_Books_get).toEqual({
      name: "Shop_Books_get",
      title: "Shop.Books: get",
      description: expect.stringContaining("by key"),
      inputSchema: expect.objectContaining({ required: ["ID"] }),
      outputSchema: expect.objectContaining({ type: "object" }),
      annotations: expect.any(Object),
      target: { kind: "entity", entity: "Shop.Books", mode: "get" },
    });
    expect(tools.Shop_Books_reprice?.target).toEqual({
      kind: "operation",
      operation: "Shop.Books.reprice",
    });
    // Bound operations take their entity's keys.
    expect(tools.Shop_Books_reprice?.inputSchema).toEqual(
      expect.objectContaining({ required: ["ID"] }),
    );
    // Delete and actions without a return type have no output schema.
    expect(tools.Shop_Books_delete?.outputSchema).toBeUndefined();
    expect(tools.Shop_order?.outputSchema).toBeUndefined();
  });

  test("two tools that would share a name are both left out and reported as TOOL_NAME_CLASH", () => {
    const clash = registry(`
      @mcp service S {
        entity Books { key ID: Integer; } actions { function query() returns Integer; }
      }
    `);
    expect(names(clash.toolsFor(user()))).toEqual(["S_Books_get"]);
    expect(clash.diagnostics).toEqual([
      {
        level: "error",
        code: "TOOL_NAME_CLASH",
        target: "S_Books_query",
        message: expect.stringContaining("S.Books.query"),
      },
    ]);
  });

  test.todo(
    "an @mcp.describe service adds one <Service>_describe tool scoped to that service only",
  );
  test.todo("an @mcp.compact service publishes the generic tool set instead of per-entity tools");
  test.todo("@mcp.ui operations carry the ui resource link in the tool's _meta");
});

describe("exposure-registry: per-user filtering (advertising only; CAP enforces)", () => {
  test.todo("tools of a service with @requires: 'admin' are hidden from a user without admin");
  test.todo("entity-level @requires hides that entity's tools");
  test.todo("@restrict with only `where` conditions does NOT hide tools (CAP filters rows)");
  test.todo("the same spec yields identical lists for users with identical roles");
});

describe("exposure-registry: caching", () => {
  test.todo("tools are built once per model object, not per request");
  test.todo("a different (extended tenant) model object gets its own tool list");
});
