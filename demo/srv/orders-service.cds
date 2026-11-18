using {sap.capire.bookshop as my} from '../db/schema';

// MCP exposure (v2): baseline from `@mcp`, plus:
//   - draft-enabled Orders with create/update/delete opted in (writes go through the draft API)
//   - @mcp.deepInsert on Orders.items
//   - a bound action `cancel` with @mcp.elicit (confirmation via MRTR input_required)
// Authorization is pure CAP: @restrict with a `where` clause. Bob sees only Bob's orders,
// over OData AND over MCP. The plugin must not re-implement this; it only says that a filter
// applies (ADR 0015).
/** Customers manage their own orders. */
@requires: 'authenticated-user'
@mcp
service OrdersService @(path: '/orders') {

  @odata.draft.enabled
  @mcp.wrap.modes: [
    'create',
    'update',
    'delete'
  ]
  @restrict: [
    {
      grant: '*',
      to   : 'authenticated-user',
      where: 'createdBy = $user'
    },
    {
      grant: 'READ',
      to   : 'support'
    }
  ]
  entity Orders     as projection on my.Orders
    actions {
      /** Cancel an order. Asks the user to confirm first. */
      @mcp
      @mcp.elicit: ['confirm']
      action cancel(reason : String) returns Orders;
    };

  entity OrderItems as projection on my.OrderItems;

  // Filtered reads (ADR 0015): carol (support) reads only the returns she logged, alice (admin)
  // reads all of them, bob may not read them at all. On Orders, bob and alice see only their
  // own orders, and carol, who also has the unconditional support grant, sees all.
  /** Returns logged against orders. */
  @restrict: [
    {
      grant: 'READ',
      to   : 'support',
      where: 'createdBy = $user'
    },
    {
      grant: 'READ',
      to   : 'admin'
    }
  ]
  entity Returns    as projection on my.Returns;
}

annotate OrdersService.Orders with {
  items @mcp.deepInsert;
};
