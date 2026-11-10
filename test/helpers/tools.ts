import cds from "@sap/cds";
import { Executor, errorResult, type ServiceLike, type ToolResult } from "../../src/executor";
import { ExposureRegistry } from "../../src/exposure-registry";
import type { DemoUser } from "./demo";

/** Roles of the mocked demo users (demo/package.json). */
export const ROLES: Record<DemoUser, string[]> = { alice: ["admin"], bob: [], carol: ["support"] };

export function demoUser(who: DemoUser): cds.User {
  return new cds.User({ id: who, roles: ROLES[who], attr: {} });
}

/**
 * Call a tool the way the adapter will (M4): pick it from the caller's tool list, then run the
 * executor inside a transaction for that user, against the real CAP service. Needs the demo
 * booted in the calling test file (bootDemo()).
 */
export async function callTool(
  who: DemoUser,
  name: string,
  args: Record<string, unknown> = {},
  options: { confirmed?: boolean; listedFor?: DemoUser } = {},
): Promise<ToolResult> {
  const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
  const user = demoUser(who);
  // listedFor: take the tool from another user's list, to prove CAP refuses the call itself.
  const lister = options.listedFor ? demoUser(options.listedFor) : user;
  const tool = registry.toolsFor(lister).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not listed for ${options.listedFor ?? who}`);
  const service = cds.services[name.split("_")[0] ?? ""] as cds.Service;
  const executor = new Executor(registry.spec);
  try {
    // The service's own root transaction, as CAP's protocol adapters (and our adapter in M4)
    // use. (cds.tx is the database's: with it, a failing draft SAVE never releases the pool.)
    return await service.tx({ user }, (tx: cds.Transaction) =>
      executor.execute(tool, args, tx as unknown as ServiceLike, user, {
        confirmed: options.confirmed,
      }),
    );
  } catch (error) {
    // As the adapter will: the transaction has rolled back; tell the agent what went wrong.
    const result = errorResult(error);
    if (result) return result;
    throw error;
  }
}

export type Page = { rows: Record<string, unknown>[]; total: number; nextCursor?: string };
export const page = (result: ToolResult) => result.structuredContent as Page;
