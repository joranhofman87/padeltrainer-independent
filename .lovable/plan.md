

# Fix: Invoice Missing Extra Costs + Not Updating on Slot Deletion

## Root Causes

### 1. Extra costs missing on invoice creation
`auto-create-invoice` edge function fetches bookings with slot details but does NOT include `extra_costs` in the `availability_slots` select (line 48-58). The function tries to fall back to slot-level extra costs (line 232-236), but reads `undefined` because the field was never fetched.

### 2. Split payment not applied on creation
`AddSlotDialog` calls `auto-create-invoice` with `{ bookingIds, asDraft: true }` but never passes `splitAmongPlayers` even when `config.splitPayment` is true. So each player gets a full-price invoice.

### 3. Invoice not updating on slot deletion
The `recalculateInvoiceAfterRemoval` in `invoiceSync.ts` correctly fetches `extra_costs` from slots and recalculates. However, there may be an issue where the `availability_slots` are deleted BEFORE the recalculation reads their extra_costs. Looking at the delete flow:
- Line 252-254: `handleInvoiceUpdates(cancelledBookingIds)` is called **before** slots are deleted (line 256-259) ✓
- For single slot: Line 328-330 also calls before delete (line 332-335) ✓

So the deletion recalculation should work if the first bug (extra costs on creation) is fixed. The real issue is that the invoice was created without extra costs in the first place, so the recalculation starts from a wrong baseline. Actually, `recalculateInvoiceAfterRemoval` rebuilds line items from scratch — it fetches remaining bookings with slot extra_costs and cycle settings. So even if creation was wrong, recalculation should produce correct output. Unless the remaining bookings query fails because slots were already deleted by a prior operation.

**Wait** — I need to re-check: the user says they deleted two slots and the invoice didn't update to 16 sessions. The `recalculateInvoiceAfterRemoval` rebuilds line items using remaining bookings' slot data. If the function runs correctly, it should show the correct count. The most likely explanation is that the initial invoice was created without extra costs (bug #1), and the recalculation did run but the user saw it still missing extra costs (same presentation issue). Or the recalculation didn't trigger because the booking cancellation didn't match.

## Changes

### 1. `auto-create-invoice` edge function — Add `extra_costs` and `split_payment` to slot select
Add `extra_costs` and `split_payment` to the `availability_slots` fields in the booking query (line 48-58). Also add auto-detection of split payment from the slot when `splitAmongPlayers` isn't explicitly passed — count unique players across bookings for the same cyclus.

### 2. `AddSlotDialog.tsx` — Pass `splitAmongPlayers` when split payment is enabled
When `config.splitPayment` is true, pass `splitAmongPlayers: config.selectedPlayers.filter(Boolean).length` to the `auto-create-invoice` call.

### 3. Manual fix for current invoices
Use the insert tool to update the affected invoices for Nick and Joran to include the correct extra costs and session count.

| File | Change |
|------|--------|
| `supabase/functions/auto-create-invoice/index.ts` | Add `extra_costs`, `split_payment` to slot select; auto-detect split from slot |
| `src/components/trainer/AddSlotDialog.tsx` | Pass `splitAmongPlayers` to invoice creation call |

