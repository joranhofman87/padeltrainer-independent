

# CSV Export: Day-Per-Column with Times

## Summary
Replace the single "Preferred Days" and "Preferred Time Windows" columns with one column per weekday (Monday–Sunday). Each cell shows the time windows for that day, or is empty if the player didn't select it. This lets trainers sort/filter in Excel by any specific day.

## Current → New Column Layout

**Remove**: `Preferred Days`, `Preferred Time Windows`

**Add 7 columns**: `Monday`, `Tuesday`, `Wednesday`, `Thursday`, `Friday`, `Saturday`, `Sunday`

Each cell contains the time ranges for that day (e.g. `09:00-11:00; 14:00-16:00`) or is empty if not selected. If a day is in `preferred_days` but has no time windows, the cell shows `✓` (available whole day).

## File Changed

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Update `exportIntakeRequestsToCsv` — replace 2 columns with 7 day columns, populate from `preferred_time_windows` and `preferred_days` |

No other files need changes — the callers just pass requests and get a download.

