import cds from "@sap/cds";
import { Executor, type ServiceLike, type ToolResult } from "../../src/executor";
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
  options: { confirmed?: boolean } = {},
): Promise<ToolResult> {
  const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
  const user = demoUser(who);
  const tool = registry.toolsFor(user).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not listed for ${who}`);
  const service = cds.services[name.split("_")[0] ?? ""] as unknown as ServiceLike;
  const executor = new Executor(registry.spec);
  return cds.tx({ user }, () => executor.execute(tool, args, service, user, options));
}

export type Page = { rows: Record<string, unknown>[]; total: number; nextCursor?: string };
export const page = (result: ToolResult) => result.structuredContent as Page;
