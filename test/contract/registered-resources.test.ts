import {
  RegisteredResources,
  type FixedResource,
  type TemplateResource,
} from "../../src/adapter/registered-resources";

/** Resources from code: the `mcp:resources` registry and what it refuses (ADR 0013). */
describe("mcp:resources registry (ADR 0013)", () => {
  const fixed = (overrides: Partial<FixedResource> = {}): FixedResource => ({
    uri: "notes://shop/a.md",
    name: "a",
    mimeType: "text/markdown",
    read: () => "a",
    ...overrides,
  });
  const template = (overrides: Partial<TemplateResource> = {}): TemplateResource => ({
    uriTemplate: "notes://shop/topics/{+path}",
    name: "topics",
    mimeType: "text/markdown",
    read: () => "t",
    ...overrides,
  });

  test("it says which contract it implements", () => {
    expect(new RegisteredResources().contractVersion).toBe(1);
  });

  test("valid registrations are kept, fixed resources sorted by URI and templates by template", () => {
    const registry = new RegisteredResources();
    registry.register(fixed({ uri: "notes://shop/b.md", name: "b" }));
    registry.register(fixed({ uri: "notes://shop/a.md", name: "a", visible: () => true }));
    registry.registerTemplate(template({ uriTemplate: "notes://shop/z/{id}", name: "z" }));
    registry.registerTemplate(template());
    expect(registry.fixed().map((r) => r.uri)).toEqual(["notes://shop/a.md", "notes://shop/b.md"]);
    expect(registry.templates().map((t) => t.uriTemplate)).toEqual([
      "notes://shop/topics/{+path}",
      "notes://shop/z/{id}",
    ]);
  });

  test("fixed resources may share a name (MCP does not require unique names)", () => {
    const registry = new RegisteredResources();
    registry.register(fixed({ uri: "notes://shop/a.md", name: "note" }));
    registry.register(fixed({ uri: "notes://shop/b.md", name: "note" }));
    expect(registry.fixed()).toHaveLength(2);
  });

  test.each([
    ["not absolute", fixed({ uri: "a.md" }), /notes|absolute/],
    ["not canonical (a space)", fixed({ uri: "notes://shop/a b.md" }), /canonical/],
    ["the cap: scheme", fixed({ uri: "cap://Shop/Books/1" }), /cap:/],
    ["the ui: scheme", fixed({ uri: "ui://shop/a.html" }), /ui:/],
    ["the skill: scheme (ADR 0016)", fixed({ uri: "skill://shop/SKILL.md" }), /skill:/],
    ["an empty name", fixed({ name: "" }), /name/],
    ["no mimeType", fixed({ mimeType: undefined as unknown as string }), /mimeType/],
    ["read that is not a function", fixed({ read: "text" as never }), /read/],
    ["visible that is not a function", fixed({ visible: true as never }), /visible/],
  ])("register refuses %s", (_what, resource, message) => {
    const registry = new RegisteredResources();
    expect(() => registry.register(resource)).toThrow(/^cap-mcp: /);
    expect(() => registry.register(resource)).toThrow(message);
  });

  test("a duplicate URI throws and names it, instead of the last one winning", () => {
    const registry = new RegisteredResources();
    registry.register(fixed());
    expect(() => registry.register(fixed({ name: "other" }))).toThrow(
      "cap-mcp: notes://shop/a.md is already registered",
    );
  });

  test.each([
    ["no scheme", template({ uriTemplate: "topics/{+path}" }), /absolute/],
    ["the cap: scheme", template({ uriTemplate: "cap://Shop/Books/{key}" }), /cap:/],
    ["the ui: scheme", template({ uriTemplate: "ui://shop/{page}" }), /ui:/],
    ["the skill: scheme (ADR 0016)", template({ uriTemplate: "skill://{+path}" }), /skill:/],
    [
      "the Skills extension's template name (ADR 0016)",
      template({ name: "io.modelcontextprotocol/skills" }),
      /io\.modelcontextprotocol\/skills is reserved/,
    ],
    ["no variable", template({ uriTemplate: "notes://shop/topics" }), /variable/],
    [
      "an unclosed expression",
      template({ uriTemplate: "notes://x/{a}{" }),
      /not a valid URI template/,
    ],
    [
      "an empty variable",
      template({ uriTemplate: "notes://x/{+}" }),
      /not a valid URI template|no variable/,
    ],
    ["an upper-case scheme", template({ uriTemplate: "Notes://x/{id}" }), /canonical/],
    ["an upper-case host", template({ uriTemplate: "https://Example.com/{id}" }), /canonical/],
    ["a space", template({ uriTemplate: "notes://x/a b/{id}" }), /canonical/],
    ["an empty name", template({ name: "" }), /name/],
    ["an empty mimeType", template({ mimeType: "" }), /mimeType/],
    ["read that is not a function", template({ read: undefined as never }), /read/],
    ["list that is not a function", template({ list: [] as never }), /list/],
    ["complete that is not a function", template({ complete: {} as never }), /complete/],
  ])("registerTemplate refuses %s", (_what, entry, message) => {
    const registry = new RegisteredResources();
    expect(() => registry.registerTemplate(entry)).toThrow(/^cap-mcp: /);
    expect(() => registry.registerTemplate(entry)).toThrow(message);
  });

  test("a duplicate template, or a second template with the same name, throws", () => {
    const registry = new RegisteredResources();
    registry.registerTemplate(template());
    expect(() => registry.registerTemplate(template({ name: "other" }))).toThrow(
      "cap-mcp: notes://shop/topics/{+path} is already registered",
    );
    expect(() => registry.registerTemplate(template({ uriTemplate: "notes://x/{id}" }))).toThrow(
      /template named topics/,
    );
  });

  test("once closed (after the event), registering throws", () => {
    const registry = new RegisteredResources();
    registry.close();
    expect(() => registry.register(fixed())).toThrow(/after the mcp:resources event/);
    expect(() => registry.registerTemplate(template())).toThrow(/after the mcp:resources event/);
  });
});
