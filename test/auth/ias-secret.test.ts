import { bootDemo } from "../helpers/demo";
import { IAS, authMatrixRow, iasClaims } from "./scenario";

/** Auth matrix: IAS (Identity Service) binding with a client secret, no XSUAA. */
bootDemo();
describe("auth matrix: IAS with client secret", () => {
  authMatrixRow({
    kind: "ias",
    credentials: { ...IAS, clientsecret: "test-secret" },
    claims: iasClaims,
  });
});
