

# Improve Public Invoice Page Design + Post-Payment CTA

## Problems
1. **Logo not showing** — The edge function tries `createSignedUrl()` on a full public URL stored in `invoice_logo_url`, which fails. It should use the URL directly since the `avatars` bucket is public.
2. **Missing business details** — The page doesn't show the academy's business name, address, KvK, BTW, or IBAN — all data configured in invoice settings.
3. **Basic design** — Needs a proper branded layout with academy banner, professional invoice styling.
4. **Post-payment CTA** — After paying, guests should see "Want an invoice? Create an account" which links to signup with context to auto-link their guest profile.

## Changes

### 1. Edge function: Return business details + fix logo
**File: `supabase/functions/get-public-invoice/index.ts`**

- Add `business_name, business_address, kvk_number, btw_number, iban, bic` to the academy_profiles select
- **Fix logo**: The `invoice_logo_url` field stores a full public URL (set via `getPublicUrl()` in settings). Stop calling `createSignedUrl()` — just pass the URL through directly.
- Return business details in the academy response object

### 2. Redesign public invoice page
**File: `src/pages/PublicInvoicePay.tsx`**

- **Full-width banner header** with academy logo + banner color (like a real invoice header)
- **From section**: Show academy business name, address, KvK, BTW number
- **To section**: Player name
- **Payment details footer**: Show IBAN and BIC for manual payment option
- **Professional styling**: Clean card layout, proper spacing, muted backgrounds
- European number formatting already in place

### 3. Post-payment CTA with academy context
**File: `src/pages/PublicInvoicePay.tsx`**

- On the "paid" and "processing" screens, show branded CTA: "Want to view your invoices and receipts? Create a free account"
- Link to `/app/signup/player` — the existing `link_guest_invoices_on_signup` DB trigger will automatically connect their invoices when they sign up with the same email

### 4. Update PublicInvoiceData interface
- Add `businessName`, `businessAddress`, `kvkNumber`, `btwNumber`, `iban`, `bic` to the academy type in the interface

## Files
- `supabase/functions/get-public-invoice/index.ts` — Fix logo URL, add business fields
- `src/pages/PublicInvoicePay.tsx` — Redesign with branding, business details, CTA

