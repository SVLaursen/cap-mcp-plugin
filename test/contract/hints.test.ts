import { createMcpHandler } from "@modelcontextprotocol/server";
import { serverFactory } from "../../src/adapter";
import {
  RegisteredHints,
  setUpHints,
  type HintContext,
  type InstructionsProvider,
  type ToolNotesProvider,
  type ToolTarget,
} from "../../src/adapter/hints";
import { registryCache } from "../../src/exposure-registry";
import {
  SkillsExtension,
  memorySkillFiles,
  type SkillCatalog,
} from "@modelcontextprotocol/server/ext/skills";
import { compileSnippet } from "../helpers/snippet";

/** Hints from code (ADR 0014): the `mcp:hints` registry, and what the adapter does with it. */

describe("mcp:hints registry (ADR 0014)", () => {
  const instructions = (id = "a"): InstructionsProvider => ({ id, text: () => "x" });
  const notes = (id = "a"): ToolNotesProvider => ({ id, note: () => "x" });

  test("it says which contract it implements", () => {
    expect(new RegisteredHints().contractVersion).toBe(1);
  });

  test("a duplicate id throws, per kind; the same id may serve both kinds", () => {
    const hints = new RegisteredHints();
    hints.addInstructions(instructions("okf"));
    hints.addToolNotes(notes("okf"));
    expect(() => hints.addInstructions(instructions("okf"))).toThrow(
      "cap-mcp: an instructions provider with id okf is already registered",
    );
    expect(() => hints.addToolNotes(notes("okf"))).toThrow(
      "cap-mcp: a tool notes provider with id okf is already registered",
    );
  });

  test.each([
    ["an empty id", () => new RegisteredHints().addInstructions({ id: "", text: () => "" }), /id/],
    [
      "text that is not a function",
      () => new RegisteredHints().addInstructions({ id: "a", text: "x" as never }),
      /text of a must be a function/,
    ],
    [
      "note that is not a function",
      () => new RegisteredHints().addToolNotes({ id: "a", note: undefined as never }),
      /note of a must be a function/,
    ],
  ])("it refuses %s", (_what, register, message) => {
    expect(register).toThrow(/^cap-mcp: /);
    expect(register).toThrow(message);
  });

  test("listeners get the registry's two methods only, not the plugin's own side", () => {
    let given: object | undefined;
    setUpHints((hints) => {
      given = hints;
    });
    expect(Object.keys(given ?? {}).sort()).toEqual([
      "addInstructions",
      "addToolNotes",
      "contractVersion",
    ]);
    expect(Object.isFrozen(given)).toBe(true);
  });

  test("after the event, both methods throw", () => {
    let registry: RegisteredHints | undefined;
    setUpHints((hints) => {
      hints.addInstructions(instructions());
      registry = hints as RegisteredHints;
    });
    expect(() => registry?.addInstructions(instructions("b"))).toThrow(/after the mcp:hints event/);
    expect(() => registry?.addToolNotes(notes("b"))).toThrow(/after the mcp:hints event/);
  });

  test("a listener that throws fails startup, and the registry is closed anyway", () => {
    let registry: RegisteredHints | undefined;
    expect(() =>
      setUpHints((hints) => {
        registry = hints as RegisteredHints;
        hints.addInstructions(instructions());
        hints.addInstructions(instructions());
      }),
    ).toThrow(/already registered/);
    expect(() => registry?.addToolNotes(notes())).toThrow(/after the mcp:hints event/);
  });
});

/**
 * A model with entities, a bound and an unbound action, a function, an entity only admins
 * reach, a describe tool and a compact service.
 */
const CDL = `
  @mcp service Shop {
    entity Books { key ID : Integer; title : String; } actions {
      @mcp action reserve() returns String;
    }
    @requires: 'admin' entity Secrets { key ID : Integer; }
    @mcp action order(book : Integer) returns String;
    function stock(book : Integer) returns Integer;
  }
  @mcp @mcp.describe service Admin { entity Authors { key ID : Integer; } }
  @mcp @mcp.compact service Back { entity Stock { key ID : Integer; } }
`;

interface Setup {
  instructions?: InstructionsProvider[];
  notes?: ToolNotesProvider[];
  /** Without a registry at all, as before ADR 0014. */
  noRegistry?: boolean;
  base?: string;
  locale?: string;
  tenant?: string;
  /** Skills served (ADR 0016), for the hint context (ADR 0017). */
  skills?: SkillCatalog;
}

function serve(setup: Setup = {}) {
  const model = compileSnippet(CDL);
  const user = { id: "someone", is: () => false };
  const hints = new RegisteredHints();
  for (const p of setup.instructions ?? []) hints.addInstructions(p);
  for (const p of setup.notes ?? []) hints.addToolNotes(p);
  hints.close();
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const factory = serverFactory({
    serverInfo: { name: "test", version: "0" },
    ...(setup.base !== undefined && { instructions: setup.base }),
    context: () => ({ user, locale: setup.locale, tenant: setup.tenant }),
    model: () => model,
    registryFor: registryCache(),
    ...(!setup.noRegistry && { hints }),
    ...(setup.skills && { skills: setup.skills }),
    services: {},
    log: {
      error: (...args: unknown[]) => void errors.push(args),
      warn: (...args: unknown[]) => void warnings.push(args),
    },
  });
  const handler = createMcpHandler(factory);
  const call = async (method: string) => {
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
            },
          },
        }),
      }),
    );
    return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  };
  const instructionsText = async () => (await call("server/discover")).result?.instructions;
  const tools = async () =>
    (await call("tools/list")).result?.tools as { name: string; description: string }[];
  return { call, instructionsText, tools, errors, warnings, user };
}

const fails = (message: string) => () => {
  throw new Error(message);
};

describe("mcp:hints: server instructions", () => {
  test("provider texts follow the app's own instructions, a blank line apart, in registration order", async () => {
    const { instructionsText } = serve({
      base: "Bookshop data.",
      instructions: [
        { id: "first", text: () => "  First hint.\n" },
        { id: "empty", text: () => "   " },
        { id: "none", text: () => undefined },
        { id: "second", text: async () => "Second hint." },
      ],
    });
    expect(await instructionsText()).toBe("Bookshop data.\n\nFirst hint.\n\nSecond hint.");
  });

  test("without instructions of its own, the server has only the providers' texts", async () => {
    const { instructionsText } = serve({ instructions: [{ id: "a", text: () => "Only this." }] });
    expect(await instructionsText()).toBe("Only this.");
  });

  test("providers that add nothing leave the app's instructions as they are", async () => {
    const { instructionsText } = serve({
      base: "Bookshop data.\n",
      instructions: [{ id: "a", text: () => undefined }],
    });
    expect(await instructionsText()).toBe("Bookshop data.\n");
  });

  test("a text over 1,500 characters is cut there, with one warning per provider", async () => {
    const { instructionsText, warnings } = serve({
      instructions: [{ id: "long", text: () => "x".repeat(2000) }],
    });
    expect(await instructionsText()).toBe("x".repeat(1500));
    await instructionsText();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toMatch(/long.*1500/);
  });

  test("a provider that throws or rejects is skipped and logged; its message never reaches the client", async () => {
    const { call, errors } = serve({
      base: "Bookshop data.",
      instructions: [
        { id: "bad", text: fails("secret-db-password") },
        { id: "worse", text: () => Promise.reject(new Error("secret-token")) },
        { id: "good", text: () => "Good hint." },
      ],
    });
    const res = await call("server/discover");
    expect(res.result?.instructions).toBe("Bookshop data.\n\nGood hint.");
    expect(JSON.stringify(res)).not.toMatch(/secret/);
    expect(errors.map((e) => String(e[0]))).toEqual([
      expect.stringMatching(/instructions provider bad failed/),
      expect.stringMatching(/instructions provider worse failed/),
    ]);
  });

  test("a provider that returns something other than text is skipped and logged", async () => {
    const { instructionsText, errors } = serve({
      instructions: [{ id: "odd", text: () => 42 as never }],
    });
    expect(await instructionsText()).toBeUndefined();
    expect(String(errors[0]?.[0])).toMatch(/odd/);
  });
});

describe("mcp:hints: tool notes", () => {
  const only = (tool: string, text: string) => (t: ToolTarget) =>
    t.tool === tool ? text : undefined;

  test("a note ends that tool's description, as its own paragraph, and no other tool's", async () => {
    const before = await serve().tools();
    const { tools } = serve({
      notes: [{ id: "a", note: only("Shop_Books_query", "See the catalog guide.") }],
    });
    const after = await tools();
    const original = before.find((t) => t.name === "Shop_Books_query")?.description;
    expect(after.find((t) => t.name === "Shop_Books_query")?.description).toBe(
      `${original}\n\nSee the catalog guide.`,
    );
    const others = (list: typeof before) =>
      list.filter((t) => t.name !== "Shop_Books_query").map((t) => [t.name, t.description]);
    expect(others(after)).toEqual(others(before));
  });

  test("several providers add their notes in registration order; empty and undefined add nothing", async () => {
    const before = await serve().tools();
    const { tools } = serve({
      notes: [
        { id: "a", note: () => " First. " },
        { id: "b", note: () => "" },
        { id: "c", note: async () => "Second." },
      ],
    });
    const original = before.find((t) => t.name === "Shop_order")?.description;
    expect((await tools()).find((t) => t.name === "Shop_order")?.description).toBe(
      `${original}\n\nFirst.\n\nSecond.`,
    );
  });

  test("each generated tool is described to the provider by name, service, definition and kind", async () => {
    const seen: ToolTarget[] = [];
    const { tools } = serve({ notes: [{ id: "a", note: (t) => void seen.push(t) }] });
    const listed = await tools();
    const byTool = (name: string) => seen.find((t) => t.tool === name);
    expect(byTool("Shop_Books_query")).toEqual({
      tool: "Shop_Books_query",
      service: "Shop",
      definition: "Shop.Books",
      kind: "entity",
    });
    expect(byTool("Admin_Authors_get")).toMatchObject({
      service: "Admin",
      definition: "Admin.Authors",
    });
    expect(byTool("Shop_order")).toEqual({
      tool: "Shop_order",
      service: "Shop",
      definition: "Shop.order",
      kind: "action",
    });
    expect(byTool("Shop_stock")).toMatchObject({ definition: "Shop.stock", kind: "function" });
    expect(byTool("Shop_Books_reserve")).toEqual({
      tool: "Shop_Books_reserve",
      service: "Shop",
      definition: "Shop.Books.reserve",
      kind: "action",
    });
    // Once per generated tool, per request. Describe and compact tools act on a whole service
    // and have no definition behind them.
    const wholeService = (name: string) => name === "Admin_describe" || name.startsWith("Back_");
    expect(seen.map((t) => t.tool).sort()).toEqual(
      listed
        .map((t) => t.name)
        .filter((name) => !wholeService(name))
        .sort(),
    );
    expect(listed.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Admin_describe", "Back_query", "Back_get"]),
    );
  });

  test("providers are never asked about tools the caller cannot reach", async () => {
    const seen: ToolTarget[] = [];
    const { tools } = serve({ notes: [{ id: "a", note: (t) => void seen.push(t) }] });
    await tools();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((t) => t.definition === "Shop.Secrets")).toEqual([]);
  });

  test("a note that is not text, or a provider that rejects, is logged and adds nothing", async () => {
    const before = await serve().tools();
    const { tools, errors } = serve({
      notes: [
        { id: "odd", note: () => 42 as never },
        { id: "worse", note: () => Promise.reject(new Error("secret-token")) },
      ],
    });
    expect((await tools()).map((t) => t.description)).toEqual(before.map((t) => t.description));
    expect(errors.map((e) => String(e[0])).sort()).toEqual([
      expect.stringMatching(/tool notes provider odd returned number/),
      expect.stringMatching(/tool notes provider worse failed/),
    ]);
  });

  test("a note over 400 characters is cut there, with one warning", async () => {
    const { tools, warnings } = serve({ notes: [{ id: "long", note: () => "y".repeat(500) }] });
    const listed = await tools();
    expect(listed[0]?.description.endsWith(`\n\n${"y".repeat(400)}`)).toBe(true);
    await tools();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toMatch(/long.*400/);
  });

  test("a note is plain text, passed on as it is", async () => {
    const text = "<b>Use</b> `okf://x` & **this**";
    const { tools } = serve({ notes: [{ id: "a", note: () => text }] });
    expect((await tools())[0]?.description.endsWith(`\n\n${text}`)).toBe(true);
  });

  test("a provider that throws is skipped for the request and logged; its message never reaches the client", async () => {
    const before = await serve().tools();
    const { call, errors } = serve({
      notes: [
        { id: "bad", note: fails("secret-db-password") },
        { id: "good", note: only("Shop_order", "Good.") },
      ],
    });
    const res = await call("tools/list");
    expect(JSON.stringify(res)).not.toMatch(/secret/);
    const listed = res.result?.tools as { name: string; description: string }[];
    const original = before.find((t) => t.name === "Shop_order")?.description;
    expect(listed.find((t) => t.name === "Shop_order")?.description).toBe(`${original}\n\nGood.`);
    // Once per provider and request, not once per tool.
    expect(errors.map((e) => String(e[0]))).toEqual([
      expect.stringMatching(/tool notes provider bad failed/),
    ]);
    await call("tools/list");
    expect(errors).toHaveLength(2);
  });
});

describe("mcp:hints: the caller", () => {
  test("providers get the request's user, tenant and locale", async () => {
    const seen: HintContext[] = [];
    const { call, user } = serve({
      locale: "de",
      tenant: "t1",
      instructions: [{ id: "a", text: (ctx) => void seen.push(ctx) }],
      notes: [{ id: "b", note: (_t, ctx) => void seen.push(ctx) }],
    });
    await call("tools/list");
    expect(seen.length).toBeGreaterThan(1);
    for (const ctx of seen) expect(ctx).toEqual({ user, tenant: "t1", locale: "de", skills: [] });
  });

  test("providers are asked again on every request, never cached", async () => {
    let n = 0;
    const { instructionsText } = serve({ instructions: [{ id: "a", text: () => `Call ${++n}.` }] });
    expect(await instructionsText()).toBe("Call 1.");
    expect(await instructionsText()).toBe("Call 2.");
  });
});

describe("mcp:hints: nothing registered", () => {
  test("providers that add nothing change nothing: server/discover and tools/list as without the registry", async () => {
    for (const base of [undefined, "Bookshop data.\n"]) {
      const without = serve({ noRegistry: true, base });
      const silent = serve({
        base,
        instructions: [{ id: "a", text: () => undefined }],
        notes: [{ id: "b", note: () => undefined }],
      });
      for (const method of ["server/discover", "tools/list"]) {
        expect(JSON.stringify(await silent.call(method))).toBe(
          JSON.stringify(await without.call(method)),
        );
      }
    }
  });

  test("server/discover and tools/list are what they were without the registry", async () => {
    for (const base of [undefined, "Bookshop data.\n"]) {
      const without = serve({ noRegistry: true, base });
      const empty = serve({ base });
      for (const method of ["server/discover", "tools/list"]) {
        expect(JSON.stringify(await empty.call(method))).toBe(
          JSON.stringify(await without.call(method)),
        );
      }
    }
  });
});

describe("mcp:hints: the skills served (ADR 0017)", () => {
  const skill = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  const catalog = () =>
    SkillsExtension.load(
      memorySkillFiles({
        "restock/SKILL.md": skill("restock", "Plan a restock."),
        "handle-return/SKILL.md": skill("handle-return", "Handle a return."),
        "handle-return/references/checklist.md": "# Checklist\n",
      }),
    );

  // The order is the SDK catalog's (sorted by URI); this pins it, our code does not sort.
  test("every provider sees the served skills by URI, name and description, in catalog order", async () => {
    const seen: HintContext[] = [];
    const { call } = serve({
      skills: await catalog(),
      instructions: [{ id: "a", text: (ctx) => void seen.push(ctx) }],
      notes: [{ id: "b", note: (_t, ctx) => void seen.push(ctx) }],
    });
    await call("tools/list");
    expect(seen.length).toBeGreaterThan(1);
    for (const ctx of seen)
      expect(ctx.skills).toEqual([
        {
          uri: "skill://handle-return/SKILL.md",
          name: "handle-return",
          description: "Handle a return.",
        },
        { uri: "skill://restock/SKILL.md", name: "restock", description: "Plan a restock." },
      ]);
  });

  test("the list is frozen and the same on every request: one catalog for every caller", async () => {
    const seen: HintContext[] = [];
    const { call } = serve({
      skills: await catalog(),
      instructions: [{ id: "a", text: (ctx) => void seen.push(ctx) }],
    });
    await call("server/discover");
    await call("server/discover");
    expect(seen[0]?.skills).toBe(seen[1]?.skills);
    expect(Object.isFrozen(seen[0]?.skills)).toBe(true);
    expect(Object.isFrozen(seen[0]?.skills[0])).toBe(true);
  });

  test("a provider can point agents at a skill in its instructions and tool notes", async () => {
    const before = await serve().tools();
    const { instructionsText, tools } = serve({
      skills: await catalog(),
      instructions: [
        {
          id: "okf",
          text: ({ skills }) =>
            skills.some((s) => s.name === "handle-return")
              ? "For returns, load the handle-return skill."
              : undefined,
        },
      ],
      notes: [
        {
          id: "okf",
          note: (t, { skills }) =>
            t.tool === "Shop_order" ? `Skill: ${skills[0]?.uri}` : undefined,
        },
      ],
    });
    expect(await instructionsText()).toBe("For returns, load the handle-return skill.");
    const original = before.find((t) => t.name === "Shop_order")?.description;
    expect((await tools()).find((t) => t.name === "Shop_order")?.description).toBe(
      `${original}\n\nSkill: skill://handle-return/SKILL.md`,
    );
  });
});
