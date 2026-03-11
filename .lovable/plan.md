

## Fix: Cyclus Names Stored with Translated Day Names

### Problem
When a trainer or club manager creates a cyclus (recurring slot), the auto-generated `cyclus_name` includes:
1. **Translated day name** — `format(startDate, "EEEE")` now produces locale-dependent output (e.g., "Woensdag" for Dutch users, "Wednesday" for English users) after our recent locale fix
2. **Translated "Cyclus" label** — `t("calendar.cyclus")` outputs the word in the creator's language

These translated strings get **stored permanently in the database** as `cyclus_name`. When another user with a different language views the slot, they see text in the creator's language — not their own.

### Fix

**`src/components/trainer/AddSlotDialog.tsx`** (line 464-466):
- Change `generateCyclusName` to always use English day names (no locale) and a fixed "Cyclus" prefix instead of `t("calendar.cyclus")`:
```typescript
const generateCyclusName = (startDate: Date, startTime: string) => {
  const dayName = format(startDate, "EEEE"); // English by default (no locale)
  return `Cyclus ${dayName} ${startTime}`;
};
```

**`src/components/club/ClubAddSlotDialog.tsx`** (line 317-323):
- Same fix for the club version — ensure `format(startDate, "EEEE")` does not pass a locale, keeping day names in English for consistent storage:
```typescript
const generateCyclusName = (trainerId, startDate, startTime) => {
  const dayName = format(startDate, "EEEE"); // No locale — always English
  // ...
};
```

**No locale should be passed to `format()` when the result is stored in the database.** Locales should only be used for display-only formatting (calendar headers, date labels in the UI).

### Files to edit
- `src/components/trainer/AddSlotDialog.tsx` — use fixed English prefix + day name in `generateCyclusName`
- `src/components/club/ClubAddSlotDialog.tsx` — ensure no locale is passed to `format()` for stored names

### Note
This only affects **newly created** cyclus names. Existing ones already stored with translated names would need a manual DB cleanup if desired.

