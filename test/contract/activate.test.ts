import express from "express";
import { activate, type CdsLike } from "../../src/index";
import { compileSnippet } from "../helpers/snippet";

/**
 * M6 review — the startup doc-comment check (ADR 0011) runs beside startup, never in its way.
 * A minimal stand-in for the `cds` facade: activate() receives it (ADR 0005), no CAP mock.
 */
function fakeCds(env: { profiles?: string[] } = {}) {
  const listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const loads: unknown[] = [];
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const cds = {
    on: (event: string, fn: (...args: unknown[]) => unknown) => (listeners[event] ??= []).push(fn),
    emit: () => undefined,
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
