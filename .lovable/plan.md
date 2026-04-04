

# One-Time Backfill: Generate Missing Invoices

## Approach
Create the `generate-missing-invoices` edge function (no UI button), deploy it, and invoke it once to backfill. It stays available as a utility if ever needed again but isn't exposed in the UI.

## Changes

### 1. `supabase/functions/generate-missing-invoices/index.ts` — New edge function

Accepts `{ academyId }` (required):
1. Fetch all cycles for the academy
2. For each cycle, get all confirmed bookings with `payment_status = 'pending'`
3. For each booking, check if a non-cancelled invoice already exists (via `booking_ids` overlap) — skip if so
4. Group uninvoiced bookings by player (`player_id` or `guest_player_id`)
5. For each player group, call `auto-create-invoice` with their booking IDs
6. If cycle has `split_payment` enabled, pass `splitAmongPlayers`
7. Return `{ invoicesCreated, skipped, errors }`

### 2. Invoke once after deploy
After the function deploys, I'll invoke it via `supabase--curl_edge_functions` with the academy ID to generate all missing invoices.

### 3. Invoice sync on edits — `src/lib/invoiceSync.ts` + `src/pages/academy/AcademySlotDetail.tsx`

Add `syncInvoicesAfterPriceChange(slotIds)` utility:
- Find unpaid invoices with bookings on those slots
- Rebuild line items from current slot prices
- Update totals, clear `pdf_url`

Wire into `AcademySlotDetail`:
- After price edit save → call sync utility
- After slot delete → cancel/recalculate affected invoices

## File summary

| File | Change |
|------|--------|
| `supabase/functions/generate-missing-invoices/index.ts` | **New** — One-time backfill utility |
| `src/lib/invoiceSync.ts` | Add `syncInvoicesAfterPriceChange()` |
| `src/pages/academy/AcademySlotDetail.tsx` | Call invoice sync on price edit + slot delete |

