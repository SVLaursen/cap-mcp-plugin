/**
 * Jest globalSetup for the behaviour tests: build lib/ once. cds-cli.test.ts and package.test.ts
 * run the plugin outside Jest's transform (child processes load lib/), and building in each file
 * raced when Jest ran them in parallel workers.
 */
const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const path = require("node:path");

module.exports = function buildLib() {
  const root = path.join(__dirname, "..");
  // As `npm run build`: no stale files from an earlier build end up in lib/ (or the package).
  rmSync(path.join(root, "lib"), { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "inherit" },
  );
};
