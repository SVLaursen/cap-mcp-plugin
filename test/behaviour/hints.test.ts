import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { legacyInitialize, listTools, rpc, type Caller } from "../helpers/mcp";

/**
 * Hints from code (ADR 0014) over /mcp: what demo/server.js adds through `mcp:hints`, as each
 * demo user gets it, plus test-only providers that show what a provider sees.
 */
type Hints = {
  addInstructions(p: { id: string; text(ctx: Record<string, unknown>): unknown }): void;
};
// Test-only, registered before the demo's own: who asks, as the provider sees it and as
// cds.context has it; and a provider that fails for alice.
(cds as unknown as { on(e: string, fn: (h: Hints) => void): void }).on("mcp:hints", (hints) => {
  hints.addInstructions({
    id: "test-caller",
    text: ({ user, locale, tenant }) => {
      const id = (user as { id: string }).id;
      if (id !== "alice") return undefined;
      const fromContext = cds.context?.user?.id;
      return `Caller ${id} (cds.context: ${fromContext}), locale ${locale}, tenant ${tenant ?? "none"}.`;
    },
  });
  hints.addInstructions({
    id: "test-failing",
    text: ({ user }) => {
      if ((user as { id: string }).id === "alice") throw new Error("secret-from-provider");
      return undefined;
    },
  });
});

const demo = bootDemo();

const FILE = "Bookshop data over MCP.";
const POLICY = "Shop policies are MCP resources.";
const NOTE =
  "A cancelled order that was delivered is a return: read notes://bookshop/returns-policy.md first.";

async function instructions(who: Caller, headers: Record<string, string> = {}) {
  const res = await rpc(demo.POST, who, "server/discover", {}, { headers });
  return res.message?.result?.instructions as string;
}

describe("mcp:hints: instructions", () => {
  test("support staff get the demo's policy hint after the app's own instructions, a blank line apart", async () => {
    const text = await instructions("carol");
    expect(text.startsWith(FILE)).toBe(true);
    expect(text).toMatch(new RegExp(`\\.\\n\\n${POLICY}`));
    expect(text.endsWith("returns or cancellations.")).toBe(true);
  });

  test("2025-era clients get the same instructions in initialize", async () => {
    const res = await legacyInitialize(demo.POST, "carol");
    expect(res.message?.result?.instructions).toBe(await instructions("carol"));
  });

  test("bob gets the app's instructions only", async () => {
    expect(await instructions("bob")).not.toMatch(POLICY);
  });

  test("a provider sees the request's user and locale, inside the request's cds.context", async () => {
    const text = await instructions("alice", { "accept-language": "de" });
    expect(text).toContain("Caller alice (cds.context: alice), locale de, tenant none.");
    // Registration order: the test provider was registered before the demo's.
    expect(text.indexOf("Caller alice")).toBeLessThan(text.indexOf(POLICY));
  });

  test("a provider that throws is skipped; its message never reaches the client", async () => {
    const res = await rpc(demo.POST, "alice", "server/discover");
    expect(res.message?.result?.instructions).toMatch(POLICY);
    expect(JSON.stringify(res.message)).not.toMatch(/secret/);
  });
});

describe("mcp:hints: tool notes", () => {
  const described = async (who: Caller) => {
    const res = await listTools(demo.POST, who);
    return res.message?.result?.tools as { name: string; description: string }[];
  };

  test("support staff see the note at the end of the cancel tool, and on no other tool", async () => {
    const [carol, bob] = [await described("carol"), await described("bob")];
    const noted = carol.filter((t) => t.description.includes(NOTE));
    expect(noted.map((t) => t.name)).toEqual(["OrdersService_Orders_cancel"]);
    const bobs = bob.find((t) => t.name === "OrdersService_Orders_cancel")?.description;
    expect(noted[0]?.description).toBe(`${bobs}\n\n${NOTE}`);
  });

  test("bob's tools carry no note", async () => {
    expect((await described("bob")).some((t) => t.description.includes(NOTE))).toBe(false);
  });
});
