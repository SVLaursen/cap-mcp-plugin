import { elicitationSchema } from "../schema-mapper";
import type { EntitySpec, OperationSpec } from "../types";
import { isObject } from "../util";
import { allowOnly, keyOf, project, value, type Args } from "./arguments";
import { ConfirmationRequired, ToolError } from "./errors";
import type { CallOptions, ServiceLike } from "./index";
import { result, type ToolResult } from "./results";

/**
 * An operation through srv.send, so the app's `on` handler runs: unbound with its parameters
 * as req.data, bound with the instance key in req.params (as OData does). @mcp.elicit
 * operations only run once the user confirmed the call.
 */
export async function callOperation(
  op: OperationSpec,
  bound: EntitySpec | undefined,
  args: Args,
  service: ServiceLike,
  options: CallOptions,
): Promise<ToolResult> {
  const keyNames = bound?.keys.map((k) => k.name) ?? [];
  if (options.confirmed && options.confirmedArgs) {
    // The user's answers to the confirmation form win over the agent's values, for the fields
    // the form had (parameters a form cannot hold keep the agent's value).
    const asked = Object.keys(elicitationSchema(op, args).properties ?? {});
    const answers = Object.entries(options.confirmedArgs).filter(([k]) => asked.includes(k));
    args = { ...args, ...Object.fromEntries(answers) };
  }
  allowOnly(args, [...keyNames, ...op.params.map((p) => p.name)]);
  const data = parameters(op, args);
  if (op.elicit?.length && !options.confirmed) {
    const key = bound ? ` for ${JSON.stringify(project(args, keyNames))}` : "";
    const given = Object.keys(data).length ? ` with ${JSON.stringify(data)}` : "";
    throw new ConfirmationRequired(`${op.title} needs the user's confirmation before it runs`, {
      message: `Confirm ${op.title}${key}${given}?`,
      requestedSchema: elicitationSchema(op, data),
    });
  }
  const event = op.name.slice(op.name.lastIndexOf(".") + 1);
  const returned = bound
    ? await service.send({
        event,
        entity: bound.name,
        data,
        // The key alone addresses the active record (CAP rejects IsActiveEntity here).
        params: [keyOf(bound, project(args, keyNames))],
      })
    : await service.send({ event, data });
  if (!op.returns) return { text: `${op.title} done` };
  const fields = op.returns.fields?.map((f) => f.name);
  // Only the fields the return type exposes (no @mcp.omit ones the handler happened to read).
  const shape = (item: unknown) => (fields && isObject(item) ? project(item, fields) : item);
  if (!op.returns.many) {
    // A handler bug, not the agent's: fail the call (logged, rolled back) and pass nothing on.
    if (Array.isArray(returned)) {
      const type = op.returns.entity ?? "record";
      throw new Error(`${op.name} returned a list, but its return type is a single ${type}`);
    }
    return result({ value: shape(returned ?? null) });
  }
  // A list operation whose handler returns nothing returned an empty list (the schema says array).
  return result({ value: (Array.isArray(returned) ? returned : []).map(shape) });
}

/** The operation's parameters from `args`, each checked against its type (req.data). */
function parameters(op: OperationSpec, args: Args): Args {
  const data: Args = {};
  for (const param of op.params) {
    const given = args[param.name];
    if (given === undefined || (given === null && !param.mandatory)) continue;
    if (param.many) {
      if (!Array.isArray(given))
        throw new ToolError("INVALID_ARGUMENT", `${param.name} must be an array`, param.name);
      given.forEach((item, i) => value(param, item, `${param.name}[${i}]`));
    } else value(param, given, param.name);
    data[param.name] = given;
  }
  return data;
}
