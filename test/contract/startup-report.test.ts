import { docCommentHint, exposureReport } from "../../src/cli/startup-report";
import { ExposureRegistry } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

/** M6 — startup exposure report (docs/annotations.md, Diagnostics). */
const registryOf = (cds: string) => ExposureRegistry.fromModel(compileSnippet(cds));

describe("startup exposure report", () => {
  test("first line counts everything the app exposes, for any user, at the endpoint path", () => {
    const registry = registryOf(`
      @mcp service S {
        @mcp.resource entity Books { key ID: Integer; }
        @requires: 'admin' entity Secrets { key ID: Integer; }
      }
      annotate S with @mcp.prompts: [{ name: 'p', template: 'hi' }];
    `);
    expect(exposureReport(registry, "/mcp")).toEqual([
      { level: "info", text: "serving 4 tools, 1 resource, 1 prompt at /mcp" },
    ]);
  });

  test("diagnostics follow (config first), errors first, each with its code and target", () => {
    const registry = registryOf(`
      @mcp service S {
        @mcp.hnit entity Books { key ID: Integer; }
        @mcp.wrap.modes: ['upsert'] entity Authors { key ID: Integer; }
      }
    `);
    const config = {
      level: "warn" as const,
      code: "UNKNOWN_CONFIG" as const,
      target: "cds.mcp.paht",
      message: "Unknown setting cds.mcp.paht; it has no effect",
    };
    expect(exposureReport(registry, "/ai", [config])).toEqual([
      { level: "info", text: "serving 4 tools, 0 resources, 0 prompts at /ai" },
      {
        level: "error",
        text: expect.stringMatching(/^INVALID_ANNOTATION_VALUE S\.Authors: .*upsert/),
      },
      {
        level: "warn",
        text: "UNKNOWN_CONFIG cds.mcp.paht: Unknown setting cds.mcp.paht; it has no effect",
      },
      {
        level: "warn",
        text: expect.stringMatching(/^UNKNOWN_ANNOTATION S\.Books: .*@mcp\.hnit/),
      },
    ]);
  });
});

describe("startup report: doc comments MCP cannot see (ADR 0011)", () => {
  const source = `
    /** The catalog */
    @mcp service S {
      /** Books on sale */
      entity Books { key ID: Integer; /** Its title */ title: String; }
      @description: 'Has its own' entity Authors { key ID: Integer; }
      /** Not exposed */
      action order();
    }
  `;
  const withoutDocs = ExposureRegistry.fromModel(compileSnippet(source, { docs: false }));

  test("names exposed definitions whose doc comment is lost, and how to turn docs on", () => {
    expect(docCommentHint(withoutDocs, compileSnippet(source))).toEqual({
      level: "info",
      text:
        "3 exposed definitions have doc comments that MCP does not see (S, S.Books, S.Books:title): " +
        'set "cdsc": { "docs": true } in the app\'s cds config to use them as descriptions ' +
        "(this also adds them to the OData $metadata, see ADR 0011)",
    });
  });

  test("says nothing when the served model has its doc comments", () => {
    const withDocs = ExposureRegistry.fromModel(compileSnippet(source));
    expect(docCommentHint(withDocs, compileSnippet(source))).toBeUndefined();
  });
});
