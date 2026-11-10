import { compileSnippet } from "../helpers/snippet";

/**
 * Proves the contract-test harness itself: CDS snippets compile to linked CSN with
 * annotations and doc comments intact. If this fails, every other contract test is suspect.
 */
describe("contract harness", () => {
  test("compiles a snippet with @mcp annotations and doc comments", () => {
    const csn = compileSnippet(`
      /** The shop. */
      @mcp service S {
        /** Books for sale. */
        entity Books { key ID : Integer; secret : String @mcp.omit; }
      }
    `);
    const service = csn.definitions["S"] as unknown as Record<string, unknown>;
    const books = csn.definitions["S.Books"] as unknown as {
      doc: string;
      elements: Record<string, Record<string, unknown>>;
    };

    expect(service["@mcp"]).toBe(true);
    expect(service["doc"]).toBe("The shop.");
    expect(books.doc).toBe("Books for sale.");
    expect(books.elements["secret"]?.["@mcp.omit"]).toBe(true);
  });
});
