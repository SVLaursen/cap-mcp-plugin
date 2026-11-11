import type { ExposureRegistry } from "../exposure-registry";
import type { Diagnostic, FieldSpec, UserLike } from "../types";

/**
 * Startup exposure report: "serving N tools, M resources, P prompts at /mcp" plus every
 * Diagnostic from the model reader and the registry.
 */

export interface ReportLine {
  level: Diagnostic["level"];
  text: string;
}

/** Counts what the app exposes to anyone: a user with every role sees every tool. */
const EVERYONE: UserLike = { id: "startup-report", is: () => true };
const ORDER: Record<Diagnostic["level"], number> = { error: 0, warn: 1, info: 2 };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the plugin logs once CAP has served the app: a summary, then every diagnostic. */
export function exposureReport(
  registry: ExposureRegistry,
  path: string,
  configDiagnostics: Diagnostic[] = [],
): ReportLine[] {
  const summary = [
    count(registry.toolsFor(EVERYONE).length, "tool"),
    count(registry.resourcesFor(EVERYONE).length, "resource"),
    count(registry.promptsFor(EVERYONE).length, "prompt"),
  ].join(", ");
  const diagnostics = [...configDiagnostics, ...registry.diagnostics]
    .sort((a, b) => ORDER[a.level] - ORDER[b.level])
    .map((d) => ({ level: d.level, text: `${d.code} ${d.target}: ${d.message}` }));
  return [{ level: "info", text: `serving ${summary} at ${path}` }, ...diagnostics];
}

/** The slice of a CSN definition the doc-comment check reads. */
interface DocDefinition {
  doc?: string;
  elements?: Record<string, DocDefinition>;
  actions?: Record<string, DocDefinition>;
  params?: Record<string, DocDefinition>;
}

/**
 * ADR 0011: doc comments reach the model only with `cdsc.docs`. Given the same model compiled
 * with doc comments, name the exposed definitions whose doc comment the served model lost (they
 * have no other description), and say how to turn it on. Undefined when there are none.
 */
export function docCommentHint(
  registry: ExposureRegistry,
  docs: { definitions?: Record<string, DocDefinition> },
): ReportLine | undefined {
  const defs = docs.definitions ?? {};
  const lost: string[] = [];
  const check = (target: string, description: string | undefined, def?: DocDefinition) => {
    if (description === undefined && def?.doc) lost.push(target);
  };
  const fields = (owner: string, specs: FieldSpec[], els?: Record<string, DocDefinition>) => {
    for (const f of specs) check(`${owner}:${f.name}`, f.description, els?.[f.name]);
  };
  for (const service of registry.spec.services) {
    check(service.name, service.description, defs[service.name]);
    for (const entity of service.entities) {
      check(entity.name, entity.description, defs[entity.name]);
      fields(entity.name, entity.fields, defs[entity.name]?.elements);
    }
    for (const op of service.operations) {
      const def = op.boundTo
        ? defs[op.boundTo]?.actions?.[op.name.slice(op.boundTo.length + 1)]
        : defs[op.name];
      check(op.name, op.description, def);
      fields(op.name, op.params, def?.params);
    }
  }
  if (lost.length === 0) return undefined;
  return {
    level: "info",
    text:
      `${count(lost.length, "exposed definition")} ${lost.length === 1 ? "has a doc comment" : "have doc comments"} ` +
      `that MCP does not see (${lost.join(", ")}): set "cdsc": { "docs": true } in the app's cds config ` +
      "to use them as descriptions (this also adds them to the OData $metadata, see ADR 0011)",
  };
}
