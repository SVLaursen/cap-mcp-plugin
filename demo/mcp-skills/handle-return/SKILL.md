---
name: handle-return
description: Handle a customer's request to return or cancel a bookshop order. Use when someone asks to send back, return or cancel an order, or asks whether a return is possible.
---

# Handle a return

1. Read `notes://bookshop/returns-policy.md` first: it says which orders can be returned and how.
2. Find the order with `OrdersService_Orders_query` (filter by `orderNo`), or read it with
   `OrdersService_Orders_get` when you have its ID. If the result says your authorization
   limits which orders you can see, say so rather than that the order does not exist.
3. Check whether a return was already logged with `OrdersService_Returns_query` (support and
   admin only).
4. An order that was not delivered yet is cancelled with `OrdersService_Orders_cancel`; the
   user is asked to confirm, so explain what will happen first.
5. Go through [the checklist](references/checklist.md) before you answer.
