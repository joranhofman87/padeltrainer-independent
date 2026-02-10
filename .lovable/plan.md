
## Show Trainer Email in Academy Edit Dialog

### What's changing

When an academy owner edits a trainer via the Edit Trainer dialog, the trainer's email will be shown as a read-only field. This lets the academy owner see the trainer's contact email without being able to change it.

### Technical Details

**File:** `src/components/academy/EditAcademyTrainerDialog.tsx`

1. Add `email` to the `ProfileData` interface (as `string | null`)
2. Include `email` in the Supabase query on line 139: add it to the select string
3. Store the email in state when profile data is fetched
4. Add a read-only email field in the "Basic Info" grid (next to Full Name / Phone), using a disabled `Input` with a `Mail` icon or simply a muted text display

The email field will be clearly non-editable -- using a `disabled` input so it's visually distinct from editable fields. No translation changes needed since "Email" is universal.

### Files to modify
- `src/components/academy/EditAcademyTrainerDialog.tsx` -- add email to interface, query, state, and render a read-only field
