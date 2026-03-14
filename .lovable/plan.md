

# Registration Confirmation Email — Multilingual with Dynamic Fields

## What We're Building

After a player submits a registration form (intake request), they receive a confirmation email in the **same language they used** on the form. The email includes:
- **Registration name** (cycle name)
- **Club/Academy name** (the owner)
- **Custom text** from the club/academy (entered in the cycle form editor as a new field)

## Current State

- `success_message` already exists in `CycleSettings` — shown on-screen after submission, but **not emailed**.
- The `submit-guest-intake` edge function sends a "welcome/set password" email for new users but **no registration confirmation** email.
- The `submitIntakeRequest` client function (logged-in flow) sends **no email** at all.
- The `send-email` edge function has an `intake_registration_confirmation` type but it's only used by the manual player creation flow, is English-only, and doesn't include club/academy name or custom text.

## Plan

### 1. Add a "Confirmation Email Text" field to the Cycle form

Add a new `CycleSettings` field: `confirmation_email_text?: string`

In `CycleForm.tsx`, add a textarea (next to the existing `success_message` field) where club/academy managers can write the body text for the confirmation email. Label it clearly as the email version (vs. the on-screen success message).

### 2. Update the `send-email` edge function

- Add a `language` field to the `EmailRequest` interface.
- Rewrite the `intake_registration_confirmation` case to:
  - Accept `language`, `cycleName`, `playerName`, `ownerName` (club/academy name), and `confirmationText` (custom text from the cycle form).
  - Translate the static parts (subject line, greeting, footer) based on the `language` parameter (support en, nl, es, de, fr).
  - Render the custom `confirmationText` as-is (already in the owner's chosen language).

### 3. Send the confirmation email after both submission flows

**Guest flow** (`submit-guest-intake/index.ts`):
- After inserting the intake request, fetch the cycle name, owner name (from the relevant profile table based on `owner_type`), and `confirmation_email_text` from `cycle.settings`.
- Accept a `language` parameter from the client request body.
- Invoke `send-email` with type `intake_registration_confirmation` including all dynamic fields + language.

**Logged-in flow** (`submitIntakeRequest` in `src/lib/cycles.ts`):
- After successful submission, call `sendEmail()` from `src/lib/email.ts` with the same data.
- Pass the current `i18n.language` from the form component.

### 4. Pass language from the form to the backend

In `CycleApplicationForm.tsx`:
- For the guest flow: add `language: i18n.language` to the body sent to `submit-guest-intake`.
- For the logged-in flow: pass language to the email-sending call.

### 5. Multilingual email templates

In the `send-email` edge function, create a translation map for the 5 supported languages with:
- Subject: "Registration Confirmed: {cycleName}"
- Greeting: "Hi {playerName},"
- Body intro: "Your registration for {cycleName} at {ownerName} has been received."
- Custom text section (rendered from `confirmationText`)
- Footer: "If you have questions, contact {ownerName} directly."

### Technical Details

**New field in `CycleSettings`:**
```
confirmation_email_text?: string
```
No database migration needed — `settings` is a JSONB column that already allows arbitrary keys.

**Email data fields added:**
- `language` — 'en' | 'nl' | 'es' | 'de' | 'fr'
- `ownerName` — club or academy name
- `confirmationText` — custom text from cycle settings

**Edge functions to update:**
- `supabase/functions/send-email/index.ts` — update `intake_registration_confirmation` template
- `supabase/functions/submit-guest-intake/index.ts` — add email sending after intake insert

**Client files to update:**
- `src/lib/cycles.ts` — `CycleSettings` interface
- `src/components/cycles/CycleForm.tsx` — add `confirmation_email_text` textarea
- `src/components/cycles/CycleApplicationForm.tsx` — pass language, send email in logged-in flow
- `src/lib/email.ts` — add `language` and new fields to `EmailData`, update `EmailType`
- Translation files for all 5 languages — labels for the new form field

