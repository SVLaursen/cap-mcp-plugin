import type { EntitySpec, JsonSchema } from "../types";
import type { ToolResult } from "./results";

/**
 * A tool call the agent can fix: a bad argument, a missing record. Becomes an `isError` result,
 * never a protocol error, so the agent sees what went wrong.
 */
export class ToolError extends Error {
  constructor(
    readonly code:
      "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFIRMATION_REQUIRED" | "CONFIRMATION_DECLINED",
    message: string,
    readonly target?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * An @mcp.elicit operation that was not confirmed (nothing ran). Carries the form to show the
 * user: a client that can elicit asks with it (MRTR `input_required`) and retries.
 */
export class ConfirmationRequired extends ToolError {
  constructor(
    message: string,
    readonly request: { message: string; requestedSchema: JsonSchema },
  ) {
    super("CONFIRMATION_REQUIRED", message);
    this.name = "ConfirmationRequired";
  }
}

export const notFound = (entity: EntitySpec, key: Record<string, unknown>) =>
  new ToolError("NOT_FOUND", `No ${entity.title} with ${JSON.stringify(key)}`);

/**
 * Map an error from execute() to an `isError` tool result, or undefined if it is not one the agent
 * can act on (bugs, 5xx, failed commits: the caller reports those as errors). Call it only AFTER
 * the transaction has rolled back: execute() throws so that CAP never commits partial work.
 */
export function errorResult(error: unknown): ToolResult | undefined {
  if (error instanceof ToolError) return toolError(error);
  const cap = capError(error);
  return cap && toolError(cap);
}

interface ToolErrorLike {
  code: string;
  message: string;
  target?: string;
  details?: unknown[];
}

function toolError(error: ToolErrorLike): ToolResult {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.target && { target: error.target }),
    ...(error.details && { details: error.details }),
  };
  return {
    isError: true,
    structuredContent: { error: body },
    text: `${error.code}: ${error.message}`,
  };
}

/** CAP's bare status errors (req.reject(403), a missing record) get readable codes. */
const BARE_STATUS: Record<number, { code: string; message: string }> = {
  401: { code: "UNAUTHORIZED", message: "Authentication required" },
  403: { code: "FORBIDDEN", message: "Not allowed for this user" },
  404: { code: "NOT_FOUND", message: "Not found" },
};

/**
 * A CAP request error (4xx, e.g. req.error / req.reject, ASSERT_*) as a tool error the agent
 * can act on, keeping code, target and details. Anything else (5xx, bugs) is not ours to hide.
 */
function capError(error: unknown): ToolErrorLike | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  const numeric = typeof err.code === "number" ? err.code : undefined;
  const details = Array.isArray(err.details)
    ? (err.details as Record<string, unknown>[])
    : undefined;
  // CAP's MULTIPLE_ERRORS carries no status of its own, only its details' (all 4xx for input).
  const fromDetails = details?.length
    ? Math.max(
        ...details.map(
          (detail) => Number(detail.status ?? detail.statusCode ?? detail.code ?? 400) || 400,
        ),
      )
    : undefined;
  const status = Number(err.status ?? err.statusCode ?? numeric ?? fromDetails ?? NaN);
  if (!(status >= 400 && status < 500)) return undefined;
  const message = typeof err.message === "string" ? err.message : "";
  const named = BARE_STATUS[status];
  const bare = (typeof err.code !== "string" || /^\d+$/.test(err.code)) && /^\d*$/.test(message);
  if (named && bare) return { code: named.code, message: named.message };
  return {
    code: typeof err.code === "string" ? err.code : message || String(status),
    message: message || String(err.code),
    target: typeof err.target === "string" ? err.target : undefined,
    // An error's message is not enumerable, so read each field rather than spreading it.
    details: details?.map((detail) =>
      capError({
        status: detail.status ?? status,
        code: detail.code,
        message: detail.message,
        target: detail.target,
      }),
    ),
  };
}
