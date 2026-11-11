import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_MIME_TYPE, McpApps, appMeta, loadAppFiles } from "../../src/adapter/apps";

/** ext-apps is ESM-only, so read its server constants in a child Node process (ADR 0012). */
function extAppsConstants(): { mime: string; metaKey: string } {
  const script =
    "import('@modelcontextprotocol/ext-apps/server').then(m => console.log(JSON.stringify(" +
    "{ mime: m.RESOURCE_MIME_TYPE, metaKey: m.RESOURCE_URI_META_KEY })))";
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

describe("MCP Apps (ADR 0012)", () => {
  let root: string;
  const warnings: string[] = [];
  const log = { warn: (...args: unknown[]) => void warnings.push(args.join(" ")) };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cap-mcp-apps-"));
    mkdirSync(path.join(root, "app", "mcp-apps", "cards"), { recursive: true });
    writeFileSync(path.join(root, "app", "mcp-apps", "cards", "book.html"), "<p>book</p>");
    writeFileSync(path.join(root, "secret.html"), "<p>secret</p>");
    warnings.length = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("our MIME type and tool _meta match what ext-apps' server helpers produce", () => {
    const { mime, metaKey } = extAppsConstants();
    expect(APP_MIME_TYPE).toBe(mime);
    expect(appMeta("ui://h/a.html")).toEqual({
      ui: { resourceUri: "ui://h/a.html" },
      [metaKey]: "ui://h/a.html",
    });
  });

  test("ui://<host>/<path> is read from app/mcp-apps/<path>", async () => {
    const apps = loadAppFiles(root, ["ui://shop/cards/book.html"], log);
    expect(await apps.content("ui://shop/cards/book.html")?.()).toBe("<p>book</p>");
    expect(warnings).toEqual([]);
  });

  test("a missing file, or a path outside app/mcp-apps, is a warning and has no content", () => {
    const apps = loadAppFiles(
      root,
      [
        "ui://shop/missing.html",
        "ui://shop/../../secret.html",
        "ui://shop/%2e%2e/%2e%2e/secret.html",
      ],
      log,
    );
    expect(apps.uris()).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/ui:\/\/shop\/missing\.html.*app\/mcp-apps\/missing\.html/);
  });

  test("a symlink under app/mcp-apps that points outside it is refused", () => {
    const link = path.join(root, "app", "mcp-apps", "link.html");
    symlinkSync(path.join(root, "secret.html"), link);
    const apps = loadAppFiles(root, ["ui://shop/link.html"], log);
    expect(apps.uris()).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/not a file under app\/mcp-apps/)]);
  });

  test("register adds or replaces a resource; only ui:// URIs are accepted", async () => {
    const apps = loadAppFiles(root, ["ui://shop/cards/book.html"], log);
    apps.register("ui://shop/cards/book.html", () => "<p>mine</p>");
    apps.register("ui://shop/chart.html", async () => "<p>chart</p>");
    expect(await apps.content("ui://shop/cards/book.html")?.()).toBe("<p>mine</p>");
    expect(apps.uris()).toEqual(["ui://shop/cards/book.html", "ui://shop/chart.html"]);
    expect(() => apps.register("https://x/y.html", () => "")).toThrow(/ui:\/\//);
  });

  test("a tool whose UI has no content loses its UI link and keeps the rest of its _meta", () => {
    const apps = new McpApps();
    apps.register("ui://h/a.html", () => "a");
    const meta = { ...appMeta("ui://h/b.html"), other: 1 };
    expect(apps.linkedMeta(appMeta("ui://h/a.html"))).toEqual(appMeta("ui://h/a.html"));
    expect(apps.linkedMeta(meta)).toEqual({ other: 1 });
    expect(apps.linkedMeta(undefined)).toBeUndefined();
  });
});
