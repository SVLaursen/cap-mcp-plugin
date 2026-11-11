using {sap.capire.bookshop as my} from '../db/schema';

// MCP exposure (v2): `@mcp` on the service gives the read-only baseline:
//   - query + get for Books, Authors, Genres
//   - all functions (stockByGenre, bookCard)
// Opt-ins exercised here: @mcp.describe, @mcp on an action, @mcp.ui, @mcp.resource, @mcp.omit.
// Deliberately NOT exposed: the `restock` action (no @mcp), Authors.email and Books.costPrice.
/** Browse the bookshop catalog and place orders. */
@mcp
@mcp.describe
service CatalogService @(path: '/browse') {

  /** Books in the catalog, with their author's name. */
  @readonly
  @cds.search: {title, descr, authorName}
  entity Books   as projection on my.Books {
    *,
    author.name as authorName
  } excluding {
    createdBy,
    modifiedBy
  };

  @readonly
  entity Authors as projection on my.Authors;

  /** Genres, also single-record resources (without key completion). */
  @readonly
  @mcp.resource
  entity Genres  as projection on my.Genres;

  /** Leave feedback. No key: MCP offers query and create only. */
  @mcp.wrap.modes: ['create']
  entity Feedback as projection on my.Feedback;

  /**
   * Number of books in stock for a genre. Baseline: functions are exposed by `@mcp` on the service.
   * Its MCP App UI comes from code (`cds.on('mcp:apps')` in server.js), not from app/mcp-apps/.
   */
  @mcp.ui: 'ui://bookshop/stock-chart.html'
  function stockByGenre(genre : Integer) returns Integer;

  /** A rich card for one book. Rendered as an MCP App (issue #133) by hosts that support it. */
  @mcp.ui: 'ui://bookshop/book-card.html'
  function bookCard(book : Books:ID)      returns Books;

  /** Order a number of copies of a book. Actions are opt-in. */
  @mcp
  action   submitOrder(
    /** The book to order. */
    book : Books:ID,
    quantity : Integer @mandatory
  )                                       returns {
    stock : Integer
  };

  /** Not annotated: must never appear over MCP. */
  action   restock(book : Books:ID, quantity : Integer);
}

annotate CatalogService.Books with {
  costPrice @mcp.omit;
};

annotate CatalogService.Authors with {
  email @mcp.omit;
};
