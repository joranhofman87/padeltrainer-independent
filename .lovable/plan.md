

## Make Duration Selector Match Lesson Type & Weeks Style

The duration (minutes) selector currently uses a `Select` dropdown, while lesson types use checkbox cards and weeks use radio cards. Make duration use the same card-based UI.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`** (lines 694-721)
- Replace the `Select` dropdown with a grid of radio-style cards identical to the weeks selector (lines 726-749).
- Each card shows `{d} min` with a radio input, highlighted border when selected (`border-primary bg-primary/5`).
- Keep the single-duration auto-select + disabled display behavior.
- Use `field.onChange(Number(d))` on radio change.

### Files to modify
- `src/components/cycles/CycleApplicationForm.tsx`

