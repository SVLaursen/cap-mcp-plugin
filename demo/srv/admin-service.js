const cds = require("@sap/cds");

module.exports = class AdminService extends cds.ApplicationService {
  init() {
    const { Books } = this.entities;

    // A custom handler MCP must respect: if v2 bypasses the service, this check is skipped.
    this.before(["CREATE", "UPDATE"], Books, (req) => {
      if (req.data.price !== undefined && req.data.price < 0) {
        req.error(400, "PRICE_NEGATIVE", "price");
      }
    });

    // Used to prove failed commits surface as errors (regression for v1 issue #1):
    // deleting book 207 succeeds in the handler but fails at commit time.
    this.before("DELETE", Books, (req) => {
      if (Number(req.data.ID) === 207) {
        req.before("commit", () => {
          throw new Error("SIMULATED_COMMIT_FAILURE");
        });
      }
    });

    this.on("stockReport", (req) =>
      SELECT.from(Books).where({ stock: { "<": req.data.threshold ?? 5 } }),
    );

    return super.init();
  }
};
