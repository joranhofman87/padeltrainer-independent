

## Reverse Month Column Order in Player Ratings

### What
Show the most recent month first (leftmost) so admins don't have to scroll right to enter ratings for the current month.

### Change

**`src/pages/admin/AdminPlayerRatings.tsx`**

Reverse the `months` array before rendering. Currently `getMonthColumns()` returns months in chronological order (Jan 2026 first). We'll reverse it so the current month appears right after the fixed columns (Name, KNLTB #, Current).

- After calling `getMonthColumns()`, reverse the result: change line 36 from using `months` directly to `.reverse()` or `.toReversed()`
- This affects both the header row and each player's data row, since both iterate over the same `months` array

No other files need to change.

