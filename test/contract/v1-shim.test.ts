import { readConfig } from "../../src/config";
import { readModel } from "../../src/model-reader";
import type { Diagnostic, ExposureSpec } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";

/**
 * M6 — v1 shim (docs/annotations.md, Migrating from v1). v1 annotations are explicit opt-ins,
 * so they map to their v2 equivalent, each with a V1_ANNOTATION warning saying what to write
 * instead. v1 config never switches anything on; what an app got from it (or from v1 defaults)
 * and no longer gets is a V1_DEFAULT_CHANGED warning.
 */
const v1Annotations = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.code === "V1_ANNOTATION");
const codes = (diagnostics: Diagnostic[]) =>
  v1Annotations(diagnostics).map(({ level, code, target }) => ({ level, code, target }));

function exposed(spec: ExposureSpec) {
  return Object.fromEntries(
    spec.services.map((s) => [
      s.name,
      {
        entities: Object.fromEntries(s.entities.map((e) => [e.name, [...e.modes].sort()])),
        operations: s.operations.map((o) => o.name),
      },
    ]),
  );
}

describe("v1 shim: annotations", () => {
  test("@mcp.wrap.tools and the list form of @mcp.resource expose the entity as @mcp would", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.wrap.tools @mcp.wrap.modes: ['query', 'get', 'create']
        entity Books { key ID: Integer; }
        @mcp.resource: ['filter', 'top'] entity Authors { key ID: Integer; }
        entity Hidden { key ID: Integer; }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(exposed(spec)).toEqual({
      S: {
        entities: { "S.Authors": ["get", "query"], "S.Books": ["create", "get", "query"] },
        operations: [],
      },
    });
    expect(spec.services[0]?.entities.find((e) => e.name === "S.Authors")?.resource).toBe(false);
    expect(codes(diagnostics)).toEqual([
      { level: "warn", code: "V1_ANNOTATION", target: "S.Books" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.Authors" },
    ]);
    expect(v1Annotations(diagnostics).map((d) => d.message)).toEqual([
      "@mcp.wrap.tools is v1: mapped to @mcp on S.Books. Write @mcp instead",
      "@mcp.resource with a list of query options is v1: mapped to @mcp on S.Authors (query and get tools). Write @mcp instead; in v2, @mcp.resource means single records by key",
    ]);
  });

  test("@mcp.tool exposes an action or function as @mcp would", () => {
    const csn = compileSnippet(`
      service S {
        entity Books { key ID: Integer; } actions { @mcp.tool action restock(); }
        @mcp.tool action order();
        @mcp.tool function price() returns Decimal;
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(exposed(spec)).toEqual({
      S: { entities: {}, operations: ["S.Books.restock", "S.order", "S.price"] },
    });
    expect(v1Annotations(diagnostics).map((d) => [d.code, d.target, d.message])).toEqual([
      [
        "V1_ANNOTATION",
        "S.Books.restock",
        "@mcp.tool is v1: mapped to @mcp on S.Books.restock. Write @mcp instead",
      ],
      [
        "V1_ANNOTATION",
        "S.order",
        "@mcp.tool is v1: mapped to @mcp on S.order. Write @mcp instead",
      ],
      [
        "V1_ANNOTATION",
        "S.price",
        "@mcp.tool is v1: mapped to @mcp on S.price. Write @mcp instead",
      ],
    ]);
  });

  test("@mcp.elicit 'input' asks for every parameter, as in v1", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.tool @mcp.elicit: ['input', 'confirm'] action order(book: Integer, quantity: Integer);
        @mcp.tool @mcp.elicit: ['input'] action ping();
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(spec.services[0]?.operations.map((o) => [o.name, o.elicit])).toEqual([
      ["S.order", ["book", "quantity", "confirm"]],
      ["S.ping", ["confirm"]],
    ]);
    expect(codes(diagnostics)).toEqual([
      { level: "warn", code: "V1_ANNOTATION", target: "S.order" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.ping" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.order" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.ping" },
    ]);
    expect(v1Annotations(diagnostics)[2]?.message).toBe(
      "@mcp.elicit 'input' is v1: mapped to the parameter names (book, quantity). List them instead",
    );
  });

  test("v1 tool hints and names are reported as v1 and ignored, not as unknown", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.wrap: { tools: true, name: 'books', hint: { get: 'One', query: 'Many' } }
        entity Books { key ID: Integer; }
        @mcp.wrap.hint: 'Authors' @mcp.wrap.tools entity Authors { key ID: Integer; }
      }
    `);
    const { diagnostics } = readModel(csn);
    expect(v1Annotations(diagnostics).map((d) => [d.code, d.target, d.message])).toEqual([
      [
        "V1_ANNOTATION",
        "S.Books",
        "@mcp.wrap.tools is v1: mapped to @mcp on S.Books. Write @mcp instead",
      ],
      [
        "V1_ANNOTATION",
        "S.Books",
        "@mcp.wrap.name is v1 and has no effect: tool names are <Service>_<Entity>_<mode>; use @mcp.name for the title",
      ],
      [
        "V1_ANNOTATION",
        "S.Books",
        "@mcp.wrap.hint.get is v1 and has no effect: use @mcp.description on the entity",
      ],
      [
        "V1_ANNOTATION",
        "S.Books",
        "@mcp.wrap.hint.query is v1 and has no effect: use @mcp.description on the entity",
      ],
      [
        "V1_ANNOTATION",
        "S.Authors",
        "@mcp.wrap.hint is v1 and has no effect: use @mcp.description on the entity",
      ],
      [
        "V1_ANNOTATION",
        "S.Authors",
        "@mcp.wrap.tools is v1: mapped to @mcp on S.Authors. Write @mcp instead",
      ],
    ]);
  });

  test("@mcp.wrap.tools: false and @mcp.tool: false expose nothing", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.wrap.tools: false entity Books { key ID: Integer; }
        @mcp.tool: false action order();
      }
    `);
    expect(readModel(csn).spec.services).toEqual([]);
  });
});

describe("v1 shim: defaults that changed", () => {
  test("a v1-wrapped entity without @mcp.wrap.modes no longer gets create and update (v1's default)", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.wrap.tools entity Books { key ID: Integer; }
        @mcp.wrap.tools @mcp.wrap.modes: ['query', 'get'] entity Authors { key ID: Integer; }
      }
    `);
    const { diagnostics } = readModel(csn, { v1: { describe: false } });
    expect(diagnostics.filter((d) => d.code === "V1_DEFAULT_CHANGED")).toEqual([
      {
        level: "warn",
        code: "V1_DEFAULT_CHANGED",
        target: "S.Books",
        message:
          "v1 also gave S.Books create, update tools (wrap_entity_modes); v2 gives query and get only. Add @mcp.wrap.modes: ['create', 'update'] to keep them",
      },
    ]);
  });

  test("a configured wrap_entity_modes is what v1 gave; read-only lists change nothing", () => {
    const csn = compileSnippet(`service S { @mcp.wrap.tools entity Books { key ID: Integer; } }`);
    const v1 = (modes: string[]) =>
      readModel(csn, { v1: { wrapEntityModes: modes, describe: false } }).diagnostics.filter(
        (d) => d.code === "V1_DEFAULT_CHANGED",
      );
    expect(v1(["query", "get"])).toEqual([]);
    expect(v1(["query", "delete"]).map((d) => d.message)).toEqual([
      "v1 also gave S.Books delete tools (wrap_entity_modes); v2 gives query and get only. Add @mcp.wrap.modes: ['delete'] to keep them",
    ]);
  });

  test("with wrap_entities_to_actions, an @mcp.resource: true entity v1 wrapped is not exposed in v2", () => {
    const csn = compileSnippet(`
      service S {
        @mcp.resource entity Books { key ID: Integer; }
        @mcp.resource @mcp.wrap.tools: false entity Authors { key ID: Integer; }
      }
    `);
    const { diagnostics } = readModel(csn, {
      v1: { wrapEntitiesToActions: true, describe: false },
    });
    expect(diagnostics.filter((d) => d.code === "V1_DEFAULT_CHANGED")).toEqual([
      {
        level: "warn",
        code: "V1_DEFAULT_CHANGED",
        target: "S.Books",
        message:
          "v1 gave S.Books query and get tools (wrap_entities_to_actions); v2 does not. Add @mcp to the entity to keep them",
      },
    ]);
  });

  test("an app with v1 annotations loses the describe tool v1 served by default", () => {
    const v1App = compileSnippet(`service S { @mcp.tool function ping() returns String; }`);
    const v2App = compileSnippet(`@mcp service S { function ping() returns String; }`);
    const describe = (csn: unknown, v1 = {}) =>
      readModel(csn, { v1 }).diagnostics.filter((d) => d.code === "V1_DEFAULT_CHANGED");
    expect(describe(v1App)).toEqual([
      {
        level: "warn",
        code: "V1_DEFAULT_CHANGED",
        target: "cds.mcp.enable_model_description",
        message:
          "v1 served the cap_describe_model tool by default; v2 does not. Add @mcp.describe to a service for a describe tool scoped to it",
      },
    ]);
    expect(describe(v1App, { describe: false })).toEqual([]);
    expect(describe(v2App)).toEqual([]);
  });
});

describe("v1 shim: config", () => {
  test("v1 config keys are reported with what replaces them, and never switch anything on", () => {
    const { config, v1, diagnostics } = readConfig({
      name: "shop",
      auth: "none",
      capabilities: { tools: { listChanged: true } },
      wrap_entities_to_actions: true,
      wrap_entity_modes: ["query", "get", "create"],
      enable_model_description: false,
    });
    expect(config).toEqual({ name: "shop" });
    expect(v1).toEqual({
      wrapEntitiesToActions: true,
      wrapEntityModes: ["query", "get", "create"],
      describe: false,
    });
    expect(diagnostics.map((d) => [d.level, d.code, d.target, d.message])).toEqual([
      [
        "warn",
        "V1_DEFAULT_CHANGED",
        "cds.mcp.auth",
        "cds.mcp.auth is v1 and ignored: /mcp uses the app's CAP authentication (cds.requires.auth; dummy or mocked for local use)",
      ],
      [
        "warn",
        "V1_DEFAULT_CHANGED",
        "cds.mcp.capabilities",
        "cds.mcp.capabilities is v1 and ignored: v2 lists never change while serving (listChanged: false)",
      ],
      [
        "warn",
        "V1_DEFAULT_CHANGED",
        "cds.mcp.wrap_entities_to_actions",
        "cds.mcp.wrap_entities_to_actions is v1 and ignored: use @mcp on the service or entity",
      ],
      [
        "warn",
        "V1_DEFAULT_CHANGED",
        "cds.mcp.wrap_entity_modes",
        "cds.mcp.wrap_entity_modes is v1 and ignored: writes need @mcp.wrap.modes on the entity",
      ],
      [
        "warn",
        "V1_DEFAULT_CHANGED",
        "cds.mcp.enable_model_description",
        "cds.mcp.enable_model_description is v1 and ignored: use @mcp.describe on a service",
      ],
    ]);
  });
});
