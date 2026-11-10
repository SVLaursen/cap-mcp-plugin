import { NotImplementedError } from "../errors";
import type { ToolSpec } from "../types";

/** The executor's view of a CAP service. A structural subset of cds.Service. */
export interface ServiceLike {
  name: string;
  run(query: unknown): Promise<unknown>;
  send(request: {
    event: string;
    entity?: string;
    data?: unknown;
    params?: unknown[];
  }): Promise<unknown>;
}

export interface ToolResult {
  /** Machine-readable result matching the tool's outputSchema. */
  structuredContent?: unknown;
  /** Short human/LLM-readable rendering (one block, not one per row). */
  text: string;
  isError?: boolean;
  /** resource_link items for records with @mcp.resource. */
  links?: { uri: string; name: string }[];
}

/**
 * executor (milestone M3)
 *
 * Turns a validated tool call into CQN objects and runs it through the CAP service.
 *
 * Contract:
 * - Always `srv.run(cqn)` / `srv.send(...)` inside the request's cds.context. Never a manual
 *   transaction, never a raw DB call, never string-built CQN (build CQN objects).
 * - Search uses SELECT.search() so @cds.search applies. Omitted fields are never selected,
 *   searched, filtered on or ordered by.
 * - Paging returns { rows, total, nextCursor }; count ignores limit/offset/orderBy.
 * - `get` of a missing key is a NOT_FOUND tool error, not `null`.
 * - CAP errors keep code, target and details (req.error) in the tool error.
 * - Failed commits surface as errors (CAP's own transaction handling guarantees this when we
 *   do not swallow).
 * - Draft-enabled entities: writes go through the draft API or are refused clearly.
 */
export async function execute(
  _tool: ToolSpec,
  _args: Record<string, unknown>,
  _service: ServiceLike,
): Promise<ToolResult> {
  throw new NotImplementedError("execute", "M3");
}
