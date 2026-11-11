using {sap.capire.bookshop as my} from '../db/schema';

// MCP exposure (v2): `@mcp` on the service gives the read-only baseline:
//   - query + get for Books, Authors, Genres
//   - all functions (stockByGenre, bookCard)
// Opt-ins exercised here: @mcp.describe, @mcp on an action, @mcp.ui, @mcp.resource, @mcp.omit,
// and the names agents see: @mcp.name, @mcp.description, @mcp.hint. CAP's @cds.query.limit on
// Authors sets the page size of its query tool.
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
  @mcp.description: 'Authors of the books in the catalog. Email addresses are never shared.'
  @cds.query.limit: { default: 2, max: 3 } // CAP's page size, for OData and MCP alike
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
  @mcp.name: 'Stock by genre'
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
  status    @mcp.hint: 'available or discontinued; only available books can be ordered';
};

annotate CatalogService.Authors with {
  email @mcp.omit;
};
