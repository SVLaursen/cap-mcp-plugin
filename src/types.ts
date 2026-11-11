/**
 * Shared shapes that flow between the v2 modules.
 *
 *   model-reader  ──ExposureSpec──▶  exposure-registry  ──ToolSpec[]──▶  adapter
 *                                                       ──ToolCall────▶  executor
 *
 * These types ARE the contract between modules. Change them deliberately, test-first,
 * and update docs/architecture.md in the same commit.
 */

/** Entity-level capabilities an MCP client can be given. `query` and `get` are baseline. */
export type EntityMode = "query" | "get" | "create" | "update" | "delete";

/** A scalar or structured element as the agent sees it. Never contains @mcp.omit fields. */
export interface FieldSpec {
  name: string;
  /** Resolved CDS builtin, e.g. "cds.String", "cds.Integer", "cds.Decimal". */
  cdsType: string;
  /** `array of <cdsType>` (operation parameters). */
  many?: true;
  key: boolean;
  /** From @mandatory / not null. Required on input. */
  mandatory: boolean;
  /** From not null: the value is never null in output (@mandatory is only checked on input). */
  notNull?: true;
  /** From @readonly, @Core.Computed, or the projection. Never accepted as input. */
  readonly: boolean;
  description?: string;
  enum?: ReadonlyArray<string | number>;
  length?: number;
  precision?: number;
  scale?: number;
  /** From @assert.range: [min, max]. */
  range?: readonly [number | undefined, number | undefined];
  /** Association/composition target (fully qualified), when this is a managed FK or nav. */
  target?: string;
  /** For a managed foreign key: the association it belongs to (author_ID → author). */
  association?: string;
  /** Opted in with @mcp.completion. */
  completion: boolean;
}

/** One @restrict grant, normalized as CAP does: a single event (or `*`) and its roles. */
export interface GrantSpec {
  /** READ, CREATE, UPDATE, DELETE, `*`, or an operation's local name. */
  grant: string;
  /** Roles; `any` when the grant has no `to`. */
  to: string[];
}

export interface DeepInsertSpec {
  /** The composition element. */
  element: string;
  /** Fully qualified target entity. */
  target: string;
  /** Composition of many (an array) or of one (an object). */
  many: boolean;
  /** The child's association back to the parent (from the on-condition), which CAP fills. */
  backlink?: string;
}

export interface EntitySpec {
  /** Fully qualified, e.g. "CatalogService.Books". */
  name: string;
  service: string;
  title: string;
  description?: string;
  keys: FieldSpec[];
  fields: FieldSpec[];
  modes: ReadonlySet<EntityMode>;
  /** Opted in with @mcp.resource: one record by key at cap://<Service>/<Entity>/<key>. */
  resource: boolean;
  /** @odata.draft.enabled, or a composition inside such an entity. Writes must go through the draft API (or be refused). */
  draft: boolean;
  /** The root of a draft (@odata.draft.enabled itself); writes to its children go through it. */
  draftRoot?: true;
  /** Compositions opted in with @mcp.deepInsert. */
  deepInsert: DeepInsertSpec[];
  /** @requires on the entity (or its composition ancestor), if any. Only hides tools; CAP enforces. */
  requires?: string[];
  /** @restrict grants (own or a composition ancestor's), if any. Only hides tools; CAP enforces. */
  restrict?: GrantSpec[];
  /**
   * Columns `q` searches: CAP's @cds.search rules, minus @mcp.omit fields. Paths for
   * associations ("author.name"). Empty → no `q`. The executor passes these to CAP explicitly.
   */
  search: string[];
}

export interface OperationSpec {
  /** Fully qualified, e.g. "CatalogService.submitOrder" or "OrdersService.Orders.cancel". */
  name: string;
  service: string;
  kind: "function" | "action";
  /** @mcp.name → @title → the fully qualified name. */
  title: string;
  /** Fully qualified entity for bound operations. */
  boundTo?: string;
  description?: string;
  params: FieldSpec[];
  /** The CDS return type, if any. Drives outputSchema. */
  returns?: ReturnSpec;
  /** @requires on the operation, if any. Used only to hide tools; CAP still enforces. */
  requires?: string[];
  /** The operation's own @restrict grants (grant is its local name), if any. */
  restrict?: GrantSpec[];
  /** Opted in with @mcp.elicit. */
  elicit?: string[];
  /** Opted in with @mcp.ui (MCP Apps, issue #133): a ui:// resource URI. */
  ui?: string;
}

/** An operation's return type: one scalar, or records (an entity or an inline structure). */
export interface ReturnSpec {
  /** `array of` / `many`. */
  many: boolean;
  /** Scalar return: its builtin type, as a FieldSpec named "value". */
  scalar?: FieldSpec;
  /** Structured return: its fields, never with @mcp.omit ones. */
  fields?: FieldSpec[];
  /** Fully qualified entity, when the return type is one. */
  entity?: string;
}

export interface PromptSpec {
  name: string;
  service: string;
  title?: string;
  description?: string;
  template: string;
  role: "user" | "assistant";
  inputs: { key: string; type: string }[];
}

export interface ServiceSpec {
  name: string;
  title: string;
  description?: string;
  /**
   * Roles CAP's protocol check demands: @requires, else every `to` of the service's @restrict.
   * Used only to hide tools; CAP still enforces.
   */
  requires?: string[];
  /** Opted in with @mcp.compact. */
  compact: boolean;
  /** Opted in with @mcp.describe. */
  describe: boolean;
  entities: EntitySpec[];
  operations: OperationSpec[];
  prompts: PromptSpec[];
}

export interface ExposureSpec {
  services: ServiceSpec[];
}

export type DiagnosticCode =
  | "UNKNOWN_ANNOTATION"
  | "INVALID_ANNOTATION_VALUE"
  | "BOUND_OPERATION_WITHOUT_KEYS"
  /** An @mcp.* feature annotation on a definition that is not exposed, so it has no effect. */
  | "UNUSED_ANNOTATION"
  /** Two tools would get the same name (also across services); both are left out. */
  | "TOOL_NAME_CLASH"
  /** Two services' @mcp.prompts use the same name; neither prompt is exposed. */
  | "PROMPT_NAME_CLASH"
  /** A tool name outside MCP's [A-Za-z0-9._-]{1,128}; the tool is left out. */
  | "INVALID_TOOL_NAME"
  /** A tool name over 64 characters, which some LLM tool APIs reject; still exposed. */
  | "LONG_TOOL_NAME"
  /** A bound operation parameter with the name of one of its entity's keys. */
  | "PARAMETER_SHADOWS_KEY"
  /** An element or parameter type with no JSON Schema mapping; agents see it as "any value". */
  | "UNSUPPORTED_TYPE"
  /** @mcp.omit on a key element: the entity's get tool cannot address records. */
  | "OMITTED_KEY"
  | "DRAFT_WRITE_NOT_SUPPORTED"
  | "V1_ANNOTATION"
  | "V1_DEFAULT_CHANGED";

/** Reported at startup so developers see why something is (not) exposed. */
export interface Diagnostic {
  level: "info" | "warn" | "error";
  code: DiagnosticCode;
  /** The CSN definition (and element) the diagnostic is about; a tool name for tool diagnostics. */
  target: string;
  message: string;
}

export interface ModelReadResult {
  spec: ExposureSpec;
  diagnostics: Diagnostic[];
}

/** JSON Schema 2020-12 object, as MCP 2026-07-28 accepts for inputSchema / outputSchema. */
export type JsonSchema = Record<string, unknown>;

/** The generic tools of an @mcp.compact service; the entity or operation is an argument. */
export type CompactAction =
  | "list_entities"
  | "describe_entity"
  | "query"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "call_operation";

/** What tools/list publishes for one tool. */
export interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  /** Tool `_meta`, e.g. the MCP Apps UI resource for @mcp.ui operations. */
  _meta?: Record<string, unknown>;
  /** Back-reference used by the executor. */
  target:
    | { kind: "entity"; entity: string; mode: EntityMode }
    | { kind: "operation"; operation: string }
    | { kind: "describe"; service: string }
    | { kind: "compact"; service: string; action: CompactAction };
}

/**
 * What resources/templates/list publishes for one @mcp.resource entity: single records by key
 * (ADR 0006). There is no list of records: resources/list never enumerates tables.
 */
export interface ResourceSpec {
  /** `cap://<Service>/<Entity>/{key}`; composite keys as `k1=v1;k2=v2`. */
  uriTemplate: string;
  /** `<Service>_<Entity>`, like tool names. */
  name: string;
  title: string;
  description?: string;
  mimeType: "application/json";
  /** Fully qualified entity. */
  entity: string;
  /** The single key has @mcp.completion: `completion/complete` offers values for `{key}`. */
  completion: boolean;
}

/** The roles/identity the registry filters by. A structural subset of cds.User. */
export interface UserLike {
  id: string;
  is(role: string): boolean;
}
