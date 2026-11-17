import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";

/**
 * M6 — the startup report goes to the `mcp` log once CAP has served the app. The report is the
 * plugin's output here, so this test reads the log (its content is pinned in contract/cli).
 */
const log = cds.log("mcp");
const lines: [string, string][] = [];
for (const level of ["info", "warn", "error"] as const) {
  jest.spyOn(log, level).mockImplementation((...args: unknown[]) => {
    lines.push([level, args.join(" ")]);
  });
}
bootDemo();

test("the plugin logs what it serves and every diagnostic when the app is served", () => {
  expect(lines[0]).toEqual([
    "info",
    expect.stringMatching(/^serving \d+ tools, 2 resources, 1 prompt at \/mcp$/),
  ]);
  // demo/server.js registers notes through mcp:resources (ADR 0013).
  expect(lines[1]).toEqual([
    "info",
    "from code (mcp:resources): 3 resources (notes://bookshop/missing.md, notes://bookshop/returns-policy.md, notes://bookshop/stock-policy.md), 1 resource template (notes://bookshop/topics/{+path})",
  ]);
  // The demo reads cleanly: nothing but the summary.
  expect(lines.filter(([level]) => level !== "info")).toEqual([]);
});
