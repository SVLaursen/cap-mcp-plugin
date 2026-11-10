using {sap.capire.bookshop as my} from '../db/schema';

// MCP exposure (v2): baseline from `@mcp`, plus:
//   - draft-enabled Orders with create/update/delete opted in (writes go through the draft API)
//   - @mcp.deepInsert on Orders.items
//   - a bound action `cancel` with @mcp.elicit (confirmation via MRTR input_required)
// Authorization is pure CAP: @restrict with a `where` clause. Bob sees only Bob's orders,
// over OData AND over MCP. The plugin must not re-implement this.
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
}

annotate OrdersService.Orders with {
  items @mcp.deepInsert;
};
