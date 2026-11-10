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
  return cds.test(DEMO_DIR);
}

/** Axios request config that authenticates as a demo user. */
export function as(user: DemoUser) {
  return { auth: USERS[user], validateStatus: () => true };
}
