/**
 * M2 — exposure-registry: ExposureSpec → ToolSpec[], filtered per user.
 */
import cds from "@sap/cds";
import { ExposureRegistry, registryCache } from "../../src/exposure-registry";
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

/** A real cds.User (not a mock), for CAP's own role checks incl. pseudo roles. */
function capUser(id: string, ...roles: string[]): cds.User {
  return new cds.User({ id, roles, attr: {} });
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

  test("an @mcp.describe service adds one <Service>_describe tool scoped to that service only", () => {
    const tools = registry(`
      @mcp @mcp.describe service A { entity Books { key ID: Integer; } entity Authors { key ID: Integer; } }
      @mcp service B { entity Secrets { key ID: Integer; } }
    `).toolsFor(user());
    const describe = tools.find((t) => t.name === "A_describe");
    expect(describe).toEqual({
      name: "A_describe",
      title: "A: describe",
      description: expect.any(String),
      inputSchema: {
        type: "object",
        properties: { entity: { enum: ["A.Books", "A.Authors"] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      target: { kind: "describe", service: "A" },
    });
    expect(names(tools).filter((n) => n.endsWith("_describe"))).toEqual(["A_describe"]);
  });

  test("an @mcp.compact service publishes the generic tool set instead of per-entity tools", () => {
    const tools = registry(`
      @mcp @mcp.compact service C {
        @mcp.wrap.modes: ['create'] entity Books { key ID: Integer; title: String; }
        entity Log { message: String; }
        function count() returns Integer;
      }
    `).toolsFor(user());
    expect(names(tools)).toEqual([
      "C_call_operation",
      "C_create",
      "C_describe_entity",
      "C_get",
      "C_list_entities",
      "C_query",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.C_query?.target).toEqual({ kind: "compact", service: "C", action: "query" });
    // Each generic tool only offers the entities (or operations) it can act on.
    const prop = (name: string, key: string) =>
      (byName[name]?.inputSchema.properties as Record<string, unknown>)[key];
    expect(prop("C_query", "entity")).toEqual({ enum: ["C.Books", "C.Log"] });
    expect(prop("C_get", "entity")).toEqual({ enum: ["C.Books"] });
    expect(prop("C_create", "entity")).toEqual({ enum: ["C.Books"] });
    expect(prop("C_call_operation", "operation")).toEqual({ enum: ["C.count"] });
    // All operations are functions, so calling one is read-only.
    expect(byName.C_call_operation?.annotations.readOnlyHint).toBe(true);
    expect(byName.C_create?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  test("@mcp.ui operations carry the ui resource link in the tool's _meta", () => {
    const tools = registry(`
      @mcp service S {
        @mcp.ui: 'ui://shop/card.html' function card() returns Integer;
        function plain() returns Integer;
      }
      @mcp @mcp.compact service C {
        @mcp.ui: 'ui://shop/board.html' function board() returns Integer;
        function count() returns Integer;
      }
    `).toolsFor(user());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    // Both the current key and the deprecated flat one, as ext-apps' registerAppTool writes.
    expect(byName.S_card?._meta).toEqual({
      ui: { resourceUri: "ui://shop/card.html" },
      "ui/resourceUri": "ui://shop/card.html",
    });
    expect(byName.S_plain?._meta).toBeUndefined();
    // A host binds the UI to its own tool, so a compact service keeps @mcp.ui operations apart.
    expect(byName.C_board?._meta).toEqual(
      expect.objectContaining({ "ui/resourceUri": "ui://shop/board.html" }),
    );
    expect(byName.C_call_operation?.inputSchema.properties).toEqual(
      expect.objectContaining({ operation: { enum: ["C.count"] } }),
    );
  });
});

describe("exposure-registry: per-user filtering (advertising only; CAP enforces)", () => {
  test("tools of a service with @requires: 'admin' are hidden from a user without admin", () => {
    const r = registry(`
      @requires: 'admin' @mcp service Admin { entity Books { key ID: Integer; } }
      @mcp service Catalog { entity Books { key ID: Integer; } }
    `);
    expect(names(r.toolsFor(user()))).toEqual(["Catalog_Books_get", "Catalog_Books_query"]);
    expect(names(r.toolsFor(user("admin")))).toEqual([
      "Admin_Books_get",
      "Admin_Books_query",
      "Catalog_Books_get",
      "Catalog_Books_query",
    ]);
  });

  test("entity-level @requires hides that entity's tools", () => {
    const r = registry(`
      @mcp service S {
        @requires: ['support', 'admin'] entity Tickets { key ID: Integer; }
          actions { function age() returns Integer; }
        entity Books { key ID: Integer; }
        @requires: 'admin' function audit() returns Integer;
      }
    `);
    expect(names(r.toolsFor(user()))).toEqual(["S_Books_get", "S_Books_query"]);
    // Any one of the listed roles is enough, as in CAP.
    expect(names(r.toolsFor(user("support")))).toEqual([
      "S_Books_get",
      "S_Books_query",
      "S_Tickets_age",
      "S_Tickets_get",
      "S_Tickets_query",
    ]);
    expect(names(r.toolsFor(user("admin")))).toContain("S_audit");
  });

  test("a bound operation's own @requires replaces its entity's, as CAP checks it", () => {
    const r = registry(`
      @mcp service S {
        @requires: 'admin' entity Tickets { key ID: Integer; } actions {
          @requires: 'support' function age() returns Integer;
          function count() returns Integer;
        }
      }
    `);
    const support = capUser("carol", "support");
    const admin = capUser("alice", "admin");
    expect(names(r.toolsFor(support))).toEqual(["S_Tickets_age"]);
    expect(names(r.toolsFor(admin))).toEqual([
      "S_Tickets_count",
      "S_Tickets_get",
      "S_Tickets_query",
    ]);
  });

  test("CAP's pseudo roles work through a real cds.User", () => {
    const r = registry(`
      @mcp service S {
        @requires: 'authenticated-user' entity Mine { key ID: Integer; }
        @requires: 'any' entity Open { key ID: Integer; }
      }
    `);
    expect(names(r.toolsFor(cds.User.anonymous))).toEqual(["S_Open_get", "S_Open_query"]);
    expect(names(r.toolsFor(capUser("bob")))).toEqual([
      "S_Mine_get",
      "S_Mine_query",
      "S_Open_get",
      "S_Open_query",
    ]);
  });

  test("@restrict with only `where` conditions does NOT hide tools (CAP filters rows)", () => {
    const r = registry(`
      @mcp service S {
        @restrict: [{ grant: 'READ', to: 'authenticated-user', where: 'createdBy = $user' }]
        entity Orders { key ID: Integer; createdBy: String; }
      }
    `);
    expect(names(r.toolsFor(user()))).toEqual(["S_Orders_get", "S_Orders_query"]);
  });

  test("the same spec yields identical lists for users with identical roles", () => {
    const r = registry(`
      @requires: 'admin' @mcp service Admin { entity Books { key ID: Integer; } }
      @mcp service Catalog { entity Books { key ID: Integer; } }
    `);
    const alice = { id: "alice", is: (role: string) => role === "admin" };
    const ann = { id: "ann", is: (role: string) => role === "admin" };
    expect(r.toolsFor(alice)).toEqual(r.toolsFor(ann));
  });
});

describe("exposure-registry: caching", () => {
  const source = `@mcp service S { entity Books { key ID: Integer; } @mcp.foo entity X { key ID: Integer; } }`;

  test("tools are built once per model object, not per request", () => {
    const forModel = registryCache();
    const model = compileSnippet(source);
    const first = forModel(model);
    expect(forModel(model)).toBe(first);
    // Same tool objects on every request: nothing is rebuilt.
    const [a] = first.toolsFor(user());
    const [b] = forModel(model).toolsFor(user("admin"));
    expect(b).toBe(a);
  });

  test("a different (extended tenant) model object gets its own tool list", () => {
    const forModel = registryCache();
    const base = compileSnippet(source);
    const extended = compileSnippet(
      `${source} extend service S with { entity Notes { key ID: Integer; } }`,
    );
    expect(names(forModel(base).toolsFor(user()))).not.toContain("S_Notes_query");
    expect(names(forModel(extended).toolsFor(user()))).toContain("S_Notes_query");
    expect(forModel(extended)).not.toBe(forModel(base));
  });

  test("the registry reports the model reader's diagnostics as well as its own", () => {
    const r = registryCache()(compileSnippet(source));
    expect(r.diagnostics.map((d) => d.code)).toEqual(["UNKNOWN_ANNOTATION"]);
  });
});
