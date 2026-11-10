const cds = require("@sap/cds");

module.exports = class OrdersService extends cds.ApplicationService {
  init() {
    const { Orders } = this.entities;

    this.before("NEW", Orders, (req) => {
      req.data.orderNo ??= `ORD-${Date.now()}`;
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
