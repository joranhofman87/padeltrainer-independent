# Notify admins on new registration submissions

## Current state

When a player submits a registration/intake form (`submit-guest-intake` edge function), we send:
- A confirmation email to the registrant
- A Slack notification (internal Lovable team)

We do **not** currently email the academy/club/trainer admins who own the form. They only see new submissions when they open the dashboard.

## Goal

Add an opt-in setting on each registration form to send an email notification to the owner (trainer, club managers, or academy managers) whenever a new submission comes in. Optionally allow extra recipient emails.

## Changes

### 1. Cycle settings (form UI)
In `src/components/cycles/CycleForm.tsx`, add two new fields under "Confirmation Email Text" (registrations + events only):
- **Toggle:** "Email me on new submissions" → `settings.notify_admin_on_submission` (boolean, default `false`)
- **Text input (shown when toggle on):** "Additional notification emails" → `settings.notify_admin_emails` (comma-separated, optional). Empty = send to the owner's default email(s) only.

Update the Zod schema, defaults, and the save payload. Add i18n strings in all 6 locales (`cycles.json`).

### 2. Edge function (`submit-guest-intake`)
After the registrant confirmation email block, add a new non-blocking block that:
1. Reads `cycle.settings.notify_admin_on_submission` — bail if `false`.
2. Resolves recipient list based on `cycle.owner_type`:
   - `trainer` → `profiles.email` of the trainer's `user_id`
   - `club` → all `club_managers` (or `profiles` linked via the club) → fall back to club's primary contact email
   - `academy` → all `academy_managers` for that academy → their `profiles.email`
3. Merges in any extra emails from `settings.notify_admin_emails` (validated, deduped, lowercased).
4. Calls `send-email` with a new type `new_intake_registration_admin` for each recipient (or once with `to` array).

### 3. New email template
Add `case "new_intake_registration_admin"` in `supabase/functions/send-email/index.ts`. Subject e.g. *"New registration: {playerName} for {cycleName}"*. Body includes: player name, email, phone, rating, preferred lesson types/days/times, notes, and a deep link to the registration detail page (`/app/{owner}/registrations/{cycleId}`).

### 4. Verification
- Submit a test registration to a cycle with the toggle ON → check edge function logs + recipient inbox.
- Submit with toggle OFF → confirm no admin email is sent.
- Existing flows (confirmation to player, Slack) keep working unchanged.

## Open questions

1. **Recipients default:** for academies/clubs with multiple managers, do you want **all managers** to receive the email, or only a single "primary" contact? (My default: all managers, since they all need to act on registrations.)
2. **Toggle default:** should new registration forms have this **ON by default** (most owners want to know) or **OFF** (no surprise emails)? I'd lean ON by default — it matches expectations and matches what Slack already does internally.

Reply with answers (or "use your defaults") and I'll implement.
