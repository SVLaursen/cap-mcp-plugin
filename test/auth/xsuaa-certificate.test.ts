import { bootDemo } from "../helpers/demo";
import { clientCertificate } from "../helpers/issuer";
import { XSUAA, authMatrixRow, xsuaaClaims } from "./scenario";

/**
 * Auth matrix: XSUAA binding with an X.509 certificate (credential-type x509): no client
 * secret, a `certurl` for mTLS token requests. Clients still get their tokens from `url`.
 */
bootDemo();
describe("auth matrix: XSUAA with X.509 certificate", () => {
  authMatrixRow({
    kind: "xsuaa",
    credentials: {
      ...XSUAA,
      ...clientCertificate(),
      "credential-type": "x509",
      certurl: "https://provider.authentication.cert.example.com",
    },
    claims: xsuaaClaims,
  });
});
