import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  createMcpHandler,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import type { CallToolResult, McpServerFactory } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { RequestHandler } from "express";
import { isProduction } from "./auth";
import { Executor, ToolError, errorResult, type ServiceLike, type ToolResult } from "../executor";
import type { ExposureRegistry } from "../exposure-registry";
import type { ExposureSpec, ResourceSpec, ToolSpec, UserLike } from "../types";

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
  locale?: string;
}

/** A message bundle lookup, as `cds.i18n.messages.at(key, locale, args)`. */
export type Translate = (key: string, locale?: string, args?: unknown) => string | undefined;

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
  /** CAP's messages (cds.i18n.messages.at), so errors read as they do over OData. */
  translate?: Translate;
  log: { error(...args: unknown[]): void };
}

/**
 * Executors per registry (with the registry's limits) and validators per schema object, built
 * once per activation: the caches live in the factory, not the module (ADR 0005).
 */
function caches() {
  const executors = new WeakMap<ExposureRegistry, Executor>();
  const schemas = new WeakMap<object, ReturnType<typeof fromJsonSchema>>();
  return {
    executorFor(registry: ExposureRegistry): Executor {
      let executor = executors.get(registry);
      if (!executor) {
        executor = new Executor(registry.spec, { limits: registry.limits });
        executors.set(registry, executor);
      }
      return executor;
    },
    schemaFor(schema: object) {
      let standard = schemas.get(schema);
      if (!standard) schemas.set(schema, (standard = fromJsonSchema(schema)));
      return standard;
    },
  };
}

/** The name of the CAP service a tool acts on. */
function serviceOf(spec: ExposureSpec, target: ToolSpec["target"]): string | undefined {
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
 * Translate a CAP error and its details as CAP's protocol adapters do (HttpAdapter.normalized
 * + localized): the message, or `{i18n>key}`, or the code is a key into the app's and CAP's
 * message bundles, filled with the error's `args`, in the caller's locale. An untranslated key
 * stays as it was; the key becomes the code if the error has none. Bare statuses are left to
 * the executor's own names.
 */
function localized(error: unknown, translate: Translate | undefined, locale?: string): unknown {
  if (!translate || !error || typeof error !== "object" || error instanceof ToolError) return error;
  const e = error as Record<string, unknown>;
  const all = [e, ...(Array.isArray(e.details) ? (e.details as Record<string, unknown>[]) : [])];
  for (const x of all) {
    const message = typeof x.message === "string" ? x.message : undefined;
    const unwrapped = message?.startsWith("{i18n>") ? message.slice(6, -1) : message;
    const key = unwrapped || (typeof x.code === "string" ? x.code : undefined);
    if (!key || /^\d+$/.test(key)) continue;
    const text = translate(key, locale, x.args);
    if (!text) continue;
    const status = x.status ?? x.statusCode ?? (typeof x.code === "number" ? x.code : undefined);
    if (!x.code || x.code == status) {
      // The numeric code was the status (CAP's req.error(409, key, …)); keep it as one.
      if (status !== undefined) x.status = status;
      x.code = key;
    }
    x.message = text;
  }
  return error;
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
  const { executorFor, schemaFor } = caches();
  return ({ era }) => {
    const context = options.context();
    if (!context)
      throw new Error("cap-mcp: no cds.context; is /mcp mounted behind CAP's middlewares?");
    const user = context.user;
    const registry = options.registryFor(context.model ?? options.model());
    const executor = executorFor(registry);
    const resources = registry.resourcesFor(user);
    const listed = { ttlMs: TOOLS_TTL_MS, cacheScope: "private" } as const;
    const server = new McpServer(options.serverInfo, {
      // Registering defaults listChanged to true; we never send that notification.
      capabilities: {
        tools: { listChanged: false },
        ...(resources.length ? { resources: { listChanged: false } } : {}),
      },
      // Lists depend on the user: only the requesting client may cache them.
      cacheHints: {
        "tools/list": listed,
        "server/discover": listed,
        ...(resources.length
          ? { "resources/list": listed, "resources/templates/list": listed }
          : {}),
      },
    });
    for (const resource of resources)
      registerResource(server, resource, registry, executor, options);
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
          const service = options.services[serviceOf(registry.spec, tool.target) ?? ""] as
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
            const translated = localized(error, options.translate, context.locale);
            const result = errorResult(era === "legacy" ? forLegacy(translated) : translated);
            if (result) return toCallToolResult(result);
            options.log.error(`${tool.name} failed:`, error);
            const message =
              !isProduction() && error instanceof Error ? error.message : "Internal error";
            return toCallToolResult({ text: message, isError: true });
          }
        },
      );
    }
    return server;
  };
}

/**
 * One @mcp.resource template: records by key, never a list of them (ADR 0006). Read in the
 * service's root transaction like a tool call; a record that is not there (or a key that is
 * not one) is the protocol's resource-not-found error.
 */
function registerResource(
  server: McpServer,
  resource: ResourceSpec,
  registry: ExposureRegistry,
  executor: Executor,
  options: AdapterOptions,
): void {
  const template = new ResourceTemplate(resource.uriTemplate, { list: undefined });
  const { title, description, mimeType } = resource;
  server.registerResource(
    resource.name,
    template,
    { title, mimeType, ...(description && { description }) },
    async (uri, variables) => {
      const name = serviceOf(registry.spec, {
        kind: "entity",
        entity: resource.entity,
        mode: "get",
      });
      const service = options.services[name ?? ""] as TxService | undefined;
      if (!service) throw new Error(`cap-mcp: no service serves ${resource.entity}`);
      const key = [variables.key ?? ""].flat().join(",");
      try {
        const result = await service.tx((tx) => executor.readResource(resource.entity, key, tx));
        return {
          contents: [{ uri: uri.href, mimeType, text: JSON.stringify(result.structuredContent) }],
        };
      } catch (error) {
        const mapped = errorResult(error);
        if (!mapped) {
          options.log.error(`reading ${uri.href} failed:`, error);
          throw error;
        }
        throw new ResourceNotFoundError(uri.href, mapped.text);
      }
    },
  );
}

/** The express handler for /mcp, to mount behind CAP's own middlewares. */
export function mcpHandler(options: AdapterOptions): RequestHandler {
  const node = toNodeHandler(createMcpHandler(serverFactory(options), { legacy: "stateless" }));
  return (req, res, next) => {
    node(req, res).catch(next);
  };
}
