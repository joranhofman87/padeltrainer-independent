

# Add Manual Forward-to-Bookkeeper Button on Paid Invoices

## Problem
The trainer invoice list (`InvoiceList.tsx`) already has a forward button for paid invoices, but the academy invoice page (`AcademyInvoices.tsx`) — which RL Performance Academy uses — has no such button. Also, if the automatic forwarding via the webhook fails, there's no manual retry option visible.

## Changes

### `src/pages/academy/AcademyInvoices.tsx`

1. **Import `Mail` icon** from lucide-react
2. **Fetch forward emails** from `trainer_profiles.invoice_forward_emails` for the academy's trainers (or from the academy profile if stored there) — need to check where RL Performance Academy stores this setting
3. **Add a forward button** on paid invoices (both desktop table and mobile cards) that calls `supabase.functions.invoke('forward-invoice', { body: { invoiceId } })` with a toast on success/failure
4. Show the button on all paid invoices (not gated by `forwardEmails.length > 0` — the edge function already handles the "no emails configured" case gracefully)

### `src/components/trainer/InvoiceList.tsx`

5. **Remove the `forwardEmails.length > 0` gate** on the existing forward button (line 498) — show it on all paid invoices so trainers can always manually retry. The edge function returns a harmless "no forwarding emails configured" message if none are set.

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Add Mail icon import, add forward button on paid invoices (desktop + mobile) |
| `src/components/trainer/InvoiceList.tsx` | Show forward button on all paid invoices regardless of forwardEmails config |

