

# Make Warnings Section Compact

## Problem
The Warnings card uses full `Card` + `CardHeader` + nested `Alert` components, making it tall and pushing the Players card down in the right column.

## Solution
Replace the full Card with a compact inline banner — no Card wrapper, just a small amber box with warning rows as simple flex items instead of nested `Alert` components.

## Changes in `src/pages/academy/AcademySlotDetail.tsx`

**Replace the Warnings Card (lines 967-1009)** with a compact version:
- Remove `Card`/`CardHeader`/`CardContent` wrapper
- Use a single `div` with amber border and small padding
- Title row: icon + "Warnings" as small text, inline with the settings link
- Each warning: a single flex row with icon, text, and dismiss button — no nested `Alert` component
- Reduce spacing from `space-y-2` to `space-y-1`
- Use smaller text (`text-xs`) throughout

Result: the warnings section becomes ~50% shorter vertically, keeping Players visible without excessive scrolling.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Replace verbose Warnings Card with compact banner |

