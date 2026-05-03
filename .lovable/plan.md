## Goal

Allow academy admins on `/app/academy/invoices` to select multiple invoices and run bulk actions: reset status to draft, send personalized email, or delete.

## UI changes — `src/pages/academy/AcademyInvoices.tsx`

1. Add a checkbox column (leftmost) in both the desktop table and mobile cards. Header has a "select all visible" checkbox. Clicking checkboxes does not trigger row navigation (stopPropagation).
2. Track `selectedIds: Set<string>` in state, scoped to the active tab. Clear on tab/filter change.
3. When `selectedIds.size > 0`, render a sticky bulk action bar above the table:
   - "X selected" + "Clear" link
   - Buttons: **Reset to draft**, **Send email**, **Delete**
4. **Reset to draft** — confirm dialog. Updates selected invoices: `status='draft'`, `sent_at=null`, `paid_at=null`. Skips already-draft. Toast with count.
5. **Delete** — confirm dialog. For drafts: hard delete; for others: set `status='cancelled'` (matches existing single-row logic).
6. **Send email** — opens a new `BulkInvoiceEmailDialog` (see below).

## New component — `src/components/invoices/BulkInvoiceEmailDialog.tsx`

- Props: `open`, `onClose`, `invoiceIds: string[]`, `onSent`.
- Shows recipient count and a `<Textarea>` for the custom message (optional, with placeholder explaining it will appear after the greeting).
- Optional checkbox: "Also mark as sent" (default on for drafts).
- "Send" button calls `send-invoice-email` for each invoice in sequence with `{ invoiceId, customMessage }`, collects results, shows a summary toast (sent / no email / failed), then invalidates the query.

## Edge function changes — `supabase/functions/send-invoice-email/index.ts`

1. Accept optional `customMessage: string` in request body. Validate it (string, max ~2000 chars, escape HTML before injecting).
2. In the email HTML template, insert a paragraph containing the custom message between the greeting (`Hi {first name},`) and the existing invoice details block. If empty, omit the paragraph.
3. Greeting already uses player first name (verify and standardize: derive `firstName = player_name.split(' ')[0]`).
4. Localize the static template strings using the academy's `default_invoice_language` (already stored on academy_profiles — look up; fallback to `nl`). Build small inline dictionaries for `nl/en/es/de/fr/it` covering greeting, intro, "Details", "Pay now" button, and footer. Payment link (`/pay/{public_token}`) and PDF attachment logic remain unchanged.

## Translations

Add `invoices.bulk.*` keys to `src/i18n/locales/{en,nl,es,de,fr,it}/academy.json`:
- `selected`, `clear`, `resetToDraft`, `sendEmail`, `delete`
- Confirmation dialog titles/descriptions
- `bulkEmailDialog.title`, `recipientCount`, `customMessageLabel`, `customMessagePlaceholder`, `markAsSent`, `send`, `sending`
- Result toast templates: `bulkResetDone`, `bulkDeleteDone`, `bulkEmailDone` (with `{{sent}}/{{noEmail}}/{{failed}}`)

## Out of scope

- Bulk PDF download / forward to bookkeeper (not requested).
- Trainer invoices page — same pattern can be applied later if requested.
- Persisting custom message templates.

## Acceptance

- Selecting rows shows the bulk bar; actions affect exactly the selected invoices.
- Reset returns invoices to draft and they reappear in "Send all drafts" flow.
- Delete behaves identically to single-row delete (drafts hard-deleted, others cancelled).
- Email recipients receive a localized email containing greeting + custom message + invoice details + payment link.
