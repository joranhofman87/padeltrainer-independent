

## Add "Group Notes" Free Text Field Below Sessions Per Week

Add a new optional textarea field after the "sessions per week" dropdown in the Preferences card, allowing players to indicate if they want to train with specific people or already have a group.

### Changes

**1. `src/components/cycles/CycleApplicationForm.tsx`**
- Add `group_notes: z.string().optional()` to the form schema
- Add default value `group_notes: ''`
- Insert a `FormField` with `Textarea` after the `sessions_per_week` field (after line 603), before the trainer preference field
- Pass `group_notes` through to the submission payload alongside `notes`
- Merge `group_notes` into the existing `notes` field for storage (append it), since the DB already has a `notes` column — no schema change needed

**2. Translation files** (en, nl, fr, de, es `cycles.json`)
- Add keys under `application.form`:
  - `groupNotes`: "Notes (optional)" / "Opmerkingen (optioneel)" / etc.
  - `groupNotesPlaceholder`: example text like "E.g. I would like to train together with John and Sarah. We already have a group of 4." translated per language

### Storage
No DB migration needed — the `group_notes` text will be appended to the existing `notes` field (separated by a newline) when submitting, so trainers see it in the intake request details.

