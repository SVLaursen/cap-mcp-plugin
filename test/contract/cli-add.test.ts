import { planMcpFacet } from "../../src/cli/add";

/** M6 — `cds add mcp`: what the facet writes, as a pure plan (the smoke test runs it for real). */
const app = { name: "bookshop", version: "1.0.0", dependencies: { "@sap/cds": "^10" } };
const base = {
  services: ["CatalogService"],
  app,
  plugin: { name: "@gavdi/cap-mcp", version: "2.0.0" },
};

describe("cds add mcp", () => {
  test("one service: @mcp on it in srv/mcp.cds, the dependency, and an mcp block naming the app", () => {
    const plan = planMcpFacet(base);
    expect(plan.file).toBe("srv/mcp.cds");
    expect(plan.cds).toBe(
      "// Added by `cds add mcp`: exposes these services over MCP (read-only baseline).\n" +
        "// Writes, resources, prompts and more are opt-in per definition: see the @gavdi/cap-mcp docs.\n" +
        "annotate CatalogService with @mcp;\n",
    );
    expect(plan.packageJson).toEqual({
      ...app,
      dependencies: { "@sap/cds": "^10", "@gavdi/cap-mcp": "^2.0.0" },
      cds: { mcp: { name: "bookshop", version: "1.0.0" } },
    });
  });

  test("several services: --service picks them; without it the facet asks which", () => {
    const services = ["AdminService", "CatalogService"];
    expect(() => planMcpFacet({ ...base, services })).toThrow(
      "Several services: choose with --service (AdminService, CatalogService)",
    );
    expect(planMcpFacet({ ...base, services, chosen: ["AdminService"] }).cds).toContain(
      "annotate AdminService with @mcp;\n",
    );
    expect(() => planMcpFacet({ ...base, services, chosen: ["Nope"] })).toThrow(
      "No service Nope (AdminService, CatalogService)",
    );
  });

  test("--docs turns on doc comments (ADR 0011); existing config is kept, never overwritten", () => {
    const configured = {
      ...app,
      dependencies: { ...app.dependencies, "@gavdi/cap-mcp": "file:.." },
      cds: { mcp: { path: "/ai" }, cdsc: { docs: false } },
    };
    expect(planMcpFacet({ ...base, app: configured, docs: true }).packageJson).toEqual({
      ...configured,
      cds: { mcp: { path: "/ai", name: "bookshop", version: "1.0.0" }, cdsc: { docs: false } },
    });
    expect(planMcpFacet({ ...base, docs: true }).packageJson.cds).toEqual({
      mcp: { name: "bookshop", version: "1.0.0" },
      cdsc: { docs: true },
    });
  });

  test("an app without services gets nothing to annotate", () => {
    expect(() => planMcpFacet({ ...base, services: [] })).toThrow(
      "No services to expose: define a service first",
    );
  });
});

describe("cds add mcp: review fixes (M6)", () => {
  test("a plugin already in devDependencies is not added again", () => {
    const dev = { ...app, devDependencies: { "@gavdi/cap-mcp": "file:.." } };
    expect(planMcpFacet({ ...base, app: dev }).packageJson.dependencies).toEqual(app.dependencies);
  });

  test("--docs over an explicit cdsc.docs: false keeps it and says so", () => {
    const off = { ...app, cds: { cdsc: { docs: false } } };
    expect(planMcpFacet({ ...base, app: off, docs: true }).notes).toEqual([
      "cdsc.docs is already false in package.json; left as is. Set it to true to use doc comments as MCP descriptions",
    ]);
    expect(planMcpFacet({ ...base, docs: true }).notes).toEqual([]);
  });
});
