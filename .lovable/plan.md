

# Secure Public Invoice Payment Links

## Problem
Using sequential invoice numbers (e.g. `/pay/INV-2026-001`) in public URLs is a privacy risk — anyone can guess the next invoice URL by incrementing the number.

## Solution
Use a random, unguessable token (UUID) instead of the invoice number in the public URL.

### Step 1: Database Migration
- Add `public_token` column (UUID, unique, default `gen_random_uuid()`) to the `invoices` table
- Backfill existing invoices with random tokens
- Add unique index on `public_token`

### Step 2: Public URL format
- URL becomes `/pay/{public_token}` e.g. `/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- Completely unguessable — no sequential pattern

### Step 3: Edge Function `get-public-invoice`
- Looks up invoice by `public_token` instead of `invoice_number`
- Returns only safe display data (amount, line items, academy branding) — no sensitive info

### Step 4: Public Invoice Page (`PublicInvoicePay.tsx`)
- Branded page showing invoice summary with academy logo/banner color
- "Pay now" button triggers Mollie checkout
- Post-payment: success message + "Create account to view your invoices" CTA

### Step 5: Share UI in `AcademyInvoices.tsx`
- "Copy payment link" button copies `/pay/{public_token}` URL
- Available for draft and sent invoices
- Trainer shares via WhatsApp/text

### Step 6: Guest-to-account linking (DB trigger)
- On new profile creation, match email against `guest_players` table
- Link matching invoices (`player_id = NULL`) to the new user profile

### Step 7: Translations
- EN and NL keys for share button, public page, success page

## Files
- **Migration**: Add `public_token` to `invoices`, backfill, add trigger for guest linking
- `supabase/functions/get-public-invoice/index.ts` — New edge function
- `src/pages/PublicInvoicePay.tsx` — New public payment page
- `src/pages/academy/AcademyInvoices.tsx` — Share/copy link buttons for draft+sent
- `src/components/DomainRouter.tsx` — Add `/pay/:token` route
- `supabase/functions/create-invoice-payment/index.ts` — Update redirect URL
- `src/i18n/locales/en/academy.json` — Translations
- `src/i18n/locales/nl/academy.json` — Translations
- `src/i18n/locales/de/academy.json` — Translations

