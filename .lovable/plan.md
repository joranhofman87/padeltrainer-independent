
# Stop Duplicate Invoice Creation on Cycle Edits

## What I found
The duplicate behavior is caused by **three combined issues**:

1. `TrainerScheduleOverview.handleSaveCycleEdit` runs split logic on **every save** when `splitPayment` is true (not only when toggled from off → on).
2. That split step scans invoices with `.neq("status", "paid")`, so it includes **cancelled** invoices too.
3. `split-invoice` / `auto-create-invoice` are not fully idempotent, so repeated calls can still create extra invoices in edge cases.

I also confirmed in data that Joran has overlapping invoices for the same cycle (e.g. `INV-2026-0009` and `INV-2026-0055`), which should not both stay active.

## Implementation plan

### 1) Make cycle edit split logic run only on real toggle-on
**File:** `src/pages/TrainerScheduleOverview.tsx`

- Extend `CycleEditData` with `originalSplitPayment`.
- Populate it in `openEditDialog` from the first slot’s current `split_payment`.
- In `handleSaveCycleEdit`, change split section condition from:
  - current: `if (cycleEditData.splitPayment) { ... }`
  - to: `if (cycleEditData.splitPayment && !cycleEditData.originalSplitPayment) { ... }`

This prevents split execution on unrelated edits (name/date/extra costs/etc.) when split is already enabled.

### 2) Restrict which invoices are eligible for split from schedule edit
**File:** `src/pages/TrainerScheduleOverview.tsx`

- In split lookup, only include active unpaid statuses (`draft`, `sent`, `overdue` if used), explicitly excluding `cancelled` and `paid`.
- Filter out invoices already split (line item description contains `(1/N)`).
- Call `split-invoice` only for one anchor invoice per cycle operation (instead of looping all matching invoices).

This removes repeated split calls that can generate duplicates.

### 3) Make `split-invoice` fully idempotent
**File:** `supabase/functions/split-invoice/index.ts`

Add safeguards:

- Reject/skip when invoice status is `cancelled` (already blocks `paid`, keep that).
- Early no-op if invoice is already split (detect `(1/N)` in line items).
- Before creating child invoice per player, require duplicate check by:
  - same trainer
  - same target recipient (player_id or guest_player_id)
  - status != cancelled
  - **exact same booking set** (`booking_ids @> targetIds AND booking_ids <@ targetIds`)

So re-running the function won’t create another invoice for the same player/bookings.

### 4) Add duplicate guard in `auto-create-invoice` (global safety net)
**File:** `supabase/functions/auto-create-invoice/index.ts`

Before invoice number generation and insert:

- Query existing non-cancelled invoice for same trainer + same recipient + exact booking set.
- If found: return `{ success: true, invoiceId: existing.id, deduped: true }` and stop.

This protects all entry points (manual booking, delayed invoicing, split flow, backfill) from accidental re-inserts.

### 5) One-time cleanup for current duplicate set
**Database patch (migration):**

- Keep current correct split invoices (`INV-2026-0054`, `INV-2026-0055`) active.
- Ensure stale duplicate for same cycle/player (`INV-2026-0009`) is voided (`status='cancelled'`) or deleted if you prefer hard cleanup.
- Leave already-cancelled duplicate (`INV-2026-0053`) as cancelled.

## Technical notes
- This fix is intentionally layered:
  - UI trigger fix (don’t call split repeatedly),
  - split function idempotency,
  - invoice creation dedupe guard.
- Even if one layer is bypassed, downstream guards still prevent duplicate invoice rows.

## Validation checklist
1. Edit cycle title/location with split already ON → invoice count stays unchanged.
2. Edit extra costs with split already ON → invoices update, no new invoice numbers.
3. Toggle split OFF→ON once on test cycle with 2 players → exactly one invoice per player.
4. Re-save same cycle multiple times → no new invoices created.
5. Verify Joran/Nick cycle now shows only the intended active split invoices.
