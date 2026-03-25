

# Fix: Forward Invoice Ignores Academy Forwarding Emails

## Problem
The `forward-invoice` edge function only fetches forwarding emails from `trainer_profiles.invoice_forward_emails`. For academy invoices (like RL Performance Academy), the forwarding emails are stored on `academy_profiles.invoice_forward_emails` — which is never checked. The trainer profile has `null` for this field, so the function returns "No forwarding emails configured" silently.

## Fix

### `supabase/functions/forward-invoice/index.ts`

After fetching the trainer profile (line 76-80), add a fallback check: if the invoice has an `academy_profile_id`, fetch `academy_profiles.invoice_forward_emails` and use those if the trainer's are empty.

Logic change:
1. Keep existing trainer profile fetch
2. If `invoice.academy_profile_id` exists, also fetch `academy_profiles.invoice_forward_emails` and `business_name`
3. Use academy forwarding emails if trainer's are empty/null
4. Use academy `business_name` as fallback for the email footer
5. Authorization: if academy invoice, also allow academy managers (check `is_academy_manager` RPC)

This is ~15 lines added. No other files need changes.

| File | Change |
|------|--------|
| `supabase/functions/forward-invoice/index.ts` | Add academy_profiles fallback for forwarding emails and business name |

