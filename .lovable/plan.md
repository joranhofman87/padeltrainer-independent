

# Fix Invoice Visibility + Add Invoice Email Forwarding

## Problem 1: Invoices Tab Not Visible

The "Invoices" tab on the Earnings page is currently **only shown when manual invoicing is enabled** (line 662-666 in `TrainerEarnings.tsx`). Since invoices are now auto-generated for ALL bookings (Mollie + manual + approval), the Invoices tab must always be visible regardless of the payment mode setting.

**Fix**: Remove the `useManualInvoicing` condition wrapping the Invoices tab trigger and its content. The tab and `InvoiceList` should always render when `trainerInfo` is available.

## Problem 2: Pending Payments Not Showing

The pending payments list filters bookings to those with status `completed` or `confirmed` (with `payment_timing === 'after'`) AND `payment_status` of `pending` or `invoiced`. If bookings are being auto-invoiced and their status updates to something else, they may disappear from the pending list. Will verify the query logic aligns with the new auto-invoice flow -- the `auto-create-invoice` function sets invoice status to `sent` but should not be changing the booking `payment_status` unless explicitly coded.

**Fix**: Ensure the pending payments filter also accounts for bookings where an invoice exists but the booking itself hasn't been marked paid yet. The current filter logic should work if the booking `payment_status` remains `pending` or `invoiced`.

## Feature: Forward Paid Invoices via Email

Allow trainers to configure one or more email addresses where paid invoices are automatically forwarded (for bookkeeping software integration or self-notification).

### Database Changes

Add a column to `trainer_profiles`:
- `invoice_forward_emails` (text array, nullable) -- stores multiple email addresses

### UI Changes: InvoiceSettingsCard

Add a new section "Invoice forwarding" with:
- A list of configured email addresses (chips/tags)
- An input to add new email addresses
- A remove button per email
- Helper text explaining that paid invoices (PDF) will be sent to these addresses

### Backend: New Edge Function or Extend Existing

When an invoice is marked as paid (either via `handleMarkPaid` in `InvoiceList` or automatically), trigger an email to all configured forwarding addresses with the invoice PDF attached/linked.

Two trigger points:
1. **InvoiceList.tsx** `handleMarkPaid` -- after successfully updating status to paid, invoke the forwarding function
2. **auto-create-invoice** -- for Mollie payments that are already paid, the invoice is created with status `sent`; when marked paid later, same flow applies

Create a new edge function `forward-invoice` that:
- Accepts `invoiceId` and `trainerId`
- Fetches the invoice (including PDF URL) and trainer's `invoice_forward_emails`
- If no forwarding emails configured, skip silently
- Sends an email via Resend to each address with invoice details and a PDF download link

### InvoiceList: Add Manual Forward Button

Add a "Forward" button (mail icon) on paid invoices so trainers can also manually trigger forwarding at any time, not just at the moment of marking paid.

---

## Technical Summary

| File | Change |
|------|--------|
| Migration SQL | Add `invoice_forward_emails text[]` to `trainer_profiles` |
| `TrainerEarnings.tsx` | Remove `useManualInvoicing` condition from Invoices tab; always show it |
| `InvoiceSettingsCard.tsx` | Add forwarding emails section (add/remove emails, save to DB) |
| `InvoiceList.tsx` | Add forward button on paid invoices; auto-forward on mark-paid |
| `TrainerEarnings.tsx` | Pass `invoice_forward_emails` to settings card; update `TrainerBusinessInfo` interface |
| New: `supabase/functions/forward-invoice/index.ts` | Edge function that emails invoice PDF link to configured addresses via Resend |

