import cds from "@sap/cds";
import { Executor, errorResult, type ServiceLike, type ToolResult } from "../../src/executor";
import { ExposureRegistry } from "../../src/exposure-registry";
import { currentDemo, type DemoUser } from "./demo";
import { callTool as rpcCallTool, type RpcOptions } from "./mcp";

/** Roles of the mocked demo users (demo/package.json). */
export const ROLES: Record<DemoUser, string[]> = { alice: ["admin"], bob: [], carol: ["support"] };

export function demoUser(who: DemoUser): cds.User {
  return new cds.User({ id: who, roles: ROLES[who], attr: {} });
}

type Content = { type: string; text?: string; uri?: string; name?: string };

/**
 * Call a tool over /mcp as a demo user, like an MCP client, and return the tool result in the
 * executor's shape. A JSON-RPC error (an unknown tool, a bad request) is thrown, with its code.
 * Needs the demo booted in the calling test file (bootDemo()).
 */
export async function callTool(
  who: DemoUser,
  name: string,
  args: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<ToolResult> {
  const res = await rpcCallTool(currentDemo().POST, who, name, args, options);
  const message = res.message;
  if (!message) throw new Error(`HTTP ${res.status} without a JSON-RPC response`);
  if (message.error) throw new Error(`${message.error.code} ${message.error.message}`);
  const result = message.result as {
    content: Content[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text);
  const links = result.content
    .filter((c) => c.type === "resource_link")
    .map(({ uri, name }) => ({ uri: uri as string, name: name as string }));
  return {
    text: text.join("\n"),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
    ...(result.isError ? { isError: true } : {}),
    ...(links.length ? { links } : {}),
  };
}

/**
 * Run the executor directly, as the adapter does, for what /mcp cannot do (yet): call a tool that
 * is not in the caller's list (`listedFor` takes it from another user's list, to prove CAP
 * refuses the call itself), or a confirmed @mcp.elicit call (MRTR confirmation is M5).
 */
export async function executeDirectly(
  who: DemoUser,
  name: string,
  args: Record<string, unknown> = {},
  options: { confirmed?: boolean; listedFor?: DemoUser } = {},
): Promise<ToolResult> {
  const registry = ExposureRegistry.fromModel(cds.model as unknown as object);
  const user = demoUser(who);
  const lister = options.listedFor ? demoUser(options.listedFor) : user;
  const tool = registry.toolsFor(lister).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not listed for ${options.listedFor ?? who}`);
  const service = cds.services[name.split("_")[0] ?? ""] as cds.Service;
  const executor = new Executor(registry.spec);
  try {
    return await service.tx({ user }, (tx: cds.Transaction) =>
      executor.execute(tool, args, tx as unknown as ServiceLike, user, {
        confirmed: options.confirmed,
      }),
    );
  } catch (error) {
    const result = errorResult(error);
    if (result) return result;
    throw error;
  }
}

/**
 * A bad argument, refused before anything ran: by the SDK's input-schema check (a text-only
 * tool error), or by the executor's own check (INVALID_ARGUMENT, e.g. for compact tools, whose
 * schemas are open, or a cursor the schema cannot judge).
 */
export function expectInvalidArgument(result: ToolResult): void {
  expect(result.isError).toBe(true);
  if (result.structuredContent === undefined) {
    expect(result.text).toMatch(/^Input validation error: Invalid arguments for tool /);
  } else {
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    });
  }
}

export type Page = { rows: Record<string, unknown>[]; total: number; nextCursor?: string };
export const page = (result: ToolResult) => result.structuredContent as Page;
