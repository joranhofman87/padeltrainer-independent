

# Fix: Auto-forward invoices after Mollie payment

## Problem
The "Facturen doorsturen" email addresses configured in trainer settings only receive invoices when:
- A trainer manually marks an invoice as paid (via the UI)
- A trainer manually clicks the forward button

When invoices are automatically created after a Mollie payment (the most common flow for paid invoices), the `auto-create-invoice` edge function does NOT call `forward-invoice`. So the configured email addresses never receive invoices for online payments.

## Solution
Add a call to `forward-invoice` at the end of the `auto-create-invoice` function, right after the invoice is successfully created and the PDF is generated. This ensures that every auto-generated paid invoice is immediately forwarded to the configured bookkeeping email addresses.

## Technical Details

### File: `supabase/functions/auto-create-invoice/index.ts`

After the PDF generation step (around line 214), add logic to:

1. Fetch the trainer's `invoice_forward_emails` from `trainer_profiles` (this field is not currently selected in the query on line 73 -- add it)
2. If the invoice status is `paid` and forward emails are configured, invoke the `forward-invoice` function with the new invoice ID
3. Log the result but treat failures as non-fatal (same pattern as the PDF generation)

The change is small -- roughly 10-15 lines added. No frontend changes needed since the feature is already wired up in the settings UI.

