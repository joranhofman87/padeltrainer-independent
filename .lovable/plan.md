

# Show Day-Linked Time Windows in Registration Views

## Summary
Pure display fix. All existing registrations already store `preferred_time_windows` as `{ day, start, end }[]` — the detail sheet and table just need to group and display them by day instead of showing days and times separately.

## Changes

### IntakeRequestDetailSheet.tsx — Availability section (~lines 330-360)
Replace the two separate sections (days chips + flat time windows list) with a grouped view:
- Group `preferred_time_windows` by their `day` field
- For each day in `preferred_days`, show the day name followed by its time range badges
- Days with no time windows show "(hele dag)" / "(whole day)"
- Example: `Maandag: 09:00 - 11:00 | 14:00 - 16:00`

### IntakeRequestsTable.tsx — Availability column
Update `formatAvailability()` to show compact day+time (e.g. "Ma 09-11, Wo 18-21") instead of just day abbreviations.

## Files Changed

| File | Change |
|------|--------|
| `IntakeRequestDetailSheet.tsx` | Group time windows by day in availability section |
| `IntakeRequestsTable.tsx` | Show day+time in availability column |

No database, migration, or data changes needed.

