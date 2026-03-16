

## Improve Price Calculator to Reflect Full Selection

### Problem
The summary calculator at the bottom of the registration form shows a price per lesson and total, but it doesn't properly account for:
- **Price columns** (e.g. "Kids" vs "Adults") — the `extra_prices` data is ignored
- The price doesn't reflect the actual selection context (e.g. a group lesson for kids at a different rate)

Currently the calculator only reads `priceRow.price` (the default/first column). It never looks at `extra_prices`.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`** — Update the Summary Calculator section (lines 869–981):

1. **Match price columns to lesson type**: When `price_columns` exist and the selected lesson type matches a column name (e.g. "kids" matches a column named "Jeugd"/"Kids"), use the price from `extra_prices` for that column instead of the default `price`.

2. **Show the matched price column name** in the summary so the player understands which rate applies.

3. **Better total calculation**: Ensure `totalPrice = pricePerSession × selectedDurationWeeks` always works when both values are available, regardless of source.

4. **Show all relevant rows**: Display lesson type, duration (minutes), duration (weeks), price per lesson, and estimated total — all based on what the player actually selected.

### Implementation detail

In the price lookup logic (~line 886–911), after finding the `priceRow`, check if `price_columns` exist in settings. If they do, try to match the selected lesson type against column names (case-insensitive). If a match is found in `priceRow.extra_prices`, use that column's price instead of `priceRow.price`.

### Files to modify
- `src/components/cycles/CycleApplicationForm.tsx`

