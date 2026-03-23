

# Add Filters to Schedule Overview

## Summary
Add day, location, and time filters below the existing search bar on the Schedule Overview page, allowing trainers to quickly narrow down their sessions.

## Changes

### `src/pages/TrainerScheduleOverview.tsx`

1. **New filter state** (3 variables):
   - `filterDay: string` — day of week filter ("all", "0"-"6" for Sun-Sat)
   - `filterLocation: string` — location ID or "all"
   - `filterTime: string` — time range preset ("all", "morning" 06-12, "afternoon" 12-17, "evening" 17-23)

2. **Filter UI** — Add a row of 3 `<Select>` dropdowns between the tabs/search row and the results:
   - **Day**: "All days" + localized day names (Mon-Sun) derived from `date-fns` locale
   - **Location**: "All locations" + entries from `trainerLocations` (already fetched)
   - **Time**: "All times" + Morning (06:00-12:00) / Afternoon (12:00-17:00) / Evening (17:00-23:00)
   - A small "Clear filters" button when any filter is active

3. **Extend `filtered` useMemo** — After tab and search filtering, also apply:
   - Day filter: check `getDay()` of slot's `start_time`
   - Location filter: check `slot.location_id`
   - Time filter: check hour of slot's `start_time` against range

### Translation keys (`en/trainer.json` + `nl/trainer.json`)
- `scheduleOverview.allDays` / "Alle dagen"
- `scheduleOverview.allLocations` / "Alle locaties"
- `scheduleOverview.allTimes` / "Alle tijden"
- `scheduleOverview.morning` / "Ochtend"
- `scheduleOverview.afternoon` / "Middag"
- `scheduleOverview.evening` / "Avond"
- `scheduleOverview.clearFilters` / "Filters wissen"
- `scheduleOverview.filterDay` / "Dag"
- `scheduleOverview.filterLocation` / "Locatie"
- `scheduleOverview.filterTime` / "Tijd"

## Files
- `src/pages/TrainerScheduleOverview.tsx`
- `src/i18n/locales/en/trainer.json`
- `src/i18n/locales/nl/trainer.json`

