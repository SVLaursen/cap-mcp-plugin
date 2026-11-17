import { createMcpHandler } from "@modelcontextprotocol/server";
import { serverFactory } from "../../src/adapter";
import {
  RegisteredResources,
  type FixedResource,
  type ResourceContext,
  type TemplateResource,
} from "../../src/adapter/registered-resources";
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
      expect.objectContaining({ uri: "notes://x/topics/b.md", name: "b", title: "B" }),
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
