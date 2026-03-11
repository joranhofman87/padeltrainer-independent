

## Custom Lesson Types

### Problem
Lesson types are currently hardcoded to four options: private, duo, group, kids. Managers may want to offer custom lesson types (e.g. "padel fit", "competition training").

### Design

Allow up to **2 custom lesson types** that the manager defines when creating/editing a cycle. These custom types then appear alongside the standard ones in registration forms and the manual registration dialog.

#### How it works

1. **CycleForm** (cycle settings): Below the 4 standard checkboxes, add two text inputs labeled "Custom lesson type 1" and "Custom lesson type 2". These are optional free-text fields (max 30 chars). When filled in, the value is added to the `lesson_types` array in cycle settings.

2. **CycleSettings type** (`cycles.ts`): Add `custom_lesson_types?: string[]` (max 2 items) to the settings interface. The existing `lesson_types` array continues to hold the standard types; custom types are stored separately so the UI knows which are standard vs custom.

3. **CycleApplicationForm** (player-facing): Merge `allowedLessonTypes` with `cycle.settings.custom_lesson_types` to build the full list. For custom types, display the raw text instead of looking up a translation key.

4. **AddIntakeRequestDialog** (manual registration): Same approach — merge standard + custom types. Change the zod schema from `z.enum([...])` to `z.array(z.string()).min(1)` since custom types are free-text.

### Files to edit

1. **`src/lib/cycles.ts`** — Add `custom_lesson_types?: string[]` to `CycleSettings`
2. **`src/components/cycles/CycleForm.tsx`** — Add two optional text inputs for custom lesson types; include them in saved settings
3. **`src/components/cycles/CycleApplicationForm.tsx`** — Merge custom types into the checkbox list; display raw text for non-standard types
4. **`src/components/cycles/AddIntakeRequestDialog.tsx`** — Accept custom types in the lesson type multi-select; relax zod enum to `z.string()`

### Details

- Custom type display: For standard types, use existing translation `t('application.form.lessonTypes.private')`. For custom types, display the string as-is (capitalize first letter).
- Validation: Custom type inputs trimmed, max 30 chars, no duplicates with standard types.
- No database migration needed — `custom_lesson_types` lives inside the existing JSON `settings` column.

