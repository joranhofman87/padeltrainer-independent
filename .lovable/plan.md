

# Remove "Back to Homepage" Button from Registration Success Screen

## Change

Remove the conditional block that shows either "Back to profile" (logged-in) or "Back to homepage" (guest) after registration success. Only keep the "Terug naar formulier / Back to form" button.

## Files

| File | Change |
|------|--------|
| `src/pages/BrandedCycleRegistration.tsx` | Lines 268-272: Remove the `{user ? ... : ...}` block showing "Back to profile" / "Back to homepage" |
| `src/pages/CycleRegistration.tsx` | Lines 315-323: Same removal |

Both files keep only the existing `variant="outline"` "Back to form" button.

