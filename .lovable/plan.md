

## Add Manual Player Registration to Intake Request Pages

### What's changing

The `AddIntakeRequestDialog` component already exists with all the required fields (name, email, phone, rating, availability preferences). It also already creates player accounts via the `create-manual-player` backend function. However, it's not connected to the Trainer or Academy intake request pages -- so there's no way to actually open it.

### Changes

**1. Wire up the dialog in both intake request pages**

Add an "Add Registration" button next to the "Generate Proposals" button on:
- `src/pages/TrainerIntakeRequests.tsx` -- import `AddIntakeRequestDialog`, add state for showing it, add button
- `src/pages/academy/AcademyIntakeRequests.tsx` -- same

**2. Add an info note about profile creation**

In `src/components/cycles/AddIntakeRequestDialog.tsx`, add an info alert/banner below the dialog description explaining:
- "If this player doesn't have an account yet, one will be created for them. They'll receive an email to confirm their registration."

Update translations in both `en/cycles.json` and `nl/cycles.json` with the note text.

**3. Send a confirmation email to the player after registration**

Update `supabase/functions/create-manual-player/index.ts` to accept a `cycleName` parameter and trigger a confirmation email (via the existing `send-email` function) when a new player is created or an existing player is registered. This email informs the player that they've been registered for a training cycle.

Add a new email type `intake_registration_confirmation` to `supabase/functions/send-email/index.ts` with a template that tells the player:
- They've been registered for a specific cycle
- If they're new: they can log in with their email (and use "forgot password" to set their own password)
- Contact info of who registered them

**4. Pass cycle name from the dialog to the backend**

Update `AddIntakeRequestDialog.tsx` to pass the selected cycle's name to the `create-manual-player` function so it can be included in the confirmation email.

### Technical Details

**Files to modify:**
- `src/pages/TrainerIntakeRequests.tsx` -- add import, state, button, and dialog
- `src/pages/academy/AcademyIntakeRequests.tsx` -- add import, state, button, and dialog
- `src/components/cycles/AddIntakeRequestDialog.tsx` -- add info alert, pass cycle name to edge function
- `supabase/functions/create-manual-player/index.ts` -- accept cycleName, trigger send-email after creation
- `supabase/functions/send-email/index.ts` -- add `intake_registration_confirmation` email type and template
- `src/i18n/locales/en/cycles.json` -- add profile creation note translation
- `src/i18n/locales/nl/cycles.json` -- add Dutch translation

**Button placement:** Next to "Generate Proposals" in the controls row, using a `UserPlus` icon with text "Add Registration".
