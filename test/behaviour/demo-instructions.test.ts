/**
 * The demo ships with server instructions from a file (cds.env.mcp.instructions), as an app would.
 */
import { bootDemo } from "../helpers/demo";
import { rpc } from "../helpers/mcp";

const demo = bootDemo();

test("the demo's instructions file reaches clients in server/discover", async () => {
  const res = await rpc(demo.POST, "bob", "server/discover");
  expect(res.message?.result?.instructions).toMatch(/^Bookshop data over MCP\./);
});
