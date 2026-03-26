

# Add "Back to Form" Button on Registration Success Screen

## Change

In `src/pages/CycleRegistration.tsx` (lines 311-319), add a "Back to form" button that resets `isSuccess` to `false` so users can fill out the form again. This goes alongside the existing buttons.

Also add translation keys for EN and NL.

| File | Change |
|------|--------|
| `src/pages/CycleRegistration.tsx` | Add a button before the existing user/guest buttons that calls `setIsSuccess(false); setHasApplied(false);` to return to the form |
| `src/i18n/locales/en/cycles.json` | Add `application.success.backToForm`: "Back to form" |
| `src/i18n/locales/nl/cycles.json` | Add `application.success.backToForm`: "Terug naar formulier" |
| `src/i18n/locales/es/cycles.json` | Add `application.success.backToForm`: "Volver al formulario" |
| `src/i18n/locales/de/cycles.json` | Add `application.success.backToForm`: "Zurück zum Formular" |
| `src/i18n/locales/fr/cycles.json` | Add `application.success.backToForm`: "Retour au formulaire" |

The new button uses `variant="outline"` and sits above the existing navigation button.

