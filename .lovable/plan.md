

## Update Registration Confirmation Email with Price Calculator

### What's missing from the email

The form currently collects and displays several fields that are **not** included in the confirmation email:

1. **Phone number** — collected but not sent
2. **Birth date** — collected but not sent
3. **Selected cyclus option** (package) — stored in metadata but not in the email (label, sessions, weeks, total price)
4. **Selected duration in weeks** — stored in metadata but not in the email
5. **Price indication/calculator** — the form shows a price summary card with per-lesson and total prices per lesson type, but this is completely absent from the email
6. **Group notes** — appended to notes but not labeled separately
7. **Availability** (preferred days/time windows) — submitted but not in the email

### Plan

**1. Add new fields to `EmailData` in `src/lib/email.ts`:**
- `birthDate`, `phone`, `selectedPackageLabel`, `selectedPackagePrice`, `selectedPackageSessions`, `selectedDurationWeeks`, `priceLines` (array of `{ label, perLesson, total }`)

**2. Pass the new data when calling `sendEmail` in `src/components/cycles/CycleApplicationForm.tsx` (logged-in flow, ~line 300):**
- Add `phone`, `birthDate`, price lines computed from the same logic as the price calculator card, `selectedPackageLabel`/price/sessions, `selectedDurationWeeks`

**3. Pass the same new data in `supabase/functions/submit-guest-intake/index.ts` (guest flow, ~line 349):**
- Forward the same additional fields to the `send-email` invocation

**4. Update the email template in `supabase/functions/send-email/index.ts` (the `intake_registration_confirmation` case, ~line 630):**
- Add translations for new labels: phone, birth date, package, duration weeks, price per lesson, total price
- Add a **Price Summary** section at the bottom of the email (styled like the price calculator card) showing each lesson type with per-lesson price and total for the cycle duration
- Show selected package info if present
- Show phone and birth date in the registration summary section

**5. Redeploy edge functions** (`send-email`, `submit-guest-intake`)

### Files to modify
- `src/lib/email.ts` — add new fields to `EmailData`
- `src/components/cycles/CycleApplicationForm.tsx` — pass additional data to `sendEmail`
- `supabase/functions/submit-guest-intake/index.ts` — forward additional data
- `supabase/functions/send-email/index.ts` — render new fields + price summary in the email template

