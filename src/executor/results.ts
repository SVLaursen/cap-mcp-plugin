/** What a tool call returns, before the adapter turns it into MCP content. */
export interface ToolResult {
  /** Machine-readable result matching the tool's outputSchema; `{ error }` for tool errors. */
  structuredContent?: unknown;
  /** Short human/LLM-readable rendering (one block, not one per row). */
  text: string;
  isError?: boolean;
  /** resource_link items for records with @mcp.resource. */
  links?: { uri: string; name: string }[];
}

/** A successful result: the structured content, and the same as JSON text. */
export function result(structuredContent: unknown, links?: ToolResult["links"]): ToolResult {
  return { structuredContent, text: JSON.stringify(structuredContent), ...(links && { links }) };
}

/** Drop undefined properties, so descriptions only say what is there. */
export function clean<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
