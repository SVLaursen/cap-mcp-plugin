using {sap.capire.bookshop as my} from '../db/schema';

// MCP exposure (v2): baseline from `@mcp`, plus:
//   - @mcp.compact: the generic tool set instead of per-entity tools
//   - @mcp.wrap.modes on Books: create, update, delete
//   - @mcp.resource on Authors: one record by key as cap://AdminService/Authors/<ID>
//   - @mcp.completion on Authors:ID: completes that template's key
//   - @mcp.prompts on the service
//   - @mcp: false on AuditNotes, @cds.api.ignore on Genres.parent
// Service-level @requires: only admins see or call anything here.
/** Catalog maintenance for admins. */
@requires: 'admin'
@mcp
@mcp.compact
@mcp.prompts: [{
  name       : 'restock-plan',
  title      : 'Restock plan',
  description: 'Suggest which books to restock, based on current stock levels',
  template   : 'List books with stock below {{threshold}} and suggest a restock quantity for each.',
  role       : 'user',
  inputs     : [{
    key : 'threshold',
    type: 'Integer'
  }]
}]
service AdminService @(path: '/admin') {

  @mcp.wrap.modes: [
    'create',
    'update',
    'delete'
  ]
  entity Books      as projection on my.Books;

  /** Authors, also exposed as single-record resources. */
  @mcp.resource
  entity Authors    as projection on my.Authors;

  entity Genres     as projection on my.Genres;

  @mcp: false
  entity AuditNotes as projection on my.AuditNotes;
}

annotate AdminService.Books with {
  costPrice @mcp.omit;
};

annotate AdminService.Authors with {
  // Completes the key of cap://AdminService/Authors/{key} (MCP has no tool-argument completion).
  ID    @mcp.completion;
  email @mcp.omit;
};

annotate AdminService.Genres with {
  parent @cds.api.ignore;
};
