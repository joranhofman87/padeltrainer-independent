

## Fix Extra Costs Input Widths in Cycle Form

### Problem

The extra costs row uses `grid-cols-[1fr_1fr_auto]`, giving the description and price fields equal width. The price field only needs a small width (for amounts like "12.50"), while the description should take the remaining space.

### Change

**`src/components/cycles/CycleForm.tsx`** (line 766)

Change the grid template from `grid-cols-[1fr_1fr_auto]` to `grid-cols-[1fr_auto_auto]` and add a fixed width (`w-24`) to the price input container. This makes the description field take all available space while the price stays compact.

### Files to modify

- `src/components/cycles/CycleForm.tsx` (1 line: grid class + price container width)

