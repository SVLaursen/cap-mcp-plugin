/**
 * M4/M5 — auth parity with v1.9 (Willem's PR #163). Each row runs the same small scenario:
 * an authenticated user lists tools and calls one read tool; an unauthenticated request gets 401.
 *
 * mocked runs against the demo app directly. The XSUAA/IAS rows need credentials or a local
 * token issuer; see docs/testing.md for how to stub the issuer without mocking @sap/cds.
 */
describe("auth matrix", () => {
  test.todo("mocked users (alice, bob, carol)");
  test.todo("XSUAA with client secret");
  test.todo("XSUAA with X.509 certificate");
  test.todo("IAS with client secret");
  test.todo("IAS with X.509 certificate");
  test.todo("IAS only, roles from @sap/ams policies (user.is reflects AMS roles)");
});
