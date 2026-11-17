import express from "express";
import { activate, type CdsLike } from "../../src/index";
import { compileSnippet } from "../helpers/snippet";

/**
 * M6 review — the startup doc-comment check (ADR 0011) runs beside startup, never in its way.
 * A minimal stand-in for the `cds` facade: activate() receives it (ADR 0005), no CAP mock.
 */
function fakeCds(
  env: { profiles?: string[] } = {},
  emit: (event: string, ...args: unknown[]) => unknown = () => undefined,
) {
  const listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const loads: unknown[] = [];
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const cds = {
    on: (event: string, fn: (...args: unknown[]) => unknown) => (listeners[event] ??= []).push(fn),
    emit,
    log: () => log,
    app: express(),
    root: __dirname,
    model: compileSnippet(`@mcp service S { entity Books { key ID: Integer; } }`, { docs: false }),
    services: {},
    middlewares: { before: [] },
    requires: {},
    env: { mcp: undefined, cdsc: {}, ...env },
    i18n: { messages: { at: () => undefined } },
    // A recompile that never finishes.
    load: (...args: unknown[]) => {
      loads.push(args);
      return new Promise(() => {});
    },
  };
  activate(cds as unknown as CdsLike);
  const served = () => Promise.all((listeners.served ?? []).map((fn) => fn()));
  return { served, loads };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);

test("startup does not wait for the doc-comment recompile", async () => {
  const { served, loads } = fakeCds();
  await expect(within(served(), 500)).resolves.toBeDefined();
  expect(loads).toHaveLength(1);
});

test("in CAP's production profile there is no recompile", async () => {
  const { served, loads } = fakeCds({ profiles: ["production"] });
  await served();
  expect(loads).toHaveLength(0);
});

// ADR 0013: other plugins rely on the event, so it comes once, after mcp:apps, even when the app
// has nothing else to serve as a resource, and the registry is closed when it returns.
test("mcp:resources is emitted once, after mcp:apps, with an open registry that closes after", async () => {
  const events: [string, unknown][] = [];
  let lateRegister: (() => void) | undefined;
  const { served } = fakeCds({}, (event, registry) => {
    events.push([event, registry]);
    if (event !== "mcp:resources") return;
    const resources = registry as {
      contractVersion: number;
      register(r: unknown): void;
    };
    expect(resources.contractVersion).toBe(1);
    const note = { uri: "notes://x/a.md", name: "a", mimeType: "text/plain", read: () => "a" };
    resources.register(note);
    lateRegister = () => resources.register({ ...note, uri: "notes://x/b.md" });
  });
  await served();
  expect(events.map(([event]) => event)).toEqual(["mcp:apps", "mcp:resources"]);
  expect(lateRegister).toThrow(/after the mcp:resources event/);
});
