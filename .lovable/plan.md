

## Fix Calendar Day Header Localization

### What the user is seeing
"Echtgenootschap" is a **cyclus name** displayed on a slot card in the Wednesday column (line 164-167 of `CalendarSlotCard.tsx`). It is not the day header. However, the visual prominence of the slot label can make it look like a column header, especially when the actual day headers use tiny abbreviated English text.

### Real issue: Day headers are not localized
`TrainerCalendarGrid.tsx` uses `format(day, "EEE")` and `format(day, "EEEE")` from `date-fns` without passing a locale. This always produces English names regardless of the user's i18n setting. Dutch users should see "Ma", "Di", "Wo" etc.

### Fix

**`src/components/trainer/TrainerCalendarGrid.tsx`**:
- Import `nl, enUS, es, de, fr` from `date-fns/locale`
- Create a locale map based on `i18n.language` (using `useTranslation`)
- Pass the resolved locale to all `format()` calls that render day names:
  - Line 204: `format(day, "EEE", { locale })` — week view headers
  - Line 335: `format(day, "EEEE", { locale })` — mobile day view
  - Line 365: `format(day, "EEE", { locale })` — mobile day picker pills
  - Line 500: `format(day, "EEEE", { locale })` — tablet day view

This also applies to the `getDateRangeLabel()` in `ClubCalendar.tsx` (line 150-154) which formats month names.

**Also improve visual distinction**: Make the cyclus name on slot cards less prominent so it can't be confused with day headers — reduce font size or add a subtle badge/icon prefix.

### Files to edit
- `src/components/trainer/TrainerCalendarGrid.tsx` — add locale to all `format()` calls for day names
- `src/components/trainer/CalendarSlotCard.tsx` — subtle styling tweak to cyclus name display
- `src/pages/club/ClubCalendar.tsx` — localize date range label

