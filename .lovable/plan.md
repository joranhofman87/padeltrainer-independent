

# Academy Invoices Page

## Summary
Add a dedicated invoices page under the "Zakelijk" (Business) section for academies to manage all invoices across their trainers. Includes Mollie payment link generation per invoice and webhook-based status updates.

## Current State
- `invoices` table has `trainer_id` but no `academy_profile_id` — academies see nothing
- `create-mollie-payment` edge function only works for booking-based payments (requires slotId, player auth)
- `mollie-webhook` updates bookings on payment, and triggers `auto-create-invoice`
- Existing `InvoiceList` component works for individual trainers only
- Sidebar already has a "Zakelijk" group with Settings, Subscription, Earnings

## Plan

### Step 1: Database Migration
- Add `academy_profile_id` (nullable FK) + `mollie_payment_id` + `mollie_payment_url` columns to `invoices`
- Add RLS policy: academy managers can SELECT/UPDATE invoices where `academy_profile_id` matches their academy
- Add index on `academy_profile_id`

### Step 2: New Edge Function `create-invoice-payment`
Generates a Mollie payment link for an existing invoice (no booking/slot required):
- Input: `invoiceId`
- Looks up invoice, finds academy Mollie account via `academy_profile_id` (or trainer's account via `trainer_id`)
- Creates Mollie payment with invoice metadata (`invoice_id` in metadata)
- Stores `mollie_payment_id` and checkout URL on the invoice row
- redirectUrl points to a public payment success page
- webhookUrl points to `mollie-webhook`

### Step 3: Update `mollie-webhook`
- After existing booking logic, add a check: if `payment.metadata.invoice_id` exists, update that invoice's status to `paid` + set `paid_at`
- This handles the callback when someone pays via an invoice payment link

### Step 4: New Page `AcademyInvoices.tsx`
Route: `/app/academy/invoices`

**Layout:**
- Header with title + link to settings page for invoice details
- Summary stats cards: Total unpaid amount, # draft, # sent/overdue, # paid
- Tab-style filter: All | Draft | Sent/Overdue | Paid
- Invoice list (reusable card-style, similar to trainer InvoiceList)

**Per invoice actions:**
- Draft: "Send" (mark as sent), "Delete", "Download PDF"
- Sent/Overdue: "Generate payment link" (creates Mollie link, copies to clipboard), "Mark as paid", "Download PDF"
- Paid: "Forward to bookkeeping", "Download PDF"

**Bulk actions:**
- "Send all drafts" button — marks all draft invoices as sent
- "Generate payment links" — creates Mollie links for all sent/overdue invoices

### Step 5: Update Sidebar + Routes
- Add "Invoices" nav item in the Business group (between Earnings and Settings)
- Add route `/app/academy/invoices` in DomainRouter.tsx
- Update `businessOpen` state to include `/app/academy/invoices`

### Step 6: Wire invoice creation to academy
- Update `auto-create-invoice` edge function: when trainer is part of academy, also set `academy_profile_id` on the created invoice

### Step 7: Translations
Add keys to `en/academy.json` and `nl/academy.json` for the invoices page.

## Files
- **Migration**: Add columns + RLS to `invoices`
- `supabase/functions/create-invoice-payment/index.ts` — New edge function
- `supabase/functions/mollie-webhook/index.ts` — Add invoice payment handling
- `supabase/functions/auto-create-invoice/index.ts` — Set `academy_profile_id`
- `src/pages/academy/AcademyInvoices.tsx` — New page
- `src/components/academy/AcademySidebar.tsx` — Add nav item
- `src/components/DomainRouter.tsx` — Add route
- `src/i18n/locales/en/academy.json` — Translations
- `src/i18n/locales/nl/academy.json` — Translations

