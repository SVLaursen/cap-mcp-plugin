namespace sap.capire.bookshop;

using {
  cuid,
  managed,
  sap.common.CodeList
} from '@sap/cds/common';

/** A book in the shop's catalog. */
entity Books : managed {
  key ID        : Integer;
      title     : localized String(111) @mandatory;
      descr     : localized String(1111);
      author    : Association to Authors @mandatory;
      genre     : Association to Genres;
      stock     : Integer @assert.range: [0, 1000];
      price     : Decimal(9, 2);
      /** What the shop paid. Internal: never exposed over MCP (see @mcp.omit in the services). */
      costPrice : Decimal(9, 2);
      status    : String enum {
        available;
        discontinued
      } default 'available';
}

entity Authors : managed {
  key ID           : Integer;
      name         : String(111) @mandatory;
      dateOfBirth  : Date;
      placeOfBirth : String;
      /** Personal contact data. Omitted from MCP. */
      email        : String;
      books        : Association to many Books
                       on books.author = $self;
}

entity Genres : CodeList {
  key ID     : Integer;
      parent : Association to Genres;
}

entity Orders : cuid, managed {
  orderNo : String @readonly;
  items   : Composition of many OrderItems
              on items.up_ = $self;
  total   : Decimal(9, 2) @readonly;
  status  : String enum {
    open;
    submitted;
    cancelled
  } default 'open';
  reason  : String;
}

entity OrderItems : cuid {
  up_      : Association to Orders;
  book     : Association to Books;
  quantity : Integer @assert.range: [1, 100];
  amount   : Decimal(9, 2);
}

/** Internal audit notes. Must never be reachable over MCP, even via @mcp on a service. */
entity AuditNotes : cuid, managed {
  subject : String;
  note    : String;
}
