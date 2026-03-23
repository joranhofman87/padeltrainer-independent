

# Improve End Date Display Below "Repeat for X Weeks"

## Current State
The end date is already shown at line 977-979 of `AddSlotDialog.tsx`, but it uses a plain arrow format: `→ Mar 15, 2026`. This may not be prominent or clear enough.

## Change
Replace the current raw format with the translated `endsOn` key (e.g., "Ends on Mar 15, 2026" / "Eindigt op 15 mrt 2026") and make it slightly more visible with a different style.

### File: `src/components/trainer/AddSlotDialog.tsx` (line 977-979)

Change from:
```tsx
<p className="text-xs text-muted-foreground mt-1">
  → {format(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), "MMM d, yyyy")}
</p>
```

To:
```tsx
<p className="text-xs text-muted-foreground mt-1 font-medium">
  📅 {t("cycles:form.endsOn", { date: format(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), "PPP") })}
</p>
```

This uses the existing `endsOn` translation key (already available in all languages) and the `PPP` date format for a more readable localized date.

## Files
- `src/components/trainer/AddSlotDialog.tsx` — 1 line update

