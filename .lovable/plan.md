

## Fix Extra Costs Layout in Cycle Form

### Problem
The extra cost inputs in the cycle creation form don't align with the "Price per session" and "Total cyclus price" fields above them. The description and price inputs use a `grid-cols-[1fr_auto_auto]` layout with a fixed `w-24` price input, while the fields above use a clean `grid-cols-2` layout.

### Fix

**File: `src/components/cycles/CycleForm.tsx`** (lines 766-800)

Change the extra cost row layout from `grid-cols-[1fr_auto_auto]` to `grid-cols-2` with the delete button placed inside or next to the description field, so the two inputs (description + price) align with the two pricing fields above.

Specifically:
- Change the row grid from `grid-cols-[1fr_auto_auto]` to `grid-cols-[1fr_1fr_auto]` -- making the description and price inputs equal width, with just the delete button as auto
- Remove the fixed `w-24` from the price input wrapper, letting it fill its grid column
- Keep the euro prefix styling on the price input

This will make the extra cost description input align with "Price per session" and the extra cost price input align with "Total cyclus price", matching the screenshot.

### Technical detail

Line 766 changes:
- `grid-cols-[1fr_auto_auto]` becomes `grid-cols-[1fr_1fr_auto] gap-3`
- Line 776: remove `w-24` from the price wrapper div, so it fills the column naturally

