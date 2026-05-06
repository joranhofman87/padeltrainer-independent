## Goal

Improve the bulk invoice email flow in `BulkInvoiceEmailDialog` so trainers/academies can:
1. Send invoice emails without the PadelTrainer.ai logo at the top
2. Write their own greeting/message with support for `{first_name}` / `{last_name}` / `{full_name}` variables (no auto "Hi {firstname}")
3. Preview the rendered email and send a test email to themselves before bulk sending

## Changes

### 1. Edge function `supabase/functions/send-invoice-email/index.ts`

- Remove the hardcoded `EMAIL_LOGO` block at the top of the email HTML (per request: no logo at top in invoice emails).
- Remove the auto-rendered greeting line `${tr.hi} ${firstName},` — the message body now comes entirely from the trainer's `customMessage` (rendered above the invoice details).
- Add variable substitution in `customMessage` before HTML escaping:
  - `{first_name}` → first token of `player_name`
  - `{last_name}` → remaining tokens of `player_name`
  - `{full_name}` → full `player_name`
  - Tolerant of variants: `{firstname}`, `{firstName}`, with/without spaces.
- Accept new optional body fields:
  - `testEmail?: string` — when present, send to that address instead of the recipient and skip the `sent_at` / status update at the end.
  - `previewOnly?: boolean` — when true, return `{ success: true, html, subject }` without calling Resend or updating the invoice.
- Keep all existing auth, ownership checks, and i18n logic.

### 2. `src/components/invoices/BulkInvoiceEmailDialog.tsx`

Rework the dialog UI:

- Replace the single textarea with:
  - A message textarea (default placeholder shows example using `{first_name}`).
  - Helper chips/buttons below the textarea to insert `{first_name}`, `{last_name}`, `{full_name}` at cursor.
  - Short helper text explaining variables are replaced per recipient.
- Add two secondary actions next to Send:
  - **Preview** — opens a sub-dialog showing the rendered HTML for the first selected invoice (uses `previewOnly: true`). Renders inside an iframe / sandboxed div.
  - **Send test** — input for an email address (default: current user's email) + button; calls function with `testEmail` for the first selected invoice. Toast on success/failure.
- Keep "Mark invoices as sent" checkbox and bulk send loop untouched (server now handles status update on real send only).

### 3. Translations

Add new keys (NL/EN at minimum, others fall back) under `invoices.bulk.*`:
- `messageLabel`, `messagePlaceholder`, `variablesHelp`
- `insertFirstName`, `insertLastName`, `insertFullName`
- `preview`, `previewTitle`, `sendTest`, `sendTestPlaceholder`, `testSent`, `testFailed`

## Technical notes

- Variable substitution runs on the server in the edge function so it's consistent across preview, test, and real sends.
- For preview/test we use the first invoice in `invoiceIds` to get realistic recipient name + branding + URL.
- No DB schema changes required.
- No changes to `auto-create-invoice` or status logic from the previous fix.

## Files touched

- `supabase/functions/send-invoice-email/index.ts`
- `src/components/invoices/BulkInvoiceEmailDialog.tsx`
- `src/i18n/locales/nl/academy.json`, `src/i18n/locales/en/academy.json` (new keys)
