

## Widen Extra Costs Inputs in CycleForm

### Problem

The extra cost description and price inputs are too small compared to the "Price per session" and "Total cyclus price" fields above them. The description field uses `flex-1` and the price field is only `w-24` (6rem), making them look cramped.

### Solution

Change the extra costs row layout to use a `grid grid-cols-2 gap-3` layout (same as the pricing fields above), giving both the description and price inputs equal, full-width columns. The delete button stays at the end.

### Changes

**`src/components/cycles/CycleForm.tsx`** (line 740)

- Change the row container from `flex items-center gap-2` to `grid grid-cols-[1fr_1fr_auto] items-center gap-3`
- Remove `className="flex-1"` from the description input (grid handles sizing)
- Remove `className="w-24"` from the price input
- Add a euro prefix label to the price input to match the screenshot context

This gives both inputs roughly equal width, matching the two pricing fields above, with the trash icon in a small auto-sized column.

### Files to modify
- `src/components/cycles/CycleForm.tsx` (lines 740-772, update grid layout and input classes)

