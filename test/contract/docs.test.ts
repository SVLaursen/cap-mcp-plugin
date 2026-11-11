import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readConfig } from "../../src/config";
import { readModel } from "../../src/model-reader";
import { compileSnippet } from "../helpers/snippet";

/**
 * The user docs (README.md, CONTRIBUTING.md and docs/guide/) stay true to the code: their CDS
 * examples compile and read without a diagnostic, their config examples are valid `cds.mcp`
 * blocks, and their relative links point at files that exist.
 */
const ROOT = path.join(__dirname, "..", "..");
const GUIDES = readdirSync(path.join(ROOT, "docs", "guide"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `docs/guide/${f}`);
const DOCS = ["README.md", "CONTRIBUTING.md", ...GUIDES];

const blocks = (lang: string) =>
  DOCS.flatMap((file) =>
    [
      ...readFileSync(path.join(ROOT, file), "utf8").matchAll(
        new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"),
      ),
    ].map((m, i) => [`${file} #${i + 1}`, m[1] ?? ""] as const),
  );

test("the user guides are all there", () => {
  expect(GUIDES.sort()).toEqual(
    [
      "annotations.md",
      "features.md",
      "getting-started.md",
      "mcp-apps.md",
      "migrating-from-v1.md",
      "production.md",
      "troubleshooting.md",
    ].map((f) => `docs/guide/${f}`),
  );
  expect(blocks("cds").length).toBeGreaterThanOrEqual(15);
});

test.each(blocks("cds"))("%s compiles and reads cleanly", (_name, source) => {
  const { spec, diagnostics } = readModel(compileSnippet(source));
  expect(diagnostics).toEqual([]);
  expect(spec.services.length).toBeGreaterThan(0);
});

const configs = blocks("json")
  .map(([name, source]) => [name, JSON.parse(source) as { cds?: { mcp?: unknown } }] as const)
  .filter(([, json]) => json.cds?.mcp !== undefined);

test.each(configs)("%s is a valid cds.mcp block", (_name, json) => {
  expect(readConfig(json.cds?.mcp).diagnostics).toEqual([]);
});

const links = DOCS.flatMap((file) =>
  [...readFileSync(path.join(ROOT, file), "utf8").matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1] ?? "")
    .filter((href) => !/^[a-z]+:/i.test(href) && !href.startsWith("#"))
    .map((href) => [file, href] as const),
);

test.each(links)("%s links to %s, which exists", (file, href) => {
  const target = path.resolve(path.dirname(path.join(ROOT, file)), href.split("#")[0] ?? "");
  expect(existsSync(target)).toBe(true);
});
