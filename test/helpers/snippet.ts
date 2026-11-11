import path from "node:path";
import cds from "@sap/cds";
import { DEMO_DIR } from "./demo";

/** The slice of cds.compile used here; cds-types does not model the options argument. */
type Compile = ((source: string, options?: { docs?: boolean }) => unknown) & {
  for: { nodejs(csn: unknown): unknown };
};

/**
 * Compile a CDS source string into the linked, Node.js-flavoured CSN the plugin reads at
 * runtime. Doc comments are kept (`/** … *\/` becomes `doc`), as they are in the demo app;
 * pass `{ docs: false }` to compile like an app that leaves `cds.env.cdsc.docs` unset (ADR 0011).
 *
 * Use this for contract tests: given this CDS, the model reader / schema mapper / registry
 * must produce exactly this output. No server, no database, no mocks.
 *
 * @example
 *   const csn = compileSnippet(`@mcp service S { entity Books { key ID: Integer; } }`);
 *   expect(readModel(csn).spec.services[0].entities[0].name).toBe("S.Books");
 */
export function compileSnippet(
  source: string,
  { docs = true }: { docs?: boolean } = {},
): cds.linked.LinkedCSN {
  const compile = cds.compile as unknown as Compile;
  const nodejs = compile.for.nodejs(compile(source, { docs }));
  return cds.linked(nodejs as cds.csn.CSN);
}

/**
 * Compile the demo app's services the same way, without booting it. For contract tests that
 * need the real demo model (e.g. "the demo reads with zero errors").
 */
export async function compileDemo(): Promise<cds.linked.LinkedCSN> {
  const compile = cds.compile as unknown as Compile;
  const csn = await cds.load(path.join(DEMO_DIR, "srv"), { docs: true });
  return cds.linked(compile.for.nodejs(csn) as cds.csn.CSN);
}
