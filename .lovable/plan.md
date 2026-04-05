

# Lock Pricing on Cycle Slots + Link to Cycle Page

## Problem
When a slot belongs to a cycle, its price should be uniform across all slots in that cycle. Currently the price field is editable on individual slots, which can create inconsistencies.

## Changes

### `src/pages/academy/AcademySlotDetail.tsx`

1. **Disable pricing fields when slot belongs to a cycle** — When `detail.cyclus_id` is set, make the Price, Total Price, Extra Costs, VAT, and Split Payment fields read-only/disabled.

2. **Show info message with link** — Below the disabled price field, show a small info banner:
   > "Pricing is managed at the cycle level."
   > With a link/button: **"Edit cycle pricing →"** that navigates to `/app/academy/cycles/{cyclus_id}`

3. **Skip pricing in save payload for cycle slots** — When saving a cycle slot, omit `price_per_session`, `total_price`, `split_payment`, `prices_include_vat`, and `extra_costs` from the update payload so individual edits can't override cycle-level pricing.

### What stays editable on cycle slots
- Date/time, trainer, location, max participants, rating, visibility — these remain per-slot editable.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Disable pricing fields for cycle slots, add link to cycle detail page, exclude pricing from save payload |

