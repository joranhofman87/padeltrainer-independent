

# Add VAT Include/Exclude Toggle Near Price Inputs

## Current State
The CycleForm already has a VAT toggle (`pricesIncludeVat` switch) at lines 1107-1122, but it's placed **below** the price table and only affects a display label for players. It doesn't make it clear to the trainer whether they're entering prices incl. or excl. VAT while typing.

## Solution
Move the VAT toggle to **above** the price table so the trainer sees the context before entering prices. Also add a visible label suffix on the price inputs themselves (e.g., "incl. VAT" or "excl. VAT") so it's always clear what they're entering.

### Changes in `src/components/cycles/CycleForm.tsx`

1. **Move the VAT toggle block** (lines 1107-1122) to just **before** the price table header row, so the trainer sets the VAT mode before entering prices.

2. **Add a suffix indicator** to each price input showing "(incl. VAT)" or "(excl. VAT)" based on the toggle state — as a small text label next to the € symbol or as placeholder text.

3. **Update the price table column header** from just the label to include the VAT context, e.g., "Price (incl. VAT)" or "Price (excl. VAT)".

### Files
- `src/components/cycles/CycleForm.tsx` — Move VAT toggle above price table, add VAT indicator to price column headers

