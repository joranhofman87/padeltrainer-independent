

# Fix Custom Lesson Type Display in Intake Requests Table

## Problem
Custom lesson types (e.g. "Masterclass René Lindenbergh") show as raw translation keys like `application.form.lessonTypes.Masterclass René Lindenbergh` instead of the actual name. The code blindly passes every lesson type through `t()`, but custom types have no translation key.

## Fix

Apply the same pattern already used in `CycleApplicationForm.tsx`: check if the type is a standard one (`private`, `duo`, `group3`, `group4`, `kids`) — if yes, translate it; if not, capitalize and display as-is.

**Same fix needed in 2 files:**

| File | Line | Change |
|------|------|--------|
| `src/components/cycles/IntakeRequestsTable.tsx` | 234 | Replace `t(\`application.form.lessonTypes.${type}\`)` with standard-type check + fallback |
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | 192 | Same replacement |

Both will use:
```tsx
{['private','duo','group3','group4','kids'].includes(type)
  ? t(`application.form.lessonTypes.${type}`)
  : type.charAt(0).toUpperCase() + type.slice(1)}
```

