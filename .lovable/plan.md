

# Fix: Preserve Split Payment When Syncing Invoice After Cyclus Edit

## Problem

When editing a cyclus (e.g. changing session price), the invoice sync logic at line 714 of `TrainerScheduleOverview.tsx` overwrites `unit_price` with the full session price, ignoring that the invoice was previously split (e.g. `(1/2)`). The description still contains `(1/2)` but the price is now the full amount — so one player's invoice shows the entire cost.

## Root Cause

Line 714-718: the code sets `unit_price: sessionPrice` without checking whether the existing line item was split. The `detectSplitCount` pattern used in `invoiceSync.ts` is not applied here.

## Fix

**File**: `src/pages/TrainerScheduleOverview.tsx` (lines ~700-722)

1. Before updating session items, detect the split count from the existing line item descriptions (same logic as `invoiceSync.ts` — look for `(1/N)` pattern)
2. When applying the new session price, divide by the split count: `unit_price: sessionPrice / splitCount`
3. Also apply the split to extra cost items built on lines 725-735

This ensures that if an invoice was previously split among 2 players, editing the cyclus price keeps each invoice at half the new price.

## Changes

| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | Lines 700-735: Detect split count from existing line items; divide `sessionPrice` and extra cost prices by split count when updating; preserve `(1/N)` suffix in extra cost descriptions |

