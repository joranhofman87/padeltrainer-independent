

## Move Duration Options into Training Preferences Card

### What's changing

1. **Remove** the standalone "Choose your preferred duration" card (lines 644-676)
2. **Replace** the `sessions_per_week` field (lines 749-772) inside the Training Preferences card with a duration selector
3. The duration selector uses the **same checkbox/label style** as the lesson type selector (rounded border, `p-3`, `hover:bg-accent/50`, radio buttons since it's single-select)
4. Remove `sessions_per_week` from the Zod schema, default values, and submission logic
5. Keep `sessions_per_week` in the types for backward compatibility but stop collecting it in the form

### File: `src/components/cycles/CycleApplicationForm.tsx`

- **Delete** the standalone duration card block (lines 644-676)
- **Replace** the `sessions_per_week` FormField (lines 749-772) with a duration radio selector that:
  - Only renders when `hasDurationOptions` is true
  - Uses the same grid layout as lesson types: `grid grid-cols-1 sm:grid-cols-2 gap-2`
  - Each option is a `<label>` with radio input styled like the lesson type checkboxes
  - Shows `{weeks} weken` as label text
  - Uses `selectedDurationWeeks` / `setSelectedDurationWeeks` state (already exists)
- **Remove** `sessions_per_week` from the Zod schema (make it optional or remove)
- **Remove** `sessions_per_week` from default values
- **Keep** backward compatibility in submit: still send `sessions_per_week: 1` as fallback

### No other files need changes

