# Invoice email improvements

## 1. Reply-To header
Invoices send from `noreply@app.padeltrainer.ai`. Add `reply_to` so player replies land in the trainer's/academy's inbox.

Resolution order per invoice:
- **Academy invoice** (`invoice.academy_profile_id` set): `academy_profiles.contact_email` → first of `invoice_forward_emails`
- **Trainer invoice**: first of `trainer_profiles.invoice_forward_emails` → trainer auth email
- None resolvable → omit `reply_to` (current behavior)

Apply in:
- `supabase/functions/send-invoice-email/index.ts` (player-facing email) — reply-to = trainer/academy
- `supabase/functions/forward-invoice/index.ts` (forward copy to trainer) — reply-to = player email so the trainer can reply directly

## 2. New subject line
Change from current `Factuur {number} - {player} - {amount}` to:

```
{invoice_number} - {sender_name}
```

Where `sender_name` is the academy `business_name` for academy invoices, otherwise the trainer's `business_name`. Localized prefix kept minimal (no extra noise — just number + sender). Test-mode prefix `[TEST]` preserved if currently applied.

Applies to `send-invoice-email` (and we'll mirror the format in `forward-invoice` for consistency).

## 3. Email body spacing
Add a visible spacing line / divider between the message text block ("Met sportieve groet, …") and the invoice details table in the `send-invoice-email` HTML template — e.g. a margin-top of ~32px on the details section plus a soft `<hr>` using the existing border color, so the two sections read as separate blocks.

## Out of scope
- No new DB fields. Optional dedicated "reply-to" settings field can be added later if requested.
