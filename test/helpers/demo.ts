import path from "node:path";
import cds from "@sap/cds";

export const DEMO_DIR = path.join(__dirname, "..", "..", "demo");

/** Mocked users from demo/package.json. Use these names in tests; never invent new ones inline. */
export const USERS = {
  /** role: admin */
  alice: { username: "alice", password: "alice" },
  /** no roles */
  bob: { username: "bob", password: "bob" },
  /** role: support */
  carol: { username: "carol", password: "carol" },
} as const;
export type DemoUser = keyof typeof USERS;

/**
 * Boot the demo app for this test file (SQLite in-memory, mocked auth, the plugin loaded via
 * cds-plugin.js). Call once at the top level of a test file:
 *
 *   const demo = bootDemo();
 *   test("…", async () => { const { data } = await demo.GET("/browse/Books", as("alice")); });
 *
 * Each test file gets a fresh database, so writes in one file never leak into another.
 */
export function bootDemo() {
  return (booted = cds.test(DEMO_DIR));
}

let booted: ReturnType<typeof cds.test> | undefined;

/** The demo booted by this test file (Jest gives each file its own module registry). */
export function currentDemo(): ReturnType<typeof cds.test> {
  if (!booted) throw new Error("call bootDemo() at the top of the test file first");
  return booted;
}

/** Axios request config that authenticates as a demo user. */
export function as(user: DemoUser) {
  return { auth: USERS[user], validateStatus: () => true };
}

/** Run `fn` with these environment variables set, restoring them afterwards. */
export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Run `fn` as if the app ran in production (NODE_ENV=production), as CAP's protocol adapters
 * and the plugin decide per request. Restores NODE_ENV and the given auth settings afterwards.
 */
export async function inProduction<T>(
  fn: () => Promise<T>,
  auth: { restrict_all_services?: boolean } = {},
): Promise<T> {
  const env = process.env.NODE_ENV;
  const config = cds.env.requires.auth as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(auth).map((k) => [k, config[k]]));
  process.env.NODE_ENV = "production";
  Object.assign(config, auth);
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = env;
    Object.assign(config, saved);
  }
}
