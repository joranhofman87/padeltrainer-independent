

## Bug: Academy's success message not visible on branded registration page

### Root Cause

There are **two competing success views**:

1. **`CycleApplicationForm`** (child) — has its own `isSuccess` state that renders a success card including `cycle.settings.success_message` (the message the academy sets per cycle)
2. **`BrandedCycleRegistration`** (parent) — has its own `isSuccess` state that renders a full-page success view with `owner.welcome_message` (the academy's general welcome message)

When the form submits successfully, it calls `onSuccess()` which sets the **parent's** `isSuccess = true`. On re-render, the parent's success view (checked at line 216, before the form is rendered) takes over — showing `owner.welcome_message` but **not** `cycle.settings.success_message`.

So the cycle-specific success message configured by the academy owner is never shown on the branded registration page.

### Fix

Add `cycle.settings.success_message` to the parent's success view in `BrandedCycleRegistration.tsx`, right after the title/subtitle and before the "what next" card. This mirrors what the form's own success view does.

### File to modify
- **`src/pages/BrandedCycleRegistration.tsx`** — In the `isSuccess` block (~line 223), add a conditional render of `(cycle.settings as any)?.success_message` in a styled card, placed between the success subtitle and the "what next" steps card.

