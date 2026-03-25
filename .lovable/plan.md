

# Sync Invoices When Slots Are Deleted

## Problem
When a slot is deleted from the calendar (`DeleteSlotDialog`), the invoice recalculation logic has critical gaps:
1. **No split payment support** — doesn't divide prices by number of players or add `(1/2)` suffixes
2. **No multi-rate VAT** — doesn't compute `vat_breakdown` for extra costs with different VAT rates  
3. **No `pdf_url: null`** — old PDF URL isn't cleared, so cached PDFs remain stale
4. **Extra cost `vat_rate` not preserved** — multi-rate totals break

Additionally, the **Schedule Overview** has two actions that cancel bookings but never update invoices:
- `handleRemovePlayer` (single session removal)
- `handleRemovePlayerFromCycle` (remove from all sessions)
- Reducing repeat count (deletes trailing slots without bookings — less critical since those slots have no bookings)

## Plan

### 1. Fix `DeleteSlotDialog.recalculateInvoice` (~50 lines changed)
**File:** `src/components/trainer/DeleteSlotDialog.tsx`

- After building line items, check if the invoice has split indicators (line items with `(1/2)` or similar in descriptions)
- If split, detect the split count from existing line item descriptions and apply the same division to rebuilt items
- Add `vat_rate` to extra cost line items (from `ec.vat_rate`)
- Implement multi-rate VAT calculation with `vat_breakdown` (same logic as `auto-create-invoice`)
- Set `pdf_url: null` in the update call
- Set `vat_breakdown` in the update call

### 2. Add invoice sync to `handleRemovePlayer` in Schedule Overview
**File:** `src/pages/TrainerScheduleOverview.tsx`

After cancelling a booking, find any unpaid invoices containing that booking ID and recalculate them using the same logic as `DeleteSlotDialog`.

### 3. Add invoice sync to `handleRemovePlayerFromCycle` in Schedule Overview
**File:** `src/pages/TrainerScheduleOverview.tsx`

After cancelling all bookings for a player across the cycle, find and recalculate affected unpaid invoices.

### 4. Extract shared recalculation utility
**File:** `src/lib/invoiceSync.ts` (new)

Extract the invoice recalculation logic into a shared function used by both `DeleteSlotDialog` and `TrainerScheduleOverview` to avoid duplication. This function will:
- Accept an invoice ID and list of removed booking IDs
- Fetch remaining bookings and rebuild line items
- Handle split payment detection and application
- Calculate multi-rate VAT with breakdown
- Clear `pdf_url` and regenerate PDF

### 5. Manual fix for current invoices
Use the insert tool to update Nick & Joran's invoices (and others affected by the April 27th deletion) — same approach as previous patches.

---

**Files changed:**
| File | Change |
|------|--------|
| `src/lib/invoiceSync.ts` | New shared recalculation utility |
| `src/components/trainer/DeleteSlotDialog.tsx` | Use shared utility instead of inline logic |
| `src/pages/TrainerScheduleOverview.tsx` | Add invoice sync to player removal actions |

