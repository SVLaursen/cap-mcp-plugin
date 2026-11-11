import { bootDemo } from "../helpers/demo";
import { clientCertificate } from "../helpers/issuer";
import { IAS, authMatrixRow, iasClaims } from "./scenario";

/** Auth matrix: IAS binding with an X.509 certificate (credential-type X509_GENERATED). */
bootDemo();
describe("auth matrix: IAS with X.509 certificate", () => {
  authMatrixRow({
    kind: "ias",
    credentials: { ...IAS, ...clientCertificate(), "credential-type": "X509_GENERATED" },
    claims: iasClaims,
  });
});
