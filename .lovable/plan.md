

# Connect Split Payment Toggle to Invoice Splitting

## Problem
When toggling "Split payment" on in the Schedule Overview cycle edit, it only saves a flag on `availability_slots`. It does NOT:
1. Update the `cycles` table `settings.split_payment`
2. Trigger the actual `split-invoice` edge function for existing unpaid invoices

So existing invoices (like INV-2026-0009) remain unchanged and no new invoices are created for other players.

## Changes

### `src/pages/TrainerScheduleOverview.tsx` — `handleSaveCycleEdit`

After the existing slot updates (around line 573), add logic when `splitPayment` is toggled **on**:

1. **Update the `cycles` table** — if the cycle has a `cyclus_id`, update `cycles.settings` to include `split_payment: true`
2. **Find existing unpaid invoices** for bookings on this cycle's slots and trigger `split-invoice` for each one:
   - Query `bookings` for all slots with this `cyclus_id`
   - Query `invoices` where `booking_ids` overlaps with those booking IDs and status is not `paid`
   - Call `supabase.functions.invoke('split-invoice', { body: { invoiceId } })` for each matching invoice
3. **Show feedback** — toast with how many invoices were split

When toggled **off**, just update the flag (no un-splitting needed).

### Flow
```text
User toggles split ON → Save cycle edit
  → Update slots (existing)
  → Update cycles.settings.split_payment = true
  → Find unpaid invoices linked to this cycle's bookings
  → For each: invoke split-invoice edge function
  → Toast: "X invoices split over players"
```

### Files
| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | Add post-save logic to find and split existing invoices when `splitPayment` is toggled on |

