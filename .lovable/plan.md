

# Fix: Search Players in Cycles Tab + Invoice €0 Root Cause

## Investigation Summary

Invoice INV-2026-0149 (Denise van Bavel Schiedon, €0) belongs to cycle "Padeltrainingen zomer 2026" under trainer **Yannick Verwater**. The cycle row exists on the Cycles tab, but you can't find Denise because **the search only matches cycle name, not player names**.

The €0 amount is because:
- The `cycles` table has `price_per_session = NULL` for this cycle
- 61 of Yannick's 70 slots have `price_per_session = NULL` (only 9 have €73)
- When the invoice was generated, it resolved `unit_price: 0` from the NULL pricing

## Changes

### 1. `src/pages/academy/AcademyCyclusOverview.tsx` — Search matches player names

Update the `filteredGroups` filter logic to also match search text against `player_names` array entries, not just `cyclus_name`, `trainer_name`, and `location_name`.

This way, searching "Denise" will surface the cycle row she belongs to.

### 2. Fix the €0 invoice (data fix)

Use the existing `rebuild_from_bookings` utility or update the invoice's line items to use the slot's `price_per_session` (€73) where available. This is a data-level fix — the 9 slots with €73 confirm the intended price.

Also update the cycle record to set `price_per_session = 73` so future invoices pick it up correctly.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | Extend search filter to match player names |
| Data fix (migration/insert) | Set cycle `price_per_session = 73`, update invoice line items |

