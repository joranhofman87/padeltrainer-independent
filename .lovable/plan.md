

# Fix Public Invoice Page Crash + Academy-Scoped URLs

## Problem
1. **Crash**: `Cannot read properties of undefined (reading 'toFixed')` — line item `total`, `subtotal`, `vatAmount` etc. can be null/undefined, causing the page to crash.
2. **URL structure**: Current `/pay/:token` doesn't fit the site's SEO/branding pattern. User wants `/:lang/academies/:slug/pay/:token` for consistency.

## Plan

### Step 1: Fix the crash — null-safe number formatting
In `PublicInvoicePay.tsx`, add a `formatEuro` helper (same European style as invoices page) with null safety:
```typescript
const formatEuro = (amount: number | null | undefined) =>
  (amount ?? 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
```
Replace all `.toFixed(2)` calls with `formatEuro()` — covers line items, subtotal, vatAmount, total, and the pay button.

### Step 2: Add academy-scoped route
In `DomainRouter.tsx`, add a new route under the language routes:
```
/:lang/academies/:slug/pay/:token → PublicInvoicePay
```
Keep the existing `/pay/:token` route as a fallback/legacy redirect.

### Step 3: Update edge function to return academy slug
In `get-public-invoice/index.ts`, also select `slug` from `academy_profiles` and return it in the response so the frontend can build canonical URLs.

### Step 4: Update share link generation
In `AcademyInvoices.tsx`, update the "Copy payment link" to generate the new academy-scoped URL format: `/{lang}/academies/{slug}/pay/{token}`.

### Step 5: Update Mollie redirect URL
In `create-invoice-payment/index.ts`, update the redirect URL to use the academy-scoped format when academy data is available.

## Files
- `src/pages/PublicInvoicePay.tsx` — Fix null-safe formatting, accept slug param
- `src/components/DomainRouter.tsx` — Add `/:lang/academies/:slug/pay/:token` route
- `supabase/functions/get-public-invoice/index.ts` — Return academy slug
- `supabase/functions/create-invoice-payment/index.ts` — Update redirect URL with academy slug
- `src/pages/academy/AcademyInvoices.tsx` — Update share link format

