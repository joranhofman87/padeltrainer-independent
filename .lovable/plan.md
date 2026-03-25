

# Fix Split Payment Rounding: Totals Don't Add Up

## Problem

When splitting an invoice among N players, the code divides each line item's `unit_price` by N and rounds individually. This causes rounding errors that compound across line items:

```text
Example: €92.50 / 4 = €23.125 → rounded to €23.13
4 × €23.13 = €92.52 (not €92.50)
Over 16 sessions: €0.32 overpaid across all 4 players
```

The split totals don't sum back to the original invoice total. This happens in **two places**: the `split-invoice` edge function (retroactive split) and `auto-create-invoice` (split at creation time).

## Fix: Use Total-Level Division Instead of Per-Line Rounding

Instead of dividing each `unit_price` by N (which compounds rounding), calculate the **original total first**, then divide the total by N. Give N-1 players `floor(total/N)` and give the first player the remainder to absorb rounding.

### Changes

#### 1. `supabase/functions/split-invoice/index.ts` (lines 152-161)

**Before**: Divides each line item's `unit_price` by `totalPlayers`, rounding each independently.

**After**: Still divide unit_price per line item (needed for display), but after calculating totals, adjust the original invoice's total to absorb the rounding difference:

```typescript
// Calculate what the original total was
const originalTotal = invoice.total;
// Each split share (floor)
const splitShare = Math.floor((originalTotal / totalPlayers) * 100) / 100;
// Remainder goes to the first invoice
const remainder = Math.round((originalTotal - splitShare * totalPlayers) * 100) / 100;
// First invoice gets splitShare + remainder
```

#### 2. `supabase/functions/auto-create-invoice/index.ts` (lines 264-271)

Same approach: after splitting line items for display, recalculate the final total as `floor(originalTotal / N)` to ensure consistency. The calling function (`split-invoice`) handles the remainder adjustment on the first invoice.

### Technical Detail

- Line items still show `(1/N)` with divided prices for transparency
- The `total` field is adjusted so that `N × splitShare = originalTotal` (±1 cent on one invoice)
- This ensures the sum of all split invoices exactly equals the original unsplit amount

| File | Change |
|------|--------|
| `supabase/functions/split-invoice/index.ts` | Adjust total after line-item division to absorb rounding remainder |
| `supabase/functions/auto-create-invoice/index.ts` | Same rounding correction when `splitAmongPlayers` is used |

