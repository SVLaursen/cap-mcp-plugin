import { createMcpHandler } from "@modelcontextprotocol/server";
import { serverFactory } from "../../src/adapter";
import {
  RegisteredResources,
  type FixedResource,
  type ResourceContext,
  type TemplateResource,
} from "../../src/adapter/registered-resources";
import { McpApps } from "../../src/adapter/apps";
import { registryCache } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

/**
 * Resources from code (ADR 0013) in the adapter: what each caller gets, over the SDK without
 * CAP or HTTP. The demo's registrations are checked end to end in behaviour/.
 */

/** A model with tools but no resources of its own, so only registrations add resources. */
const PLAIN = `@mcp service S { entity Books { key ID : Integer; } }`;

interface Setup {
  roles?: string[];
  fixed?: FixedResource[];
  templates?: TemplateResource[];
  cdl?: string;
  locale?: string;
  tenant?: string;
  apps?: McpApps;
}

function serve(setup: Setup = {}) {
  const model = compileSnippet(setup.cdl ?? PLAIN);
  const roles = setup.roles ?? [];
  const user = { id: "someone", is: (role: string) => roles.includes(role) };
  const resources = new RegisteredResources();
  for (const r of setup.fixed ?? []) resources.register(r);
  for (const t of setup.templates ?? []) resources.registerTemplate(t);
  resources.close();
  const errors: unknown[][] = [];
  const factory = serverFactory({
    serverInfo: { name: "test", version: "0" },
    context: () => ({ user, locale: setup.locale, tenant: setup.tenant }),
    model: () => model,
    registryFor: registryCache(),
    resources,
    ...(setup.apps && { apps: setup.apps }),
    services: {},
    log: { error: (...args: unknown[]) => void errors.push(args) },
  });
  const handler = createMcpHandler(factory);
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "resources/read" && { "mcp-name": params.uri as string }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
            },
          },
        }),
      }),
    );
    return (await res.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string; data?: unknown };
    };
  };
  return { call, errors, user };
}

const note = (uri: string, overrides: Partial<FixedResource> = {}): FixedResource => ({
  uri,
  name: uri.split("/").at(-1) ?? uri,
  mimeType: "text/markdown",
  read: () => `text of ${uri}`,
  ...overrides,
});

const topics = (overrides: Partial<TemplateResource> = {}): TemplateResource => ({
  uriTemplate: "notes://x/topics/{+path}",
  name: "topics",
  mimeType: "text/markdown",
  read: ({ params }) => `topic ${params.path}`,
  ...overrides,
});

const capabilities = async (setup: Setup) =>
  (await serve(setup).call("server/discover")).result?.capabilities as Record<string, unknown>;

const listed = async (setup: Setup) =>
  ((await serve(setup).call("resources/list")).result?.resources as { uri: string }[]).map(
    (r) => r.uri,
  );

describe("mcp:resources: listing per caller (ADR 0013)", () => {
  test("without registrations, a model without resources has no resources capability", async () => {
    expect(await capabilities({})).not.toHaveProperty("resources");
  });

  test("a caller who sees no registered resource gets no resources capability", async () => {
    const hidden = note("notes://x/secret.md", { visible: () => false });
    expect(await capabilities({ fixed: [hidden] })).not.toHaveProperty("resources");
  });

  test("a visible resource or any template gives the capability, never listChanged", async () => {
    expect(await capabilities({ fixed: [note("notes://x/a.md")] })).toMatchObject({
      resources: { listChanged: false },
    });
    expect(await capabilities({ templates: [topics()] })).toMatchObject({
      resources: { listChanged: false },
    });
  });

  test("visible gets the caller's user, locale and tenant, and decides per caller", async () => {
    const seen: ResourceContext[] = [];
    const adminOnly = note("notes://x/admin.md", {
      visible: (ctx) => {
        seen.push(ctx);
        return (ctx.user as { is(role: string): boolean }).is("admin");
      },
    });
    const setup = { fixed: [note("notes://x/all.md"), adminOnly], locale: "de", tenant: "t1" };
    expect(await listed({ ...setup, roles: ["admin"] })).toEqual([
      "notes://x/admin.md",
      "notes://x/all.md",
    ]);
    expect(await listed(setup)).toEqual(["notes://x/all.md"]);
    expect(seen[0]).toMatchObject({ locale: "de", tenant: "t1", user: { id: "someone" } });
  });

  test("a visible that throws hides that resource and is logged; the rest is listed", async () => {
    const broken = note("notes://x/broken.md", {
      visible: () => {
        throw new Error("boom");
      },
    });
    const { call, errors } = serve({ fixed: [broken, note("notes://x/a.md")] });
    const res = await call("resources/list");
    expect((res.result?.resources as { uri: string }[]).map((r) => r.uri)).toEqual([
      "notes://x/a.md",
    ]);
    expect(errors).toEqual([[expect.stringContaining("notes://x/broken.md"), expect.any(Error)]]);
  });

  test("fixed resources are listed by URI with their metadata, then what templates list", async () => {
    const withList = topics({
      list: () => [{ uri: "notes://x/topics/b.md", name: "b", title: "B" }],
    });
    const { call } = serve({
      fixed: [
        note("notes://x/z.md"),
        note("notes://x/a.md", { title: "A", description: "The first" }),
      ],
      templates: [withList],
    });
    const res = await call("resources/list");
    expect(res.result?.resources).toEqual([
      {
        uri: "notes://x/a.md",
        name: "a.md",
        title: "A",
        description: "The first",
        mimeType: "text/markdown",
      },
      { uri: "notes://x/z.md", name: "z.md", mimeType: "text/markdown" },
      // A listed entry inherits the template's metadata unless it has its own.
      { uri: "notes://x/topics/b.md", name: "b", title: "B", mimeType: "text/markdown" },
    ]);
    expect(res.result).toMatchObject({ cacheScope: "private" });
  });

  test("a template whose list throws adds nothing, and the list still answers", async () => {
    const failing = topics({
      list: () => {
        throw new Error("index unavailable");
      },
    });
    const { call, errors } = serve({ fixed: [note("notes://x/a.md")], templates: [failing] });
    const res = await call("resources/list");
    expect(res.error).toBeUndefined();
    expect((res.result?.resources as { uri: string }[]).map((r) => r.uri)).toEqual([
      "notes://x/a.md",
    ]);
    expect(errors).toEqual([
      [expect.stringContaining("notes://x/topics/{+path}"), expect.any(Error)],
    ]);
  });

  test("templates are listed in resources/templates/list", async () => {
    const { call } = serve({ templates: [topics({ title: "Topics" })] });
    const res = await call("resources/templates/list");
    expect(res.result?.resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "notes://x/topics/{+path}",
        name: "topics",
        title: "Topics",
        mimeType: "text/markdown",
      }),
    ]);
  });
});

const inProduction = async <T>(fn: () => Promise<T>) => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = env;
  }
};

/** An error as a registering plugin would throw it. */
const thrown =
  (message: string, props: Record<string, unknown> = {}) =>
  () => {
    throw Object.assign(new Error(message), props);
  };

describe("mcp:resources: reading fixed resources (ADR 0013)", () => {
  test("read returns the text with the resource's MIME type, as the caller", async () => {
    const seen: ResourceContext[] = [];
    const resource = note("notes://x/a.md", {
      read: (ctx) => {
        seen.push(ctx);
        return Promise.resolve(`hello ${ctx.locale}`);
      },
    });
    const { call } = serve({ fixed: [resource], locale: "de", tenant: "t1" });
    const res = await call("resources/read", { uri: "notes://x/a.md" });
    expect(res.result?.contents).toEqual([
      { uri: "notes://x/a.md", mimeType: "text/markdown", text: "hello de" },
    ]);
    expect(seen).toEqual([
      { user: expect.objectContaining({ id: "someone" }), locale: "de", tenant: "t1" },
    ]);
  });

  test.each([
    ["status 404", { status: 404 }],
    ["statusCode 404", { statusCode: 404 }],
    ['code "NOT_FOUND"', { code: "NOT_FOUND" }],
  ])("an error with %s is resource-not-found, with the URI only", async (_what, props) => {
    const uri = "notes://x/gone.md";
    const { call, errors } = serve({
      fixed: [note(uri, { read: thrown("private detail", props) })],
    });
    const res = await call("resources/read", { uri });
    expect(res.error).toMatchObject({ code: -32602, data: { uri } });
    expect(JSON.stringify(res)).not.toMatch(/private detail/);
    expect(errors).toEqual([]);
  });

  test("any other error is logged and answered as Internal error, without its text", async () => {
    const uri = "notes://x/broken.md";
    const { call, errors } = serve({ fixed: [note(uri, { read: thrown("disk on fire") })] });
    const res = await inProduction(() => call("resources/read", { uri }));
    expect(res.error).toMatchObject({ code: -32603, message: "Internal error" });
    expect(JSON.stringify(res)).not.toMatch(/disk on fire/);
    expect(errors).toEqual([[expect.stringContaining(uri), expect.any(Error)]]);
  });

  test("a hidden resource answers exactly like an unknown URI", async () => {
    const hidden = note("notes://x/secret.md", { visible: () => false });
    const { call } = serve({ fixed: [hidden, note("notes://x/a.md")] });
    const secret = await call("resources/read", { uri: "notes://x/secret.md" });
    const unknown = await call("resources/read", { uri: "notes://x/nope.md" });
    const shape = (res: typeof secret, uri: string) =>
      JSON.stringify(res.error).replaceAll(uri, "<uri>");
    expect(secret.error).toBeDefined();
    expect(shape(secret, "notes://x/secret.md")).toBe(shape(unknown, "notes://x/nope.md"));
  });
});

describe("mcp:resources: templates (ADR 0013)", () => {
  const complete = (
    call: ReturnType<typeof serve>["call"],
    uri: string,
    name = "path",
    value = "",
  ) =>
    call("completion/complete", {
      ref: { type: "ref/resource", uri },
      argument: { name, value },
    });

  test("a matching URI is read with the template's params, as the caller", async () => {
    const seen: unknown[] = [];
    const template = topics({
      read: (ctx) => {
        seen.push(ctx);
        return `topic ${ctx.params.path}`;
      },
    });
    const { call } = serve({ templates: [template], locale: "en" });
    const uri = "notes://x/topics/gifts/wrapping.md";
    const res = await call("resources/read", { uri });
    expect(res.result?.contents).toEqual([
      { uri, mimeType: "text/markdown", text: "topic gifts/wrapping.md" },
    ]);
    expect(seen).toEqual([
      expect.objectContaining({ uri, params: { path: "gifts/wrapping.md" }, locale: "en" }),
    ]);
  });

  test("a 404 from a template's read is resource-not-found with the URI only", async () => {
    const template = topics({ read: thrown("no such topic here", { status: 404 }) });
    const { call } = serve({ templates: [template] });
    const uri = "notes://x/topics/nope.md";
    const res = await call("resources/read", { uri });
    expect(res.error).toMatchObject({ code: -32602, data: { uri } });
    expect(JSON.stringify(res)).not.toMatch(/no such topic here/);
  });

  test("a fixed URI wins over a template that matches it", async () => {
    const uri = "notes://x/topics/a.md";
    const { call } = serve({ fixed: [note(uri, { read: () => "fixed" })], templates: [topics()] });
    const res = await call("resources/read", { uri });
    expect(res.result?.contents).toEqual([{ uri, mimeType: "text/markdown", text: "fixed" }]);
  });

  test("a hidden fixed URI that a template matches is answered by the template's read", async () => {
    const uri = "notes://x/topics/a.md";
    const hidden = note(uri, { read: () => "fixed", visible: () => false });
    const template = topics({ read: thrown("hidden", { status: 404 }) });
    const { call } = serve({ fixed: [hidden], templates: [template] });
    const res = await call("resources/read", { uri });
    expect(res.error).toMatchObject({ code: -32602, data: { uri } });
  });

  test("complete answers completion/complete as the caller, at most 100 values with hasMore", async () => {
    const seen: unknown[] = [];
    const template = topics({
      complete: (ctx, param, value) => {
        seen.push([ctx, param, value]);
        return Array.from({ length: 101 }, (_, i) => `${value}${i}.md`);
      },
    });
    const { call } = serve({ templates: [template], locale: "de" });
    expect(await capabilities({ templates: [template] })).toHaveProperty("completions");
    const res = await complete(call, "notes://x/topics/{+path}", "path", "a");
    const completion = res.result?.completion as { values: string[]; hasMore: boolean };
    expect(completion.values).toHaveLength(100);
    expect(completion.values[0]).toBe("a0.md");
    expect(completion.hasMore).toBe(true);
    expect(seen).toEqual([[expect.objectContaining({ locale: "de" }), "path", "a"]]);
  });

  test("a template without complete offers nothing; one whose complete throws offers nothing and is logged", async () => {
    const plain = topics();
    const failing = topics({
      uriTemplate: "notes://x/other/{id}",
      name: "other",
      complete: thrown("index down"),
    });
    const { call, errors } = serve({ templates: [plain, failing] });
    for (const uri of ["notes://x/topics/{+path}", "notes://x/other/{id}"]) {
      const res = await complete(call, uri, uri.includes("other") ? "id" : "path");
      expect(res.result?.completion).toMatchObject({ values: [], hasMore: false });
    }
    expect(errors).toEqual([[expect.stringContaining("notes://x/other/{id}"), expect.any(Error)]]);
  });

  test("without complete anywhere there is no completions capability", async () => {
    expect(await capabilities({ templates: [topics()] })).not.toHaveProperty("completions");
    // A cap:// resource without @mcp.completion is no reason for it either.
    const cdl = `@mcp service S { @mcp.resource entity Genres { key ID : Integer; } }`;
    const caps = await capabilities({ cdl, templates: [topics()] });
    expect(caps).toHaveProperty("resources");
    expect(caps).not.toHaveProperty("completions");
  });

  test("a template named like a cap:// template in the model is skipped for that request, and logged", async () => {
    const cdl = `@mcp service S { @mcp.resource entity Books { key ID : Integer; } }`;
    const clashing = topics({ name: "S_Books" });
    const { call, errors } = serve({ cdl, templates: [clashing], fixed: [note("notes://x/a.md")] });
    const res = await call("resources/templates/list");
    expect(
      (res.result?.resourceTemplates as { uriTemplate: string }[]).map((t) => t.uriTemplate),
    ).toEqual(["cap://S/Books/{key}"]);
    expect(errors).toEqual([[expect.stringMatching(/notes:\/\/x\/topics\/\{\+path\}.*S_Books/)]]);
  });
});

describe("mcp:resources: review fixes (ADR 0013)", () => {
  test("a template named like a cap:// template is skipped for callers who cannot see that template too", async () => {
    const cdl = `@mcp @requires: 'admin' service S { @mcp.resource entity Books { key ID : Integer; } }`;
    const clashing = topics({ name: "S_Books" });
    const { call, errors } = serve({ cdl, templates: [clashing] });
    const res = await call("resources/templates/list");
    expect(res.result?.resourceTemplates ?? []).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("a clash and a throwing visible are logged once, not on every request", async () => {
    const cdl = `@mcp service S { @mcp.resource entity Books { key ID : Integer; } }`;
    const broken = note("notes://x/broken.md", {
      visible: () => {
        throw new Error("boom");
      },
    });
    const { call, errors } = serve({
      cdl,
      fixed: [broken],
      templates: [topics({ name: "S_Books" })],
    });
    await call("resources/list");
    await call("tools/list");
    expect(errors).toHaveLength(2);
  });

  test("a list that returns no array adds nothing; entries with reserved or no URIs are dropped", async () => {
    const odd = topics({ list: () => undefined as never });
    const sneaky = topics({
      uriTemplate: "notes://x/other/{id}",
      name: "other",
      list: () => [
        { uri: "cap://S/Books/1", name: "record" },
        { uri: "ui://x/app.html", name: "app" },
        { uri: 42 as never, name: "number" },
        { uri: "notes://x/other/1", name: "one" },
      ],
    });
    const { call, errors } = serve({ fixed: [note("notes://x/a.md")], templates: [odd, sneaky] });
    const res = await inProduction(() => call("resources/list"));
    expect((res.result?.resources as { uri: string }[]).map((r) => r.uri)).toEqual([
      "notes://x/a.md",
      "notes://x/other/1",
    ]);
    expect(errors).toEqual([[expect.stringContaining("notes://x/topics/{+path}"), undefined]]);
  });

  test("a read that returns no string is an Internal error", async () => {
    const uri = "notes://x/a.md";
    const { call, errors } = serve({ fixed: [note(uri, { read: () => undefined as never })] });
    const res = await inProduction(() => call("resources/read", { uri }));
    expect(res.error).toMatchObject({ code: -32603, message: "Internal error" });
    expect(errors).toHaveLength(1);
  });

  test("complete is asked only about the template's own variables", async () => {
    const complete = jest.fn(() => ["x"]);
    const { call } = serve({ templates: [topics({ complete })] });
    const res = await call("completion/complete", {
      ref: { type: "ref/resource", uri: "notes://x/topics/{+path}" },
      argument: { name: "other", value: "" },
    });
    expect(res.result?.completion).toMatchObject({ values: [], hasMore: false });
    expect(complete).not.toHaveBeenCalled();
  });

  test("template params arrive as sent, still percent-encoded", async () => {
    const seen: Record<string, string>[] = [];
    const template = topics({
      uriTemplate: "notes://x/item/{id}",
      name: "item",
      read: ({ params }) => {
        seen.push(params);
        return "x";
      },
    });
    const { call } = serve({ templates: [template] });
    await call("resources/read", { uri: "notes://x/item/a%2Fb" });
    expect(seen).toEqual([{ id: "a%2Fb" }]);
  });

  test("nothing a callback returns is cached across requests", async () => {
    let n = 0;
    const { call } = serve({ fixed: [note("notes://x/a.md", { read: () => `read ${++n}` })] });
    const text = async () =>
      (
        (await call("resources/read", { uri: "notes://x/a.md" })).result?.contents as {
          text: string;
        }[]
      )[0]?.text;
    expect(await text()).toBe("read 1");
    expect(await text()).toBe("read 2");
  });
});

describe("MCP App UIs in resources/list", () => {
  test("a UI several tools link to takes its name and title from the first by tool name", async () => {
    const apps = new McpApps();
    apps.register("ui://shop/card.html", () => "<p>card</p>");
    const { call } = serve({
      apps,
      cdl: `@mcp service S {
        entity Books { key ID : Integer; }
        @mcp.ui: 'ui://shop/card.html' @title: 'Zeta card' function zeta() returns Integer;
        @mcp.ui: 'ui://shop/card.html' @title: 'Alpha card' function alpha() returns Integer;
      }`,
    });
    const { result } = await call("resources/list");
    expect(result?.resources).toEqual([
      {
        uri: "ui://shop/card.html",
        name: "S_alpha",
        title: "Alpha card",
        mimeType: "text/html;profile=mcp-app",
      },
    ]);
  });
});
