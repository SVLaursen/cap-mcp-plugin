import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import type { CallToolResult, McpServerFactory } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { RequestHandler } from "express";
import { Executor, ToolError, errorResult, type ServiceLike, type ToolResult } from "../executor";
import type { ExposureRegistry } from "../exposure-registry";
import type { ExposureSpec, ToolSpec, UserLike } from "../types";

/**
 * adapter (milestone M4)
 *
 * The MCP protocol edge: JSON-RPC over Streamable HTTP (and stdio, M6), built on the MCP
 * TypeScript SDK v2 (@modelcontextprotocol/server), which implements the 2026-07-28 spec.
 *
 * Contract:
 * - Stateless: no sessions, no Mcp-Session-Id, no per-connection tool lists. Each request runs
 *   in its own cds.context set up by CAP's middleware (auth included); the factory builds a
 *   fresh server per request from the registry for that context's model and user.
 * - One handler serves 2026-07-28 and 2025-era clients (ADR 0010).
 * - Each tools/call runs in the service's own root transaction (`srv.tx`); errors leave the
 *   transaction first (CAP rolls back), and only then become `isError` results.
 * - Advertises only what it implements.
 */

/**
 * How long a client may cache tools/list and server/discover. Tool lists change only with the
 * model (a deployment, a tenant extension) or the user's roles; CAP enforces either way.
 */
export const TOOLS_TTL_MS = 60_000;

/** What the adapter needs from a request's cds.context. */
export interface RequestContext {
  user: UserLike;
  model?: object;
}

/** A CAP service as the adapter uses it: the executor's view, plus its own root transaction. */
export interface TxService extends ServiceLike {
  tx<T>(fn: (tx: ServiceLike) => Promise<T>): Promise<T>;
}

export interface AdapterOptions {
  /** The server identity reported in server/discover and initialize. */
  serverInfo: { name: string; version: string };
  /** The current request's context (cds.context), read inside the request. */
  context(): RequestContext | undefined;
  /** The app's model, for contexts without a model of their own (cds.model). */
  model(): object;
  /** The registry for a model (registryCache). */
  registryFor(model: object): ExposureRegistry;
  /** CAP services by name (cds.services). */
  services: Record<string, unknown>;
  /** Hide messages of unexpected errors from clients (CAP does the same in production). */
  production?: boolean;
  log: { error(...args: unknown[]): void };
}

/** Executors per spec, and validators per tool: both are built once and shared. */
const executors = new WeakMap<ExposureSpec, Executor>();
const schemas = new WeakMap<object, ReturnType<typeof fromJsonSchema>>();

function executorFor(spec: ExposureSpec): Executor {
  let executor = executors.get(spec);
  if (!executor) executors.set(spec, (executor = new Executor(spec)));
  return executor;
}

function schemaFor(schema: object) {
  let standard = schemas.get(schema);
  if (!standard) schemas.set(schema, (standard = fromJsonSchema(schema)));
  return standard;
}

/** The name of the CAP service a tool acts on. */
function serviceOf(spec: ExposureSpec, tool: ToolSpec): string | undefined {
  const target = tool.target;
  if (target.kind === "describe" || target.kind === "compact") return target.service;
  const owns = (s: ExposureSpec["services"][number]) =>
    target.kind === "entity"
      ? s.entities.some((e) => e.name === target.entity)
      : s.operations.some((o) => o.name === target.operation);
  return spec.services.find(owns)?.name;
}

function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [
      { type: "text", text: result.text },
      ...(result.links ?? []).map((link) => ({ type: "resource_link" as const, ...link })),
    ],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent as Record<string, unknown> }),
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * A 2025-era request is stateless: the server cannot ask the user anything mid-call, so a call
 * that needs confirmation (@mcp.elicit) can never run. Say so, instead of asking for it.
 */
function forLegacy(error: unknown): unknown {
  if (!(error instanceof ToolError) || error.code !== "CONFIRMATION_REQUIRED") return error;
  return new ToolError(
    error.code,
    `${error.message}; this client's MCP version cannot ask for confirmation, so it cannot run this tool (use a client that speaks 2026-07-28)`,
    error.target,
  );
}

/** The per-request server factory: one McpServer with the caller's tools. */
export function serverFactory(options: AdapterOptions): McpServerFactory {
  return ({ era }) => {
    const context = options.context();
    if (!context)
      throw new Error("cap-mcp: no cds.context; is /mcp mounted behind CAP's middlewares?");
    const user = context.user;
    const registry = options.registryFor(context.model ?? options.model());
    const executor = executorFor(registry.spec);
    const server = new McpServer(options.serverInfo, {
      // Registering tools defaults listChanged to true; we never send that notification.
      capabilities: { tools: { listChanged: false } },
      // Lists depend on the user: only the requesting client may cache them.
      cacheHints: {
        "tools/list": { ttlMs: TOOLS_TTL_MS, cacheScope: "private" },
        "server/discover": { ttlMs: TOOLS_TTL_MS, cacheScope: "private" },
      },
    });
    for (const tool of registry.toolsFor(user)) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: schemaFor(tool.inputSchema),
          outputSchema: tool.outputSchema && schemaFor(tool.outputSchema),
          annotations: tool.annotations,
          _meta: tool._meta,
        },
        async (args: unknown) => {
          const service = options.services[serviceOf(registry.spec, tool) ?? ""] as
            TxService | undefined;
          if (!service) throw new Error(`cap-mcp: no service serves ${tool.name}`);
          try {
            // The service's own root transaction, inheriting cds.context (user, tenant,
            // locale). execute() throws on any error, so CAP rolls back before we map it.
            const result = await service.tx((tx) =>
              executor.execute(tool, (args ?? {}) as Record<string, unknown>, tx, user),
            );
            return toCallToolResult(result);
          } catch (error) {
            const result = errorResult(era === "legacy" ? forLegacy(error) : error);
            if (result) return toCallToolResult(result);
            options.log.error(`${tool.name} failed:`, error);
            const message =
              !options.production && error instanceof Error ? error.message : "Internal error";
            return toCallToolResult({ text: message, isError: true });
          }
        },
      );
    }
    return server;
  };
}

/** The express handler for /mcp, to mount behind CAP's own middlewares. */
export function mcpHandler(options: AdapterOptions): RequestHandler {
  const node = toNodeHandler(createMcpHandler(serverFactory(options), { legacy: "stateless" }));
  return (req, res, next) => {
    node(req, res).catch(next);
  };
}
