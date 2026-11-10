const cds = require("@sap/cds");

module.exports = class CatalogService extends cds.ApplicationService {
  init() {
    const { Books } = this.entities;

    this.on("stockByGenre", async (req) => {
      const row = await SELECT.one`sum(stock) as stock`
        .from(Books)
        .where({ genre_ID: req.data.genre });
      return row?.stock ?? 0;
    });

    this.on("bookCard", async (req) => {
      const book = await SELECT.one.from(Books, req.data.book);
      if (!book) return req.error(404, "BOOK_NOT_FOUND", "book");
      return book;
    });

    // Used by tests for structured errors: code, target and args must reach the agent intact.
    this.on("submitOrder", async (req) => {
      const { book, quantity } = req.data;
      const row = await SELECT.one.from(Books, book).columns("stock");
      if (!row) return req.error(404, "BOOK_NOT_FOUND", "book");
      if (quantity > row.stock) {
        return req.error(409, "ORDER_EXCEEDS_STOCK", "quantity", [quantity, row.stock]);
      }
      await UPDATE(Books, book).with({ stock: { "-=": quantity } });
      return { stock: row.stock - quantity };
    });

    this.on("restock", async (req) => {
      const { book, quantity } = req.data;
      await UPDATE(Books, book).with({ stock: { "+=": quantity } });
    });

    return super.init();
  }
};
