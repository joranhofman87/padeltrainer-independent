## Change

Update the email subject from `{number} - {academy}` to `{Invoice} {number} - {academy}`, localized.

The translations dictionary in `send-invoice-email/index.ts` already has a `subject` key per locale (Factuur, Invoice, Factura, Rechnung, Facture, Fattura).

## Edits

1. `supabase/functions/send-invoice-email/index.ts` (line 227): change to
   ```ts
   const subject = `${l.subject} ${invoice.invoice_number} - ${businessName}`;
   ```

2. `supabase/functions/forward-invoice/index.ts` (line 213): apply the same prefix. Reuse the same locale dictionary (or a minimal inline copy keyed on the academy/trainer locale already used in that file). Subject becomes:
   ```ts
   subject: `${subjectWord} ${invoice.invoice_number} - ${businessName || invoice.player_name}`,
   ```

No UI, schema, or translation file changes required.