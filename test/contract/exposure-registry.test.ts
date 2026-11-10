/**
 * M2 — exposure-registry: ExposureSpec → ToolSpec[], filtered per user.
 */
describe("exposure-registry: tool list", () => {
  test.todo("names follow <Service>_<Entity>_<mode> and <Service>_<operation>");
  test.todo("order is deterministic (sorted by name) across calls and processes");
  test.todo("functions get readOnlyHint; actions get destructiveHint; delete gets destructiveHint");
  test.todo(
    "an @mcp.describe service adds one <Service>_describe tool scoped to that service only",
  );
  test.todo("an @mcp.compact service publishes the generic tool set instead of per-entity tools");
  test.todo("@mcp.ui operations carry the ui resource link in the tool's _meta");
});

describe("exposure-registry: per-user filtering (advertising only; CAP enforces)", () => {
  test.todo("tools of a service with @requires: 'admin' are hidden from a user without admin");
  test.todo("entity-level @requires hides that entity's tools");
  test.todo("@restrict with only `where` conditions does NOT hide tools (CAP filters rows)");
  test.todo("the same spec yields identical lists for users with identical roles");
});

describe("exposure-registry: caching", () => {
  test.todo("tools are built once per model object, not per request");
  test.todo("a different (extended tenant) model object gets its own tool list");
});
