
# Widen Extra Costs Input Fields

## Problem
The "Add extra costs" description and price input boxes are much smaller than the "Price per session" and "Total cyclus price" fields above them, making the form look inconsistent.

## Solution
Change the grid layout of the extra cost rows so the description field and price field together span the same width as the pricing fields above. The description input will take up most of the space (matching the "Price per session" box width), the euro amount field stays at a reasonable fixed width, and the delete button stays icon-sized.

## Technical Detail
In `src/components/cycles/CycleForm.tsx` (line 793), change the grid template from:
- `grid-cols-[2fr_auto_auto]` (current -- makes inputs narrow)

to:
- `grid-cols-[1fr_8rem_auto]` (description fills available space, price field fixed at 8rem, delete button auto)

This single line change will make the description input fill the row width, matching the size of the "Price per session" input above it.
