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
      // Child processes in cds-cli.test.ts and package.test.ts load lib/: build it once.
      globalSetup: "<rootDir>/test/build-lib.js",
    },
  ],
  testTimeout: 30000,
  collectCoverageFrom: ["src/**/*.ts"],
  // Measured at the 2.0 release (M7), rounded down: statements 94.9, branches 88.4, functions
  // 96.2, lines 95.5. Not counted: the `cds add mcp` facet's run() and the `cds build` task
  // (src/cli/add.ts, src/cli/build.ts), which test/behaviour/cds-cli.test.ts runs through the real
  // cds-dk CLI in a child process, against lib/. CI runs `npm run test:coverage`.
  coverageThreshold: {
    global: { statements: 94, branches: 88, functions: 96, lines: 95 },
  },
};
