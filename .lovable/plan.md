

# Add Extra Cost Presets Card to Academy Settings

## Problem
The `ExtraCostPresetsCard` is only rendered on the **Trainer** booking settings page (`TrainerBookingSettings.tsx`). The **Academy** settings page (`AcademySettings.tsx`) never includes it. So for RL Performance Academy (and any academy), presets are invisible and inaccessible.

## Fix

Add the `ExtraCostPresetsCard` component to `AcademySettings.tsx`, passing `academyProfileId={activeAcademy.id}`.

| File | Change |
|------|--------|
| `src/pages/academy/AcademySettings.tsx` | Import `ExtraCostPresetsCard` and render it with `academyProfileId={activeAcademy.id}` alongside the other settings cards |

This is a one-line import + a few lines of JSX. The component already supports the `academyProfileId` prop — it just was never placed on the academy page.

