/**
 * Two test projects, matching the test pyramid in docs/testing.md:
 *  - contract:  pure functions over compiled CDS snippets. No server, milliseconds each.
 *  - behaviour: the demo app booted with cds.test, exercised over HTTP like a real MCP client.
 *
 * Rule: no jest.mock("@sap/cds") anywhere. See CLAUDE.md.
 */
const tsJest = ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }];

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: "contract",
      testEnvironment: "node",
      transform: { "^.+\\.ts$": tsJest },
      testMatch: ["<rootDir>/test/contract/**/*.test.ts"],
    },
    {
      displayName: "behaviour",
      testEnvironment: "node",
      transform: { "^.+\\.ts$": tsJest },
      testMatch: [
        "<rootDir>/test/behaviour/**/*.test.ts",
        "<rootDir>/test/regression/**/*.test.ts",
        "<rootDir>/test/auth/**/*.test.ts",
      ],
      setupFiles: ["<rootDir>/test/setup-env.js"],
    },
  ],
  testTimeout: 30000,
  collectCoverageFrom: ["src/**/*.ts"],
  coverageThreshold: {
    global: { lines: 90, branches: 85, functions: 90, statements: 90 },
  },
};
