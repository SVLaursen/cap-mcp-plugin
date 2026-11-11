import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";

/**
 * M6 / ADR 0011 — an app that leaves cdsc.docs off loses its doc comments over MCP; the startup
 * report says which and how to turn it on. Here the demo runs as such an app.
 */
const log = cds.log("mcp");
const info: string[] = [];
jest.spyOn(log, "info").mockImplementation((...args: unknown[]) => void info.push(args.join(" ")));
// Read when cds.test loads the demo's env, so it wins over the demo's package.json.
process.env.CDS_CDSC_DOCS = "false";
afterAll(() => delete process.env.CDS_CDSC_DOCS);
bootDemo();

test("with cdsc.docs off, the startup report names definitions whose doc comments MCP lost", () => {
  expect(info).toContainEqual(
    expect.stringMatching(
      /^\d+ exposed definitions have doc comments that MCP does not see \(.*CatalogService\.Books[,)].*"docs": true/,
    ),
  );
});
