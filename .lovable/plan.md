

# Fix: Invoice PDF Missing Academy Business Details & Branding

## Problem
The `generate-invoice` edge function (line 244-248) always fetches business details from `trainer_profiles` only. When an invoice belongs to an academy (`academy_profile_id` is set), the academy's business name, address, KvK, BTW, IBAN, logo, etc. should be used instead. Currently these fields are empty because the trainer may not have them filled in — the academy does.

## Fix

### `supabase/functions/generate-invoice/index.ts`

After fetching the invoice (line 230-241), add an academy lookup:

1. If `invoice.academy_profile_id` is set, fetch `academy_profiles` for: `name, business_name, business_address, kvk_number, btw_number, iban, bic, invoice_logo_url, payment_terms_days`
2. Use academy details as the "trainer" data in the invoice template (the "Van" section), falling back to trainer profile only when no academy is present
3. Also add academy manager authorization check — currently only trainer and player are checked, but academy managers should also be able to generate invoices for their academy's invoices

Changes are confined to the data-fetching section (~lines 243-306). The HTML template itself doesn't need changes — it already renders whatever is in the `trainer` object.

### Files
- `supabase/functions/generate-invoice/index.ts` — Add academy profile lookup, use academy details when `academy_profile_id` is present, add academy manager auth check

