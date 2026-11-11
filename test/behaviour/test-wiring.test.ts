import cds from "@sap/cds";
import path from "node:path";
import { bootDemo } from "../helpers/demo";

/**
 * This repository's behaviour tests load the plugin from src/ (test/setup-env.js points CAP's
 * plugin list at test/cds-plugin-src.js). If that ever stopped working, CAP would quietly load
 * lib/ through cds-plugin.js and the tests would still pass, against a build.
 */
bootDemo();

test("CAP loads the plugin from test/cds-plugin-src.js, which loads src/", () => {
  const plugins = (cds.env as unknown as { plugins: Record<string, { impl?: string }> }).plugins;
  expect(plugins["@gavdi/cap-mcp"]?.impl).toBe(path.join(__dirname, "..", "cds-plugin-src.js"));
});
