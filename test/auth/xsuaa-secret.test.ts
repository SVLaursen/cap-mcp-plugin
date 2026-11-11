import { bootDemo } from "../helpers/demo";
import { XSUAA, authMatrixRow, xsuaaClaims } from "./scenario";

/** Auth matrix: XSUAA binding with a client secret (see scenario.ts). */
bootDemo();
describe("auth matrix: XSUAA with client secret", () => {
  authMatrixRow({
    kind: "xsuaa",
    credentials: { ...XSUAA, clientsecret: "test-secret" },
    claims: xsuaaClaims,
  });
});
