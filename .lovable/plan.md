

# Pre-Select Available Days & Time Frames on Registration Form

## What
Allow trainers/academies to define which days and time slots are available when creating/editing a registration. Players then only see those pre-selected days (with time frames already set) in the application form, instead of the full 7-day week.

## Changes

### 1. Add `available_days` to `CycleSettings`
**File: `src/lib/cycles.ts`**
- Add `available_days?: DayAvailability` to the `CycleSettings` interface (reusing the existing `DayAvailability` type from `DayAvailabilityPicker`)

### 2. Add availability picker to `CycleForm` (trainer/academy side)
**File: `src/components/cycles/CycleForm.tsx`**
- Import `DayAvailabilityPicker` and `DayAvailability`
- Add state: `const [availableDays, setAvailableDays] = useState<DayAvailability>({})`
- Initialize from `cycle.settings.available_days` when editing
- Render the picker in the registration form section (below existing settings, before price section) with a label like "Available days & times"
- Save `available_days` into `settings` on submit

### 3. Constrain player form to pre-selected days
**File: `src/components/cycles/DayAvailabilityPicker.tsx`**
- Add optional prop `allowedDays?: DayAvailability` — when provided, only show days that exist in `allowedDays`, and constrain the time range selectors to the allowed time windows
- When `allowedDays` is set, hide days not in the list (don't render them at all)
- Pre-check all allowed days by default so the player starts with everything selected

### 4. Pass allowed days to player application form
**File: `src/components/cycles/CycleApplicationForm.tsx`**
- The component already receives the `cycle` prop with `settings`
- Pass `allowedDays={cycle.settings.available_days}` to the `DayAvailabilityPicker`
- When `available_days` is defined, pre-populate the form's availability field with those days/times as defaults

### 5. Translations
**Files: `src/i18n/locales/en/cycles.json`, `nl/cycles.json`, `de/cycles.json`**
- Add keys for "Available days & times", description text for the trainer form

## Files
- `src/lib/cycles.ts` — Add `available_days` to `CycleSettings`
- `src/components/cycles/CycleForm.tsx` — Add day/time picker for trainer
- `src/components/cycles/DayAvailabilityPicker.tsx` — Add `allowedDays` prop to constrain visible days
- `src/components/cycles/CycleApplicationForm.tsx` — Pass allowed days, pre-populate defaults
- `src/i18n/locales/en/cycles.json` — Translations
- `src/i18n/locales/nl/cycles.json` — Translations
- `src/i18n/locales/de/cycles.json` — Translations

