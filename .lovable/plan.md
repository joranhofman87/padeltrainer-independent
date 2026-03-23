

# Generate Missing Invoices for Existing Bookings

## Problem
Rene has 836 confirmed bookings across 31 cycles with no invoices — they were created before the invoice trigger was added. We need a way to backfill draft invoices for these existing bookings.

## Approach
Add a **"Generate missing invoices"** button on the Academy Invoices page + a new edge function that scans all bookings for an academy's trainers and creates draft invoices for any that aren't yet covered by an existing invoice.

## Step 1: New Edge Function `backfill-invoices`
File: `supabase/functions/backfill-invoices/index.ts`

- Input: `academyProfileId`
- Finds all trainer IDs linked to the academy
- Queries all confirmed bookings for those trainers where `payment_status = 'pending'` and `paid_externally` is not true
- Excludes bookings already referenced in an existing invoice's `booking_ids` array
- Groups remaining bookings by `(cyclus_id, guest_player_id/player_id)` — one invoice per player per cycle
- Calls `auto-create-invoice` with `asDraft: true` for each group
- Returns count of invoices created

## Step 2: Add Button to `AcademyInvoices.tsx`
- Add a "Generate missing invoices" button in the header area (next to the settings link)
- Shows a loading spinner while running
- On completion, shows toast with count and refetches the invoice list
- Only visible when there are few/no invoices (or always visible as a utility action)

## Step 3: Translations
Add keys for the button label and success/error messages in EN and NL academy.json.

## Files
- `supabase/functions/backfill-invoices/index.ts` — New edge function
- `src/pages/academy/AcademyInvoices.tsx` — Add generate button
- `src/i18n/locales/en/academy.json` — Translations
- `src/i18n/locales/nl/academy.json` — Translations

