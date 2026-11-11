import type {
  EntitySpec,
  ModelReadResult,
  OperationSpec,
  PromptSpec,
  ServiceSpec,
  V1Options,
} from "../types";
import {
  type Definition,
  type Csn,
  type Context,
  isExcluded,
  isGenerated,
  isAddressable,
  invalid,
  roles,
  str,
  title,
  describe,
  restrictRoles,
} from "./definitions";
import { checkV1Defaults } from "./v1";
import { isOwnOptIn, exposesOperation } from "./opt-in";
import { checkUnused, checkAnnotations } from "./checks";
import { readEntity } from "./entities";
import { readOperation } from "./operations";

/**
 * model-reader
 *
 * Turns a compiled, linked CSN plus @mcp annotations into an ExposureSpec.
 *
 * Contract (see docs/annotations.md for the full annotation spec):
 * - Pure: no I/O, no global state, no `cds` runtime. Input is CSN, output is data.
 * - Opt-in: a definition with no @mcp annotation (directly or via its service) produces nothing.
 * - `@mcp` on a service gives the read-only baseline: query + get for every entity, plus all
 *   functions. Actions, writes, resources, prompts, UI, elicit, completion, describe and
 *   compact each need their own annotation.
 * - `@mcp: false` or `@cds.api.ignore` removes an entity/element.
 * - `@mcp.omit` elements never appear in any FieldSpec.
 * - Titles/descriptions fall back: @mcp.description → @description → doc comment → @title → name.
 * - Doc comments are read from CSN `doc`, present only when the app compiles with
 *   `cds.env.cdsc.docs = true`. The plugin never sets that for the app (ADR 0011).
 * - Unknown `@mcp.*` keys produce an UNKNOWN_ANNOTATION diagnostic, never a silent no-op.
 * - v1 annotations that changed meaning produce V1_ANNOTATION diagnostics.
 *
 * Files: entities.ts and operations.ts read those definitions, fields.ts their elements,
 * opt-in.ts decides what is exposed, checks.ts reports annotation problems, v1.ts is the v1
 * shim, and definitions.ts holds the CSN shapes and small readers they share.
 */

export interface ReadOptions {
  /** What a v1 app's config said (v1 shim); only used for V1_DEFAULT_CHANGED. */
  v1?: V1Options;
}

export function readModel(csn: unknown, options: ReadOptions = {}): ModelReadResult {
  const ctx: Context = {
    definitions: (csn as Csn).definitions ?? {},
    diagnostics: [],
    v1: options.v1 ?? {},
  };
  checkAnnotations(ctx);
  const services = Object.entries(ctx.definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name, def]) => readService(name, def, ctx))
    .filter((s): s is ServiceSpec => s !== undefined);
  checkUnused(ctx, services);
  checkV1Defaults(ctx, services);
  return { spec: { services }, diagnostics: ctx.diagnostics };
}

function readService(service: string, def: Definition, ctx: Context): ServiceSpec | undefined {
  if (isExcluded(def)) return undefined;
  const optedIn = def["@mcp"] === true;
  const entities: EntitySpec[] = [];
  const operations: OperationSpec[] = [];

  for (const [name, member] of Object.entries(ctx.definitions)) {
    if (!name.startsWith(`${service}.`) || isExcluded(member)) continue;
    if (member.kind === "entity") {
      // CAP-generated entities are not baseline, but an explicit @mcp on one still counts.
      const generated = isGenerated(name, member, ctx.definitions);
      const ownOptIn = isOwnOptIn(member, ctx);
      if (generated && !ownOptIn) continue;
      // Outside an @mcp service, only an @mcp written here counts, not one CAP copied in.
      if (optedIn || ownOptIn) entities.push(readEntity(name, service, member, ctx, optedIn));
      const addressable = isAddressable(member);
      for (const [action, op] of Object.entries(member.actions ?? {})) {
        if (!exposesOperation(op, optedIn)) continue;
        if (!addressable) {
          ctx.diagnostics.push({
            level: "error",
            code: "BOUND_OPERATION_WITHOUT_KEYS",
            target: `${name}.${action}`,
            message: `${name} has no exposed keys, so its bound operation ${action} cannot address an instance; not exposed`,
          });
          continue;
        }
        const keys = Object.entries(member.elements ?? {}).filter(([, el]) => el.key);
        const clash = keys.find(([key]) => key in (op.params ?? {}));
        if (clash) {
          ctx.diagnostics.push({
            level: "error",
            code: "PARAMETER_SHADOWS_KEY",
            target: `${name}.${action}:${clash[0]}`,
            message: `Parameter ${clash[0]} of ${action} has the name of a key of ${name}; the tool could not tell them apart. Not exposed`,
          });
          continue;
        }
        operations.push(readOperation(`${name}.${action}`, service, op, ctx, name));
      }
    } else if (member.kind === "function" || member.kind === "action") {
      if (exposesOperation(member, optedIn)) {
        operations.push(readOperation(name, service, member, ctx));
      }
    }
  }

  if (!optedIn && entities.length === 0 && operations.length === 0) return undefined;
  return {
    name: service,
    title: title(service, def),
    description: describe(def),
    requires: roles(def) ?? restrictRoles(def),
    compact: def["@mcp.compact"] === true,
    describe: def["@mcp.describe"] === true,
    entities,
    operations,
    prompts: readPrompts(service, def, ctx),
  };
}

function readPrompts(service: string, def: Definition, ctx: Context): PromptSpec[] {
  const prompts = def["@mcp.prompts"];
  if (prompts === undefined) return [];
  if (!Array.isArray(prompts)) {
    invalid(ctx, service, "@mcp.prompts must be a list of prompt objects");
    return [];
  }
  return prompts.flatMap((prompt: Record<string, unknown>) => {
    const name = str(prompt.name);
    const template = str(prompt.template);
    const role = prompt.role ?? "user";
    if (!name || !template || (role !== "user" && role !== "assistant")) {
      invalid(
        ctx,
        service,
        `@mcp.prompts entry ${JSON.stringify(prompt.name ?? null)} needs a name, a template and role 'user' or 'assistant'`,
      );
      return [];
    }
    return [
      {
        name,
        service,
        title: str(prompt.title),
        description: str(prompt.description),
        template,
        role,
        inputs: Array.isArray(prompt.inputs)
          ? prompt.inputs.map((input: Record<string, unknown>) => ({
              key: str(input.key) ?? "",
              type: str(input.type) ?? "",
            }))
          : [],
      },
    ];
  });
}
