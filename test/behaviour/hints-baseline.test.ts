import { readFileSync } from "node:fs";
import path from "node:path";
import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { legacyInitialize, legacyRpc, rpc } from "../helpers/mcp";

/**
 * ADR 0014: hints that add nothing change nothing. The demo's `mcp:hints` providers add nothing
 * for bob, so what bob gets must be what the demo gave at the commit before `mcp:hints` existed
 * (51b3a6e), byte for byte. fixtures/no-hints-baseline.json was captured there, with these calls.
 * (With no providers registered at all, the adapter skips hints entirely: test/contract/hints.)
 */
const demo = bootDemo();
// Bob's Orders reads are filtered, so ADR 0015 (a later change) adds a line to two of his tools.
// That is not what this file is about: it compares with notices off. ADR 0015's own baseline is
// test/behaviour/filter-notice.test.ts.
const env = cds.env as unknown as { mcp?: Record<string, unknown> };
env.mcp = { ...env.mcp, filterNotices: false };

const baseline = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "no-hints-baseline.json"), "utf8"),
) as { bob: Record<string, unknown> };

test.each([
  ["initialize (2025-era)", "initialize", () => legacyInitialize(demo.POST, "bob")],
  ["server/discover", "discover", () => rpc(demo.POST, "bob", "server/discover")],
  ["tools/list", "tools", () => rpc(demo.POST, "bob", "tools/list")],
  ["tools/list (2025-era)", "legacyTools", () => legacyRpc(demo.POST, "bob", "tools/list")],
])("bob's %s is unchanged from before mcp:hints", async (_what, key, call) => {
  const res = await call();
  expect(JSON.stringify(res.message?.result)).toBe(JSON.stringify(baseline.bob[key]));
});
