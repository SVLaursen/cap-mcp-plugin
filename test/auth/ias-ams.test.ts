import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { IAS, authMatrixRow, iasClaims } from "./scenario";

/**
 * Auth matrix: IAS only, roles from AMS policies. The token carries no roles (no `ias_apis`);
 * a middleware after CAP's `auth` adds them by wrapping `user.is`, exactly as @sap/ams's
 * AmsCapMiddleware.appendRoles does with the roles its policies grant. Evaluating real AMS
 * policies (DCL compiled to DCN, assignments from the AMS server) is @sap/ams's own concern;
 * what matters here is that /mcp sees roles that only exist in `user.is` (docs/testing.md).
 */
bootDemo();

/** Policy assignments: token subject → roles the user's AMS policies grant. */
const assignments: Record<string, string[]> = {};

describe("auth matrix: IAS only, roles from @sap/ams policies", () => {
  authMatrixRow({
    kind: "ias",
    credentials: { ...IAS, clientsecret: "test-secret" },
    claims: (user, roles) => {
      const { ias_apis: _none, ...claims } = iasClaims(user, []);
      assignments[claims.sub as string] = roles;
      return claims;
    },
  });
  // Added after the row binds IAS: reading cds.middlewares builds CAP's auth middleware.
  cds.middlewares.add(
    function amsRoles(_req: unknown, _res: unknown, next: () => void) {
      const user = cds.context?.user as cds.User | undefined;
      const sub = (user?.attr as { sub?: string } | undefined)?.sub ?? user?.id;
      const granted = (sub && assignments[sub]) || [];
      if (user && granted.length) {
        const is = user.is.bind(user);
        user.is = (role: string) => granted.includes(role) || is(role);
      }
      next();
    },
    { after: "auth" },
  );
});
