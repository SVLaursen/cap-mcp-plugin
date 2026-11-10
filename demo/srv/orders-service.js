const cds = require("@sap/cds");

module.exports = class OrdersService extends cds.ApplicationService {
  init() {
    const { Orders } = this.entities;

    // Runs when a draft is activated (SAVE), for OData and MCP alike: numbers new orders and
    // validates the reason. (orderNo is @readonly, so CAP drops it if set on the draft at NEW.)
    this.before("SAVE", Orders, (req) => {
      req.data.orderNo ??= `ORD-${Date.now()}`;
      if (req.data.reason?.length > 200) req.error(400, "REASON_TOO_LONG", "reason");
    });

    this.on("cancel", Orders, async (req) => {
      const [key] = req.params;
      const ID = typeof key === "object" ? key.ID : key;
      await UPDATE(Orders, ID).with({ status: "cancelled", reason: req.data.reason });
      return SELECT.one.from(Orders, ID);
    });

    return super.init();
  }
};
