import {
  CLIENT_CAPABILITIES_META_KEY,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ElicitInputParams,
  InputRequiredResult,
  McpServerFactory,
  ServerContext,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { RequestHandler } from "express";
import { APP_MIME_TYPE, McpApps, linkedUri } from "./apps";
import { isProduction } from "./auth";
import { hintsFor, withNotes, type RegisteredHints, type ToolTarget } from "./hints";
import {
  isNotFound,
  visibleFixed,
  type FixedResource,
  type ListedResource,
  type RegisteredResources,
  type ResourceContext,
  type TemplateResource,
} from "./registered-resources";
import {
  ConfirmationRequired,
  Executor,
  MAX_COMPLETIONS,
  ToolError,
  errorResult,
  type ServiceLike,
  type ToolResult,
} from "../executor";
import type { ExposureRegistry } from "../exposure-registry";
import { renderPrompt } from "../exposure-registry/prompts";
import { promptArgsSchema } from "../schema-mapper";
import type { ExposureSpec, PromptSpec, ResourceSpec, ToolSpec, UserLike } from "../types";
import { compareText } from "../util";

/**
 * adapter
 *
 * The MCP protocol edge: JSON-RPC over Streamable HTTP, built on the MCP
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
  tenant?: string;
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
  /** Server instructions (cds.env.mcp.instructions), if any. */
  instructions?: string;
  /** The current request's context (cds.context), read inside the request. */
  context(): RequestContext | undefined;
  /** The app's model, for contexts without a model of their own (cds.model). */
  model(): object;
  /** The registry for a model (registryCache). */
  registryFor(model: object): ExposureRegistry;
  /** MCP App UI resources (ADR 0012); none when omitted. */
  apps?: McpApps;
  /** Resources from code (`mcp:resources`, ADR 0013); none when omitted. */
  resources?: RegisteredResources;
  /** Instructions and tool notes from code (`mcp:hints`, ADR 0014); none when omitted. */
  hints?: RegisteredHints;
  /** CAP services by name (cds.services). */
  services: Record<string, TxService | undefined>;
  /** CAP's messages (cds.i18n.messages.at), so errors read as they do over OData. */
  translate?: Translate;
  /** `warn` is for hints cut to their limit (ADR 0014); errors go to `error` without it. */
  log: { error(...args: unknown[]): void; warn?(...args: unknown[]): void };
}

/**
 * Executors per registry (with the registry's limits) and validators per schema object, built
 * once per activation: the caches live in the factory, not the module (ADR 0005).
 */
function caches() {
  const executors = new WeakMap<ExposureRegistry, Executor>();
  const schemas = new WeakMap<object, ReturnType<typeof fromJsonSchema>>();
  const promptArgs = new WeakMap<PromptSpec, ReturnType<typeof fromJsonSchema>>();
  return {
    executorFor(registry: ExposureRegistry): Executor {
      let executor = executors.get(registry);
      if (!executor) {
        executor = new Executor(registry.spec, {
          limits: registry.limits,
          filterNotices: registry.filterNotices,
        });
        executors.set(registry, executor);
      }
      return executor;
    },
    argsSchemaFor(prompt: PromptSpec) {
      let standard = promptArgs.get(prompt);
      if (!standard) {
        standard = fromJsonSchema(promptArgsSchema(prompt));
        promptArgs.set(prompt, standard);
      }
      return standard;
    },
    schemaFor(schema: object) {
      let standard = schemas.get(schema);
      if (!standard) {
        standard = fromJsonSchema(schema);
        schemas.set(schema, standard);
      }
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
      : { structuredContent: result.structuredContent }),
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
  const err = error as Record<string, unknown>;
  const details = Array.isArray(err.details) ? (err.details as Record<string, unknown>[]) : [];
  for (const each of [err, ...details]) {
    const message = typeof each.message === "string" ? each.message : undefined;
    const unwrapped = message?.startsWith("{i18n>") ? message.slice(6, -1) : message;
    const key = unwrapped || (typeof each.code === "string" ? each.code : undefined);
    if (!key || /^\d+$/.test(key)) continue;
    const text = translate(key, locale, each.args);
    if (!text) continue;
    const status =
      each.status ?? each.statusCode ?? (typeof each.code === "number" ? each.code : undefined);
    // CAP may give the status as a number or a numeric string.
    if (!each.code || Number(each.code) === Number(status)) {
      // The numeric code was the status (CAP's req.error(409, key, …)); keep it as one.
      if (status !== undefined) each.status = status;
      each.code = key;
    }
    each.message = text;
  }
  return error;
}

/** The confirmation form's key in `inputRequests` / `inputResponses`. */
const CONFIRM = "confirm";

/** Whether this 2026-07-28 request's client declared it can show forms (elicitation). */
function canElicit(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const elicitation = capabilities?.elicitation;
  // `elicitation: {}` means form support (the rule from before modes existed).
  return !!elicitation && (elicitation.form !== undefined || elicitation.url === undefined);
}

/** JSON with sorted object keys, so equal arguments give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The MRTR `requestState` of a confirmation form: a digest of the tool, the agent's arguments
 * and the user. An accept counts only when the retry echoes the digest of the same call, so an
 * accept nobody asked for, or one for other arguments, gets a new form instead. The digest is
 * recomputed, never trusted or decoded; it carries nothing a client could not send itself.
 */
function confirmationState(tool: string, args: unknown, user: UserLike): string {
  return createHash("sha256")
    .update(canonical({ tool, args, user: user.id }))
    .digest("base64url");
}

/**
 * An @mcp.elicit call that was not confirmed, after rollback (nothing ran): ask the user with
 * MRTR `input_required` when this client can, or say why it cannot run.
 */
function confirmation(
  error: ConfirmationRequired,
  era: string,
  ctx: ServerContext,
  requestState: string,
): InputRequiredResult | CallToolResult {
  const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM);
  if (answer.kind === "elicit" && answer.action !== "accept") {
    const declined = new ToolError(
      "CONFIRMATION_DECLINED",
      `The user did not confirm ${error.request.message.replace(/^Confirm |\?$/g, "")}; nothing was done`,
    );
    return toCallToolResult(errorResult(declined) as ToolResult);
  }
  if (era !== "legacy" && canElicit(ctx)) {
    return inputRequired({
      inputRequests: { [CONFIRM]: inputRequired.elicit(error.request as ElicitInputParams) },
      requestState,
    });
  }
  const why =
    era === "legacy"
      ? "this client's MCP version cannot ask for confirmation, so it cannot run this tool (use a client that speaks 2026-07-28)"
      : "this client did not declare the elicitation capability, so it cannot ask for confirmation";
  const refused = new ToolError(error.code, `${error.message}; ${why}`, error.target);
  return toCallToolResult(errorResult(refused) as ToolResult);
}

/**
 * What a tools notes provider is told about a generated tool (ADR 0014): its service and the
 * entity, action or function behind it. Describe and compact tools act on a whole service, so
 * they have no such definition and get no notes.
 */
function toolTarget(spec: ExposureSpec, tool: ToolSpec): ToolTarget | undefined {
  const { target } = tool;
  const service = serviceOf(spec, target);
  if (!service) return undefined;
  if (target.kind === "entity")
    return { tool: tool.name, service, definition: target.entity, kind: "entity" };
  if (target.kind !== "operation") return undefined;
  const operation = spec.services
    .flatMap((s) => s.operations)
    .find((o) => o.name === target.operation);
  if (!operation) return undefined;
  return { tool: tool.name, service, definition: operation.name, kind: operation.kind };
}

/** The per-request server factory: one McpServer with the caller's tools. */
export function serverFactory(options: AdapterOptions): McpServerFactory {
  const { executorFor, schemaFor, argsSchemaFor } = caches();
  // Hints from code (ADR 0014): asked on every request, never cached; nothing to do without them.
  const hints = options.hints
    ? hintsFor(options.hints, {
        error: (...args) => options.log.error(...args),
        warn: (...args) => (options.log.warn ?? options.log.error)(...args),
      })
    : undefined;
  // Per model: each generated tool's target for notes providers (structure only, no answers).
  const targets = new WeakMap<ToolSpec, ToolTarget | null>();
  const targetOf = (registry: ExposureRegistry, tool: ToolSpec) => {
    if (!targets.has(tool)) targets.set(tool, toolTarget(registry.spec, tool) ?? null);
    return targets.get(tool) ?? undefined;
  };
  // Problems with registrations from code are logged once per activation, not per request.
  const reported = new Set<string>();
  const once = (key: string, ...message: unknown[]) => {
    if (reported.has(key)) return;
    reported.add(key);
    options.log.error(...message);
  };
  // Per model: the code templates whose names do not clash with its cap:// templates.
  const servedTemplates = new WeakMap<ExposureRegistry, TemplateResource[]>();
  const templatesFor = (registry: ExposureRegistry): TemplateResource[] => {
    let kept = servedTemplates.get(registry);
    if (!kept) {
      // Every cap:// template in the model, not only the caller's: the answer must not depend on roles.
      const capNames = new Set(registry.resourceNames());
      kept = (options.resources?.templates() ?? []).filter((t) => {
        if (!capNames.has(t.name)) return true;
        options.log.error(
          `${t.uriTemplate} is not served: its name ${t.name} is a cap:// template's name in this model`,
        );
        return false;
      });
      servedTemplates.set(registry, kept);
    }
    return kept;
  };
  return async ({ era }) => {
    const context = options.context();
    if (!context)
      throw new Error("cap-mcp: no cds.context; is /mcp mounted behind CAP's middlewares?");
    const user = context.user;
    const registry = options.registryFor(context.model ?? options.model());
    const executor = executorFor(registry);
    const resources = registry.resourcesFor(user);
    const prompts = registry.promptsFor(user);
    const apps = options.apps ?? new McpApps();
    // A tool keeps its UI link only if that resource has content; the caller may read it then.
    const tools = registry
      .toolsFor(user)
      .map((tool) => ({ tool, _meta: apps.linkedMeta(tool._meta) }));
    const uis = [
      ...new Set(tools.map((t) => linkedUri(t._meta)).filter((u) => u !== undefined)),
    ].sort();
    // Resources from code (ADR 0013): the fixed ones this caller may see, and every template.
    const caller: ResourceContext = { user, locale: context.locale, tenant: context.tenant };
    const fixed = options.resources
      ? visibleFixed(options.resources, caller, (uri, error) =>
          once(`visible ${uri}`, `visible of ${uri} failed; hidden while it fails:`, error),
        )
      : [];
    // The SDK keys templates by name: a cap:// template's name in this model wins.
    const templates = templatesFor(registry);
    const hasResources =
      resources.length > 0 || uis.length > 0 || fixed.length > 0 || templates.length > 0;
    const listed = { ttlMs: TOOLS_TTL_MS, cacheScope: "private" } as const;
    // Hints (ADR 0014), as this caller, inside the request's cds.context; skipped without providers.
    const hinted = hints?.active
      ? await Promise.all([
          hints.instructions(options.instructions, caller),
          hints.notes(
            tools.map(({ tool }) => targetOf(registry, tool)).filter((t) => t !== undefined),
            caller,
          ),
        ])
      : undefined;
    const instructions = hinted ? hinted[0] : options.instructions;
    const notes = hinted?.[1];
    const server = new McpServer(options.serverInfo, {
      ...(instructions && { instructions }),
      // Registering defaults listChanged to true; we never send that notification.
      capabilities: {
        tools: { listChanged: false },
        ...(hasResources ? { resources: { listChanged: false } } : {}),
        ...(prompts.length ? { prompts: { listChanged: false } } : {}),
      },
      // Lists depend on the user: only the requesting client may cache them.
      cacheHints: {
        "tools/list": listed,
        "server/discover": listed,
        ...(hasResources ? { "resources/list": listed, "resources/templates/list": listed } : {}),
        ...(prompts.length ? { "prompts/list": listed } : {}),
      },
    });
    for (const resource of resources)
      registerResource(server, resource, registry, executor, options);
    registerCompletion(server, resources, templates, caller, {
      registry,
      executor,
      options,
      variables: (t) => options.resources?.variables(t.uriTemplate) ?? [],
    });
    for (const uri of uis) registerApp(server, uri, apps, options);
    for (const resource of fixed) registerFixed(server, resource, caller, options);
    for (const template of templates) registerFromTemplate(server, template, caller, options);
    for (const prompt of prompts) registerPrompt(server, prompt, argsSchemaFor(prompt));
    for (const { tool, _meta } of tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: withNotes(tool.description, notes?.get(tool.name)),
          inputSchema: schemaFor(tool.inputSchema),
          outputSchema: tool.outputSchema && schemaFor(tool.outputSchema),
          annotations: tool.annotations,
          _meta,
        },
        async (args: unknown, ctx: ServerContext) => {
          const service = options.services[serviceOf(registry.spec, tool.target) ?? ""];
          if (!service) throw new Error(`cap-mcp: no service serves ${tool.name}`);
          // A retry that carries the user's yes to the form we asked with for this call (MRTR).
          const state = confirmationState(tool.name, args ?? {}, user);
          const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM);
          const confirmed =
            answer.kind === "elicit" &&
            answer.action === "accept" &&
            ctx.mcpReq.requestState() === state;
          try {
            // The service's own root transaction, inheriting cds.context (user, tenant,
            // locale). execute() throws on any error, so CAP rolls back before we map it.
            const result = await service.tx((tx) =>
              executor.execute(tool, (args ?? {}) as Record<string, unknown>, tx, user, {
                confirmed,
                ...(confirmed && answer.content && { confirmedArgs: answer.content }),
              }),
            );
            return toCallToolResult(result);
          } catch (error) {
            if (error instanceof ConfirmationRequired) return confirmation(error, era, ctx, state);
            const translated = localized(error, options.translate, context.locale);
            const result = errorResult(translated);
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
      const service = resourceService(resource, registry, options);
      const key = [variables.key ?? ""].flat().join(",");
      try {
        const result = await service.tx((tx) => executor.readResource(resource.entity, key, tx));
        return {
          contents: [{ uri: uri.href, mimeType, text: JSON.stringify(result.structuredContent) }],
        };
      } catch (error) {
        const mapped = errorResult(error);
        if (!mapped) throw internalError(`reading ${uri.href} failed:`, error, options);
        throw new ResourceNotFoundError(uri.href, mapped.text);
      }
    },
  );
}

/** The CAP service an entity's resource is read in. */
function resourceService(
  resource: ResourceSpec,
  registry: ExposureRegistry,
  options: AdapterOptions,
): TxService {
  const name = serviceOf(registry.spec, { kind: "entity", entity: resource.entity, mode: "get" });
  const service = options.services[name ?? ""];
  if (!service) throw new Error(`cap-mcp: no service serves ${resource.entity}`);
  return service;
}

/**
 * `completion/complete` for the `{key}` of the caller's @mcp.completion resources, read as the
 * caller (a CAP refusal offers nothing). Our own handler rather than the SDK's template
 * callbacks: those report `total` as the number of values fetched, which is wrong when there
 * are more. Without such a resource there is no handler and no `completions` capability.
 */
function registerCompletion(
  server: McpServer,
  resources: ResourceSpec[],
  templates: TemplateResource[],
  caller: ResourceContext,
  {
    registry,
    executor,
    options,
    variables,
  }: {
    registry: ExposureRegistry;
    executor: Executor;
    options: AdapterOptions;
    variables: (template: TemplateResource) => string[];
  },
): void {
  if (!resources.some((r) => r.completion) && !templates.some((t) => t.complete)) return;
  server.server.registerCapabilities({ completions: {} });
  const none = { completion: { values: [], hasMore: false } };
  server.server.setRequestHandler("completion/complete", async (request) => {
    const { ref, argument } = request.params;
    const uri = ref.type === "ref/resource" ? ref.uri : undefined;
    const fromCode = templates.find((t) => t.uriTemplate === uri);
    if (fromCode) {
      if (!fromCode.complete || !variables(fromCode).includes(argument.name)) return none;
      try {
        const values = await fromCode.complete(caller, argument.name, argument.value);
        return {
          completion: {
            values: values.slice(0, MAX_COMPLETIONS),
            hasMore: values.length > MAX_COMPLETIONS,
          },
        };
      } catch (error) {
        options.log.error(`complete of ${fromCode.uriTemplate} failed; offering nothing:`, error);
        return none;
      }
    }
    const resource = resources.find((r) => r.uriTemplate === uri);
    if (!resource) {
      const what = uri !== undefined ? `Resource template ${uri}` : "This reference";
      throw new ProtocolError(INVALID_PARAMS, `${what} has no completion`);
    }
    if (!resource.completion || argument.name !== "key") return none;
    try {
      const completion = await resourceService(resource, registry, options).tx((tx) =>
        executor.completeKey(resource.entity, argument.value, tx),
      );
      return { completion };
    } catch (error) {
      if (errorResult(error)) return none;
      throw internalError(`completing ${resource.uriTemplate} failed:`, error, options);
    }
  });
}

/**
 * An error CAP did not map (a bug, a database failure), outside tools/call: logged, and answered
 * as JSON-RPC Internal error. Its text reaches the client only outside production, as for tools.
 */
function internalError(what: string, error: unknown, options: AdapterOptions): ProtocolError {
  options.log.error(what, error);
  const message = !isProduction() && error instanceof Error ? error.message : "Internal error";
  return new ProtocolError(INTERNAL_ERROR, message);
}

/** One MCP App UI resource (ADR 0012): its HTML, as ext-apps' registerAppResource serves it. */
function registerApp(server: McpServer, uri: string, apps: McpApps, options: AdapterOptions): void {
  server.registerResource(uri, uri, { mimeType: APP_MIME_TYPE }, async () => {
    const content = apps.content(uri);
    if (!content) throw new ResourceNotFoundError(uri);
    try {
      return { contents: [{ uri, mimeType: APP_MIME_TYPE, text: await content() }] };
    } catch (error) {
      throw internalError(`reading ${uri} failed:`, error, options);
    }
  });
}

/** A fixed resource from code (ADR 0013): `read` inside the request's cds.context, no srv.tx. */
function registerFixed(
  server: McpServer,
  resource: FixedResource,
  caller: ResourceContext,
  options: AdapterOptions,
): void {
  const { uri, name, title, description, mimeType } = resource;
  const metadata = { mimeType, ...(title && { title }), ...(description && { description }) };
  server.registerResource(name, uri, metadata, async () => {
    const text = await readFromCode(uri, () => resource.read(caller), options);
    return { contents: [{ uri, mimeType, text }] };
  });
}

/** A resource template from code (ADR 0013): `list` and `read` run as the caller. */
function registerFromTemplate(
  server: McpServer,
  template: TemplateResource,
  caller: ResourceContext,
  options: AdapterOptions,
): void {
  const { uriTemplate, name, title, description, mimeType, list } = template;
  const listed = list
    ? async () => {
        try {
          const result: unknown = await list.call(template, caller);
          if (!Array.isArray(result)) {
            options.log.error(`list of ${uriTemplate} returned no array; it adds nothing:`, result);
            return { resources: [] };
          }
          return { resources: result.filter(isListable).map(listedEntry) };
        } catch (error) {
          // One failing template must not break resources/list for everything else.
          options.log.error(`list of ${uriTemplate} failed; it adds nothing:`, error);
          return { resources: [] };
        }
      }
    : undefined;
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: listed }),
    { mimeType, ...(title && { title }), ...(description && { description }) },
    async (uri, variables) => {
      const params = Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [key, [value].flat().join(",")]),
      );
      const text = await readFromCode(
        uri.href,
        () => template.read({ ...caller, uri: uri.href, params }),
        options,
      );
      return { contents: [{ uri: uri.href, mimeType, text }] };
    },
  );
}

/**
 * Run a registrant's `read`: its 404 is resource-not-found with the URI only (its message was
 * written for the plugin, not for agents); anything else is an internal error, logged.
 */
async function readFromCode(
  uri: string,
  read: () => string | Promise<string>,
  options: AdapterOptions,
): Promise<string> {
  let text: unknown;
  try {
    text = await read();
  } catch (error) {
    if (isNotFound(error)) throw new ResourceNotFoundError(uri);
    throw internalError(`reading ${uri} failed:`, error, options);
  }
  if (typeof text !== "string") {
    const error = new Error(`read returned ${typeof text}, not text`);
    throw internalError(`reading ${uri} failed:`, error, options);
  }
  return text;
}

/** A template's `list` entry we pass on: a string URI outside our own schemes, and a name. */
function isListable(entry: unknown): entry is ListedResource {
  if (!entry || typeof entry !== "object") return false;
  const { uri, name } = entry as Record<string, unknown>;
  return typeof uri === "string" && typeof name === "string" && !/^(cap|ui):/i.test(uri);
}

/** Only the fields MCP lists; anything else a registrant returned stays on the server. */
function listedEntry({ uri, name, title, description }: ListedResource): ListedResource {
  return { uri, name, ...(title && { title }), ...(description && { description }) };
}

/** One @mcp.prompts entry: its template as one message, arguments checked by the SDK. */
function registerPrompt(
  server: McpServer,
  prompt: PromptSpec,
  argsSchema: ReturnType<typeof fromJsonSchema>,
): void {
  server.registerPrompt(
    prompt.name,
    {
      ...(prompt.title && { title: prompt.title }),
      ...(prompt.description && { description: prompt.description }),
      argsSchema,
    },
    (args: unknown) => ({
      ...(prompt.description && { description: prompt.description }),
      messages: [
        {
          role: prompt.role,
          content: { type: "text", text: renderPrompt(prompt, args as Record<string, string>) },
        },
      ],
    }),
  );
}

/** The express handler for /mcp, to mount behind CAP's own middlewares. */
export function mcpHandler(options: AdapterOptions): RequestHandler {
  const node = toNodeHandler(createMcpHandler(serverFactory(options), { legacy: "stateless" }));
  return (req, res, next) => {
    node(req, res).catch(next);
  };
}
