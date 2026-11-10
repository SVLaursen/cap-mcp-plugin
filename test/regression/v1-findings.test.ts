/**
 * One test per correctness/security issue found in v1 (docs/v1-reference.md).
 * Each must be written red against the v2 code path FIRST, then made green.
 */
describe("v1 regressions", () => {
  test.todo(
    "#1 a failed commit is reported as an error (AdminService DELETE Books 207 fails at commit)",
  );
  test.todo(
    "#2 q search never matches on @mcp.omit fields (searching a costPrice value finds nothing)",
  );
  test.todo(
    "#3 the describe tool never reveals unexposed entities, db-layer entities or omitted fields",
  );
  test.todo("#4 there is no session state: a request never sees tools resolved for another user");
  test.todo("#5 reads and writes run with the same user context (cds.context.user)");
  test.todo("#6 count with skip > 0 returns the full count");
});
