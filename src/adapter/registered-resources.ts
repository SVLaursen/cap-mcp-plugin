import { compareText } from "../util";

/**
 * Resources from code (ADR 0013): what app code and other plugins register through the
 * `mcp:resources` event. A few fixed resources (entry points) and templates for many documents.
 * The adapter adds them to each request's server; this file holds the registry and its rules.
 */

/** Who is asking: from the request's cds.context. */
export interface ResourceContext {
  /** cds.context.user (a cds.User). */
  user: unknown;
  tenant?: string;
  locale?: string;
}

/** One resource at a fixed URI. */
export interface FixedResource {
  /** Absolute and canonical (`new URL(uri).href === uri`); not cap: or ui:. Unique. */
  uri: string;
  name: string;
  title?: string;
  description?: string;
  /** Text only, for example "text/markdown". */
  mimeType: string;
  /** Called on every resources/read, inside the request's cds.context. */
  read(ctx: ResourceContext): string | Promise<string>;
  /** Synchronous. Without it, every caller sees the resource. */
  visible?(ctx: ResourceContext): boolean;
}

/** A concrete resource a template's `list` names. */
export interface ListedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
}

/** Many resources behind one RFC 6570 template, for example "okf://shop/{+path}". */
export interface TemplateResource {
  uriTemplate: string;
  /** Unique among templates (the SDK keys templates by name). */
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  read(
    ctx: ResourceContext & { uri: string; params: Record<string, string> },
  ): string | Promise<string>;
  /** Optional: concrete resources for resources/list. Leave it out for large sets. */
  list?(ctx: ResourceContext): ListedResource[] | Promise<ListedResource[]>;
  /** Optional: values for completion/complete on one of the template's variables. */
  complete?(ctx: ResourceContext, param: string, value: string): string[] | Promise<string[]>;
}

/** What the `mcp:resources` event hands to listeners. */
export interface ResourceRegistry {
  readonly contractVersion: 1;
  register(resource: FixedResource): void;
  registerTemplate(template: TemplateResource): void;
}

/** Schemes this plugin serves itself: records (ADR 0006) and MCP Apps (ADR 0012). */
const RESERVED = new Set(["cap:", "ui:"]);
const SCHEME = /^([a-z][a-z0-9+.-]*:)/i;

const fail = (message: string): never => {
  throw new Error(`cap-mcp: ${message}`);
};

export class RegisteredResources implements ResourceRegistry {
  readonly contractVersion = 1 as const;
  readonly #fixed = new Map<string, FixedResource>();
  readonly #templates = new Map<string, TemplateResource>();
  #closed = false;

  register(resource: FixedResource): void {
    this.#open();
    const uri = resource?.uri;
    let href: string | undefined;
    try {
      href = new URL(uri).href;
    } catch {
      fail(`a resource needs an absolute URI, got ${String(uri)}`);
    }
    if (href !== uri) fail(`${uri} is not canonical; register it as ${href}`);
    this.#check(uri, resource);
    if (resource.visible !== undefined && typeof resource.visible !== "function")
      fail(`visible of ${uri} must be a function`);
    if (this.#fixed.has(uri)) fail(`${uri} is already registered`);
    this.#fixed.set(uri, resource);
  }

  registerTemplate(template: TemplateResource): void {
    this.#open();
    const uri = template?.uriTemplate;
    if (typeof uri !== "string" || !SCHEME.test(uri))
      fail(`a resource template needs an absolute URI template, got ${String(uri)}`);
    if (!/\{[^}\s]+\}/.test(uri)) fail(`${uri} has no variable; register it as a fixed resource`);
    this.#check(uri, template);
    for (const key of ["list", "complete"] as const) {
      if (template[key] !== undefined && typeof template[key] !== "function")
        fail(`${key} of ${uri} must be a function`);
    }
    if (this.#templates.has(uri)) fail(`${uri} is already registered`);
    const clash = [...this.#templates.values()].find((t) => t.name === template.name);
    if (clash)
      fail(`${uri}: there is already a template named ${template.name} (${clash.uriTemplate})`);
    this.#templates.set(uri, template);
  }

  /** After the event: later registrations throw. */
  close(): void {
    this.#closed = true;
  }

  /** Fixed resources, sorted by URI. */
  fixed(): FixedResource[] {
    return [...this.#fixed.values()].sort((a, b) => compareText(a.uri, b.uri));
  }

  /** Templates, sorted by URI template. */
  templates(): TemplateResource[] {
    return [...this.#templates.values()].sort((a, b) => compareText(a.uriTemplate, b.uriTemplate));
  }

  #open(): void {
    if (this.#closed) fail("resources cannot be registered after the mcp:resources event");
  }

  /** What fixed resources and templates share: scheme, name, MIME type and read. */
  #check(uri: string, entry: { name?: unknown; mimeType?: unknown; read?: unknown }): void {
    const scheme = SCHEME.exec(uri)?.[1]?.toLowerCase();
    if (scheme && RESERVED.has(scheme))
      fail(`${uri}: the ${scheme} scheme is reserved for cap-mcp`);
    if (typeof entry.name !== "string" || !entry.name) fail(`${uri} needs a name`);
    if (typeof entry.mimeType !== "string" || !entry.mimeType) fail(`${uri} needs a mimeType`);
    if (typeof entry.read !== "function") fail(`read of ${uri} must be a function`);
  }
}

/**
 * Startup: let `mcp:resources` listeners register (synchronously, during the emit), then close
 * the registry. Emitted whether or not the app has other resources, so listeners can rely on it.
 */
export function setUpResources(emit: (registry: ResourceRegistry) => void): RegisteredResources {
  const resources = new RegisteredResources();
  try {
    emit(resources);
  } finally {
    resources.close();
  }
  return resources;
}

/**
 * The fixed resources this caller may see: no `visible`, or `visible(ctx)` is true. A `visible`
 * that throws hides its resource for this request; `onError` reports it.
 */
export function visibleFixed(
  resources: RegisteredResources,
  ctx: ResourceContext,
  onError: (uri: string, error: unknown) => void,
): FixedResource[] {
  return resources.fixed().filter((resource) => {
    if (!resource.visible) return true;
    try {
      return resource.visible(ctx) === true;
    } catch (error) {
      onError(resource.uri, error);
      return false;
    }
  });
}

/** A registrant's way to say "no such resource": status or statusCode 404, or code NOT_FOUND. */
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, statusCode, code } = error as Record<string, unknown>;
  return Number(status) === 404 || Number(statusCode) === 404 || code === "NOT_FOUND";
}
