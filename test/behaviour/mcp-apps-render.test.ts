import { JSDOM } from "jsdom";
import { bootDemo } from "../helpers/demo";
import { rpc, type Caller } from "../helpers/mcp";

/**
 * The demo's MCP App pages render the tool result a host hands them. Each page is loaded in a
 * DOM with a fake host that speaks the MCP Apps bridge (ext-apps 2026-01-26): the page asks
 * `ui/initialize`, says `ui/notifications/initialized`, and the host then sends the tool's
 * arguments and its result, exactly as the demo's `/mcp` endpoint returned it.
 */
const demo = bootDemo();

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

const call = async (who: Caller, name: string, args: Record<string, unknown>) =>
  (await rpc(demo.POST, who, "tools/call", { name, arguments: args })).message?.result;

const html = async (who: Caller, uri: string) =>
  (
    (await rpc(demo.POST, who, "resources/read", { uri })).message?.result?.contents as {
      text: string;
    }[]
  )[0]!.text;

/** Loads the page, plays host, and resolves with its document once it reports its new size. */
async function render(page: string, args: Record<string, unknown>, result: unknown) {
  const { window } = new JSDOM(page, { runScripts: "dangerously" });
  // The page is top-level here, so its parent is its own window: that is where the host speaks from.
  const source = window as unknown as MessageEventSource;
  const host = (data: unknown) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source }));
  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the page never rendered; it sent: ${seen.join(", ") || "nothing"}`)),
      1000,
    );
    window.addEventListener("message", (event: MessageEvent<Message>) => {
      const { id, method } = event.data;
      if (method) seen.push(method);
      if (method === "ui/initialize") {
        host({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "test-host", version: "1.0.0" },
            hostCapabilities: {},
            hostContext: { theme: "light" },
          },
        });
      } else if (method === "ui/notifications/initialized") {
        host({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: args },
        });
        host({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
      } else if (method === "ui/notifications/size-changed" && seen.includes("ui/initialize")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  expect(seen.slice(0, 2)).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  const text = (selector: string) =>
    window.document.querySelector(selector)?.textContent?.trim() ?? "";
  return { document: window.document, text };
}

test("the book card shows the book from bookCard's result", async () => {
  const result = await call("bob", "CatalogService_bookCard", { book: 207 });
  const book = (result?.structuredContent as { value: Record<string, unknown> }).value;
  const { text } = await render(
    await html("bob", "ui://bookshop/book-card.html"),
    { book: 207 },
    result,
  );
  expect(text("#title")).toBe("Jane Eyre");
  expect(text("#author")).toBe(book.authorName);
  expect(text("#price")).toContain("12.34");
  expect(text("#stock")).toBe(String(book.stock));
  expect(text("#descr")).toBe(book.descr ?? "");
});

test("the book card shows a tool error instead of empty fields", async () => {
  const result = await call("bob", "CatalogService_bookCard", { book: 999 });
  expect(result?.isError).toBe(true);
  const { document, text } = await render(
    await html("bob", "ui://bookshop/book-card.html"),
    { book: 999 },
    result,
  );
  expect(text("#error")).toBe("No book with this ID");
  expect(document.getElementById("book")?.hidden).toBe(true);
});

test("the stock chart (registered from code) shows the genre and its stock", async () => {
  const result = await call("bob", "CatalogService_stockByGenre", { genre: 11 });
  const stock = (result?.structuredContent as { value: number }).value;
  expect(stock).toBeGreaterThan(0); // Drama has books in the demo data
  const { text } = await render(
    await html("bob", "ui://bookshop/stock-chart.html"),
    { genre: 11 },
    result,
  );
  expect(text("#genre")).toBe("11");
  expect(text("#stock")).toBe(String(stock));
});

test("the stock report lists each book under the threshold", async () => {
  const result = await call("alice", "AdminService_stockReport", { threshold: 20 });
  const books = (result?.structuredContent as { value: { title: string; stock: number }[] }).value;
  expect(books.length).toBeGreaterThan(0);
  const { document } = await render(
    await html("alice", "ui://bookshop/stock-report.html"),
    { threshold: 20 },
    result,
  );
  const items = [...document.querySelectorAll("#books li")].map((li) => li.textContent?.trim());
  expect(items).toEqual(books.map((b) => `${b.title}: ${b.stock}`));
});
