
# Fix why €0 invoices still exist

## What I found
- The All Slots table is not contradicting the invoice page.
- In **All Slots**, missing prices are shown as `—`, not `€0`.
- The current €0 invoices are being created from bookings/slots where the stored price is still missing, and the invoice logic falls back to `0`.

## Root cause
I checked both the code and the data:

- There are still **46 non-cancelled €0 invoices**.
- They all belong to the same cycle and contain 13/14 bookings each.
- Those invoices currently store a single line like:
  - `Training cyclus (13 weken)` with `unit_price: 0`

The bug is in the bundled cycle invoice logic:

- `supabase/functions/auto-create-invoice/index.ts`
- `src/lib/invoiceSync.ts`

Both currently do this for cycle invoices:

```ts
bookings[0].payment_amount || firstSlot.price_per_session || 0
```

So if the **first booking / first slot** has no price, the **entire invoice becomes €0**, even if later slots in that same invoice do have prices.

## Why they didn’t auto-fix
The existing `supabase/functions/recalculate-invoices/index.ts` only recalculates totals from the invoice’s **already stored line items**.

So if the invoice already contains:

```ts
unit_price: 0
```

it just recalculates `0` again.

## Plan
1. **Fix future invoice creation**
   - Update `auto-create-invoice` so it resolves pricing from **all linked bookings**, not just the first one.
   - For cycle invoices:
     - if all resolved session prices are the same, keep the bundled line item
     - if prices differ or some sessions are missing prices, fall back to **per-session line items** instead of one bundled zero-priced line

2. **Fix invoice resync after slot edits**
   - Update `src/lib/invoiceSync.ts` to use the same pricing logic when prices are changed later.
   - Remove the current “first booking wins” behavior there as well.

3. **Repair existing €0 invoices**
   - Update `supabase/functions/recalculate-invoices/index.ts` so it can rebuild invoice contents from current booking/slot data, not just re-sum existing lines.
   - Use it to repair existing zero-total unpaid/sent invoices.

4. **Prevent silent zero invoices**
   - If an invoice has no valid price source at all, do **not** create/send a €0 invoice.
   - Return a clear backend reason like `missing_price_data` instead.

## Files to change
| File | Change |
|------|--------|
| `supabase/functions/auto-create-invoice/index.ts` | Resolve price from all bookings, not only first booking |
| `src/lib/invoiceSync.ts` | Use the same robust rebuild logic for invoice syncing |
| `supabase/functions/recalculate-invoices/index.ts` | Rebuild from booking/slot data so existing €0 invoices can be fixed |

## Expected outcome
- No new €0 invoices will be created just because the first slot in a cycle has no price.
- Existing €0 invoices can be repaired from current slot data.
- The All Slots table can still show `—` for unpriced slots, but those will no longer silently become zero-value invoices.
