

## Fix Extra Costs Input Sizing

### Problem
The description and price inputs in the extra costs row use equal widths (`1fr_1fr`), making the description field too small to read. The price field doesn't need that much space.

### Fix

**File: `src/components/cycles/CycleForm.tsx`** (line 793)

Change the grid from `grid-cols-[1fr_1fr_auto]` to `grid-cols-[2fr_auto_auto]` so:
- The description input takes most of the available width
- The price input gets a fixed width (`w-28`) to fit euro amounts comfortably
- The delete button stays as auto

This gives the description field enough room to be readable while keeping the price field compact.

