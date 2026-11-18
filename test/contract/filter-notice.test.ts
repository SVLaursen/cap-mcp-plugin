/**
 * ADR 0015 — tell the agent when its view is filtered. A read is filtered when every grant
 * that lets this user READ the entity has a `where` (CAP then adds the condition to the
 * query). Decided from the model and the user only; nothing is queried to find out.
 */
import cds from "@sap/cds";
import { readsFiltered } from "../../src/access";
import { readConfig } from "../../src/config";
import { Executor, errorResult, type ServiceLike } from "../../src/executor";
import { ExposureRegistry, type RegistryOptions } from "../../src/exposure-registry";
import { readModel } from "../../src/model-reader";
import type { EntitySpec, ToolSpec } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";
import { schemaError } from "../helpers/validate";

const source = `
  @mcp service S {
    @mcp.wrap.modes: ['create', 'update', 'delete']
    @restrict: [
      { grant: '*', to: 'authenticated-user', where: 'createdBy = $user' },
      { grant: 'READ', to: 'support' }
    ]
    entity Orders {
      key ID: Integer; createdBy: String;
      items: Composition of many Items on items.up_ = $self;
    } actions { @mcp action cancel(); }
    entity Items { key ID: Integer; up_: Association to Orders; }
    @restrict: [
      { grant: 'READ', to: 'support', where: 'createdBy = $user' },
      { grant: 'READ', to: 'admin' }
    ]
    entity Returns { key ID: Integer; createdBy: String; }
    @restrict: [{ grant: 'reopen', to: 'support', where: 'createdBy = $user' }]
    entity Tickets { key ID: Integer; createdBy: String; } actions { @mcp action reopen(); }
    entity Books { key ID: Integer; title: String; }
  }
`;

const csn = compileSnippet(source);
const make = (options: RegistryOptions = {}) => new ExposureRegistry(readModel(csn).spec, options);
const registry = make();
const entity = (name: string): EntitySpec => {
  const found = registry.spec.services[0]?.entities.find((e) => e.name === `S.${name}`);
  if (!found) throw new Error(`S.${name} is missing`);
  return found;
};

const properties = (tool: ToolSpec) =>
  (tool.outputSchema?.properties ?? {}) as Record<string, unknown>;

/** Real cds.Users, so CAP's pseudo roles (authenticated-user, any) work as at runtime. */
const bob = new cds.User({ id: "bob", roles: [], attr: {} });
const carol = new cds.User({ id: "carol", roles: ["support"], attr: {} });
const alice = new cds.User({ id: "alice", roles: ["admin"], attr: {} });

const NOTICE = (title: string) =>
  `Your authorization limits which ${title} records you can see. Records outside it are not ` +
  "included in this result. An empty or smaller result does not mean that no other records exist.";
const LINE = "Your access to these records is limited by authorization.";

describe("model-reader: which grants have a condition", () => {
  test("an entity's own grant with `where` is marked, without the condition itself", () => {
    expect(entity("Returns").restrict).toEqual([
      { grant: "READ", to: ["support"], where: true },
      { grant: "READ", to: ["admin"] },
    ]);
  });

  test("a composition child's inherited grants are not: CAP filters only the parent's path", () => {
    expect(entity("Items").restrict).toEqual([
      { grant: "*", to: ["authenticated-user"] },
      { grant: "READ", to: ["support"] },
    ]);
  });
});

describe("access: readsFiltered", () => {
  test.each([
    ["only a grant with where", bob, "Orders", true],
    ["a grant with where and one without", carol, "Orders", false],
    ["only a grant without where", alice, "Returns", false],
    ["only a grant with where (another entity)", carol, "Returns", true],
    ["no grant at all (the tool is hidden instead)", bob, "Returns", false],
    ["no restriction", bob, "Books", false],
    ["a composition child (CAP adds no condition)", bob, "Items", false],
    ["grants for bound operations only (CRUD stays open)", carol, "Tickets", false],
  ] as const)("%s", (_what, user, name, filtered) => {
    expect(readsFiltered(user, entity(name))).toBe(filtered);
  });
});

describe("registry: one line on the read tools of a filtered user", () => {
  const tool = (tools: ToolSpec[], name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} is missing`);
    return found;
  };

  test("the query and get tools say it; write and operation tools do not", () => {
    const plain = make().toolsFor(carol);
    const tools = registry.toolsFor(bob);
    for (const name of ["S_Orders_query", "S_Orders_get"]) {
      expect(tool(tools, name).description).toBe(`${tool(plain, name).description}\n\n${LINE}`);
    }
    for (const name of [
      "S_Orders_create",
      "S_Orders_update",
      "S_Orders_delete",
      "S_Orders_cancel",
    ]) {
      expect(tool(tools, name)).toEqual(tool(plain, name));
    }
  });

  test("the filtered query tool declares the optional notice in its output schema", () => {
    const query = tool(registry.toolsFor(bob), "S_Orders_query");
    expect(properties(query).notice).toEqual({ type: "string" });
    expect(query.outputSchema?.required).toEqual(["rows", "total"]);
  });

  test("users whose reads are not filtered get the tools exactly as before", () => {
    // Carol reads Orders unfiltered and Returns filtered; alice the other way round.
    const off = make({ filterNotices: false });
    for (const [user, filtered] of [
      [carol, "S_Returns_"],
      [alice, "S_Orders_"],
    ] as const) {
      const unfiltered = (tools: ToolSpec[]) =>
        JSON.stringify(tools.filter((t) => !t.name.startsWith(filtered)));
      expect(unfiltered(registry.toolsFor(user))).toBe(unfiltered(off.toolsFor(user)));
      expect(
        registry
          .toolsFor(user)
          .filter((t) => t.description?.includes(LINE))
          .map((t) => t.name),
      ).toEqual([`${filtered}get`, `${filtered}query`]);
    }
  });

  test("with filterNotices off, nobody's tools change", () => {
    const off = make({ filterNotices: false });
    for (const user of [bob, carol, alice]) {
      expect(off.toolsFor(user).some((t) => t.description?.includes(LINE))).toBe(false);
      expect(off.toolsFor(user).some((t) => properties(t).notice)).toBe(false);
    }
  });
});

describe("executor: the notice in results", () => {
  /** A stand-in for CAP that returns these rows (and their count) for any SELECT. */
  const rows = (found: Record<string, unknown>[]): ServiceLike => ({
    name: "S",
    run: async (q) =>
      (q as { SELECT: { one?: boolean } }).SELECT.one
        ? { total: found.length, ...found[0] }
        : found,
    send: async () => undefined,
  });
  const nothing: ServiceLike = { name: "S", run: async () => undefined, send: async () => {} };
  const call = (
    user: cds.User,
    name: string,
    args: Record<string, unknown>,
    service: ServiceLike,
    options: RegistryOptions = {},
  ) => {
    const r = make(options);
    const found = r.toolsFor(user).find((t) => t.name === name);
    if (!found) throw new Error(`${name} is missing`);
    return {
      tool: found,
      // As the adapter does: a tool error becomes an isError result after rollback.
      result: new Executor(r.spec, { filterNotices: r.filterNotices })
        .execute(found, args, service, user)
        .catch((error: unknown) => errorResult(error) ?? Promise.reject(error)),
    };
  };

  test.each([
    ["with rows", [{ ID: 1, createdBy: "bob" }]],
    ["empty", []],
  ])(
    "a filtered query result carries the notice first, %s, valid for its schema",
    async (_what, found) => {
      const { tool, result } = call(bob, "S_Orders_query", {}, rows(found));
      const { structuredContent, text } = await result;
      expect(Object.keys(structuredContent as object)[0]).toBe("notice");
      expect(structuredContent).toEqual({
        notice: NOTICE("S.Orders"),
        rows: found,
        total: found.length,
      });
      expect(text).toBe(JSON.stringify(structuredContent));
      expect(schemaError(tool.outputSchema!, structuredContent)).toBeUndefined();
    },
  );

  test("the notice names no condition, attribute, value or count", async () => {
    const { result } = call(bob, "S_Orders_query", {}, rows([{ ID: 1, createdBy: "bob" }]));
    const { notice } = (await result).structuredContent as { notice: string };
    for (const part of ["createdBy", "$user", "bob", "authenticated", "where", "1"]) {
      expect(notice).not.toContain(part);
    }
  });

  test("a filtered get that finds nothing says it may not be visible; a found record has no notice", async () => {
    const missing = await call(bob, "S_Orders_get", { ID: 7 }, nothing).result;
    expect(missing.structuredContent).toEqual({
      error: {
        code: "NOT_FOUND",
        message:
          'No S.Orders with {"ID":7}, or it is not visible to you: your authorization limits which S.Orders records you can see.',
      },
    });
    const found = await call(bob, "S_Orders_get", { ID: 1 }, rows([{ ID: 1, createdBy: "bob" }]))
      .result;
    expect(found.structuredContent).toEqual({ ID: 1, createdBy: "bob" });
  });

  test("unfiltered reads, and every read with filterNotices off, are as before", async () => {
    const one = [{ ID: 1, createdBy: "bob" }];
    for (const [user, name, options] of [
      [carol, "S_Orders_query", {}],
      [bob, "S_Books_query", {}],
      [bob, "S_Orders_query", { filterNotices: false }],
    ] as const) {
      expect(
        (await call(user, name, {}, rows(one), options).result).structuredContent,
      ).not.toHaveProperty("notice");
    }
    const missing = await call(bob, "S_Orders_get", { ID: 7 }, nothing, { filterNotices: false })
      .result;
    expect(missing.text).toBe('NOT_FOUND: No S.Orders with {"ID":7}');
  });
});

describe("configuration: cds.mcp.filterNotices", () => {
  test("false turns the notices off; it is a known key", () => {
    expect(readConfig({ filterNotices: false })).toEqual({
      config: { filterNotices: false },
      diagnostics: [],
    });
  });

  test("anything but a boolean is an error, and the default (on) is used", () => {
    const { config, diagnostics } = readConfig({ filterNotices: "no" });
    expect(config).toEqual({});
    expect(diagnostics.map((d) => [d.code, d.target, d.message])).toEqual([
      [
        "INVALID_CONFIG",
        "cds.mcp.filterNotices",
        "cds.mcp.filterNotices must be true or false; using the default",
      ],
    ]);
  });
});
