/**
 * Hints from code (ADR 0014): what app code and other plugins register through the `mcp:hints`
 * event. Text for the server's instructions, and short notes for the descriptions of the tools
 * this plugin generates, asked for on every request as the caller. The sibling of `mcp:apps`
 * and `mcp:resources`; this file holds the registry, its rules, and the per-request calls.
 */

/** Who is asking: from the request's cds.context. */
export interface HintContext {
  /** cds.context.user (a cds.User). */
  user: unknown;
  tenant?: string;
  locale?: string;
}

/** A generated tool, as a notes provider sees it. */
export interface ToolTarget {
  /** The MCP tool name, e.g. "CatalogService_Books_query". */
  tool: string;
  /** Fully qualified CDS service name. */
  service: string;
  /** Fully qualified CDS name of the entity, action or function behind the tool. */
  definition: string;
  kind: "entity" | "action" | "function";
}

/** Text for the MCP server's `instructions`. */
export interface InstructionsProvider {
  /** Unique among instructions providers. */
  id: string;
  text(ctx: HintContext): string | undefined | Promise<string | undefined>;
}

/** Short notes for the descriptions of generated tools. */
export interface ToolNotesProvider {
  /** Unique among tool notes providers. */
  id: string;
  /** Called once per generated tool, per request. Return undefined for "nothing to add". */
  note(target: ToolTarget, ctx: HintContext): string | undefined | Promise<string | undefined>;
}

/** What the `mcp:hints` event hands to listeners. */
export interface HintRegistry {
  readonly contractVersion: 1;
  /** Text added to the MCP server's `instructions` (initialize and server/discover). */
  addInstructions(provider: InstructionsProvider): void;
  /** Short notes added to the descriptions of generated tools. */
  addToolNotes(provider: ToolNotesProvider): void;
}

/** The most a provider adds: instructions per provider, and each tool note. */
export const MAX_INSTRUCTIONS = 1500;
export const MAX_NOTE = 400;

const fail = (message: string): never => {
  throw new Error(`cap-mcp: ${message}`);
};

export class RegisteredHints implements HintRegistry {
  readonly contractVersion = 1 as const;
  readonly #instructions = new Map<string, InstructionsProvider>();
  readonly #notes = new Map<string, ToolNotesProvider>();
  #closed = false;

  addInstructions(provider: InstructionsProvider): void {
    this.#add(this.#instructions, provider, "text", "an instructions provider");
  }

  addToolNotes(provider: ToolNotesProvider): void {
    this.#add(this.#notes, provider, "note", "a tool notes provider");
  }

  /** After the event: later registrations throw. */
  close(): void {
    this.#closed = true;
  }

  /** Instructions providers, in registration order. */
  instructions(): InstructionsProvider[] {
    return [...this.#instructions.values()];
  }

  /** Tool notes providers, in registration order. */
  toolNotes(): ToolNotesProvider[] {
    return [...this.#notes.values()];
  }

  #add<P extends { id: string }>(
    providers: Map<string, P>,
    provider: P,
    method: "text" | "note",
    what: string,
  ): void {
    if (this.#closed) fail("hints cannot be added after the mcp:hints event");
    const id = provider?.id;
    if (typeof id !== "string" || !id) fail(`${what} needs an id, got ${String(id)}`);
    if (typeof (provider as Record<string, unknown>)[method] !== "function")
      fail(`${method} of ${id} must be a function`);
    if (providers.has(id)) fail(`${what} with id ${id} is already registered`);
    providers.set(id, provider);
  }
}

/**
 * Startup: let `mcp:hints` listeners register (synchronously, during the emit), then close the
 * registry. Emitted whether or not anything else is configured, so listeners can rely on it.
 */
export function setUpHints(emit: (registry: HintRegistry) => void): RegisteredHints {
  const hints = new RegisteredHints();
  try {
    emit(hints);
  } finally {
    hints.close();
  }
  return hints;
}

/** Where a provider's problems go: errors per request, a cut text once per provider. */
export interface HintLog {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * One provider's answer, as text to add: trimmed, cut at `max` characters, or undefined for
 * nothing. A throw, a rejection or a non-text answer is logged and adds nothing; its message
 * stays in the log.
 */
async function ask(
  call: () => string | undefined | Promise<string | undefined>,
  what: string,
  max: number,
  log: HintLog,
  warnOnce: (key: string, message: string) => void,
): Promise<string | undefined> {
  let answer: unknown;
  try {
    answer = await call();
  } catch (error) {
    log.error(`cap-mcp: ${what} failed; skipped for this request:`, error);
    return undefined;
  }
  if (answer === undefined || answer === null) return undefined;
  if (typeof answer !== "string") {
    log.error(`cap-mcp: ${what} returned ${typeof answer}, not text; skipped for this request`);
    return undefined;
  }
  const text = answer.trim();
  const chars = [...text];
  if (chars.length <= max) return text || undefined;
  warnOnce(what, `cap-mcp: ${what} gave more than ${max} characters; cut to ${max}`);
  return chars.slice(0, max).join("").trimEnd();
}

/**
 * Per activation: the per-request calls, and the warnings that are logged only once (a provider
 * that gives too much text gives it on every request).
 */
export function hintsFor(hints: RegisteredHints, log: HintLog) {
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message);
  };
  return {
    /** Whether any provider is registered: without one, nothing changes (and nothing is awaited). */
    active: hints.instructions().length > 0 || hints.toolNotes().length > 0,

    /**
     * The server's instructions for this caller: the app's own, then each provider's text, a
     * blank line apart, in registration order. With nothing added, the app's own, untouched.
     */
    async instructions(base: string | undefined, ctx: HintContext): Promise<string | undefined> {
      const texts = await Promise.all(
        hints
          .instructions()
          .map((p) =>
            ask(
              () => p.text(ctx),
              `instructions provider ${p.id}`,
              MAX_INSTRUCTIONS,
              log,
              warnOnce,
            ),
          ),
      );
      const added = texts.filter((t): t is string => !!t);
      if (added.length === 0) return base;
      return [base?.trim(), ...added].filter((t) => !!t).join("\n\n");
    },

    /** The notes for each target this caller gets, by tool name; tools without notes are absent. */
    async notes(targets: ToolTarget[], ctx: HintContext): Promise<Map<string, string[]>> {
      const providers = hints.toolNotes();
      const notes = new Map<string, string[]>();
      if (providers.length === 0) return notes;
      await Promise.all(
        targets.map(async (target) => {
          const each = await Promise.all(
            providers.map((p) =>
              ask(
                () => p.note(target, ctx),
                `tool notes provider ${p.id}`,
                MAX_NOTE,
                log,
                warnOnce,
              ),
            ),
          );
          const added = each.filter((t): t is string => !!t);
          if (added.length) notes.set(target.tool, added);
        }),
      );
      return notes;
    },
  };
}

/** A tool's description with its notes, each as its own paragraph after the existing text. */
export function withNotes(description: string, notes: string[] | undefined): string {
  if (!notes?.length) return description;
  return [description, ...notes].filter((t) => !!t).join("\n\n");
}
