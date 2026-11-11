import { exposureReport } from "../../src/cli";
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

  test("diagnostics follow, errors first, each with its code and target", () => {
    const registry = registryOf(`
      @mcp service S {
        @mcp.wrap.tools entity Books { key ID: Integer; }
        @mcp.wrap.modes: ['upsert'] entity Authors { key ID: Integer; }
      }
    `);
    expect(exposureReport(registry, "/ai")).toEqual([
      { level: "info", text: "serving 4 tools, 0 resources, 0 prompts at /ai" },
      {
        level: "error",
        text: expect.stringMatching(/^INVALID_ANNOTATION_VALUE S\.Authors: .*upsert/),
      },
      {
        level: "warn",
        text: expect.stringMatching(/^V1_ANNOTATION S\.Books: .*@mcp\.wrap\.tools/),
      },
    ]);
  });
});
