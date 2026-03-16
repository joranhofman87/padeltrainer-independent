

## Allow Trainers to Configure Lesson Duration Options

### Problem
The registration form always shows a hardcoded list of durations (30, 45, 60, 90, 120 min). Trainers want to control which durations are available and optionally add custom ones.

### Changes

**1. `src/lib/cycles.ts` — Add setting to CycleSettings interface**
- Add `available_duration_minutes?: number[]` to `CycleSettings` to store the trainer's selected durations.

**2. `src/components/cycles/CycleForm.tsx` — Add duration picker in the registration form builder**
- Add state for `availableDurations` (initialized from `cycle.settings.available_duration_minutes` or default `[30, 45, 60, 90, 120]`).
- In the registration section (near lesson types), add a multi-select UI with checkboxes for the standard durations (30, 45, 60, 90, 120).
- Add an input + button to add a custom duration (e.g. 75 min).
- Save to `settings.available_duration_minutes` on submit.

**3. `src/components/cycles/CycleApplicationForm.tsx` — Respect the configured durations**
- Read `cycle.settings.available_duration_minutes` — if defined, use it instead of the hardcoded `DURATIONS` constant.
- If only one duration is available, auto-select it and hide the selector.
- Fall back to the full `DURATIONS` list if not configured.

**4. Translations** — Add keys for the new field labels in `en/cycles.json` and `nl/cycles.json`.

### Files to modify
- `src/lib/cycles.ts`
- `src/components/cycles/CycleForm.tsx`
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`

