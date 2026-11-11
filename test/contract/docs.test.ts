import { readFileSync } from "node:fs";
import path from "node:path";
import { readModel } from "../../src/model-reader";
import { compileSnippet } from "../helpers/snippet";

/** M6 — the CDS examples in the user docs compile and read without a diagnostic. */
const ROOT = path.join(__dirname, "..", "..");
const DOCS = [
  "README.md",
  "docs/guide/quickstart.md",
  "docs/guide/production.md",
  "docs/guide/debugging.md",
];

const examples = DOCS.flatMap((file) =>
  [...readFileSync(path.join(ROOT, file), "utf8").matchAll(/```cds\n([\s\S]*?)```/g)].map(
    (m, i) => [`${file} #${i + 1}`, m[1] ?? ""] as const,
  ),
);

test("the user docs have CDS examples", () => {
  expect(examples.length).toBeGreaterThanOrEqual(5);
});

test.each(examples)("%s compiles and reads cleanly", (_name, source) => {
  const { spec, diagnostics } = readModel(compileSnippet(source));
  expect(diagnostics).toEqual([]);
  expect(spec.services.length).toBeGreaterThan(0);
});
