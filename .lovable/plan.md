

# Secure Public Invoice Pages: No-Index + PII Protection

## Problem
1. Payment links (`/nl/academies/slug/pay/token`) could be indexed by search engines, exposing them publicly.
2. Once paid, the page still shows player name, line item details, and amounts — unnecessary PII exposure.

## Plan

### 1. Add `noindex` meta tag to `PublicInvoicePay.tsx`
- Import the existing `SEO` component and render it with `noIndex={true}` at the top of every render path (loading, paid, error, and active invoice views).
- This adds `<meta name="robots" content="noindex, nofollow">` preventing all search engine indexing.

### 2. Block payment URLs in `robots.txt`
- Add `Disallow: /*/pay/` to block crawlers that don't respect meta tags.

### 3. Strip PII from the "already paid" state
- **Edge function** (`get-public-invoice`): When status is `paid`, only return `invoiceNumber` and `status` — no player name, amounts, or line items (already partially done, just verify).
- **Frontend** (`PublicInvoicePay.tsx`): The paid state already shows a generic "Invoice X has been paid" message without details — confirm no PII leaks. Remove the invoice number display too, showing only "This invoice has been paid. Thank you!"

### 4. Strip PII from the "processing" redirect state
- After Mollie redirects with `?status=success`, show only "Your payment is being processed" without the invoice number.

## Files
- `src/pages/PublicInvoicePay.tsx` — Add `<SEO noIndex />`, sanitize paid/processing messages
- `public/robots.txt` — Add `Disallow: /*/pay/`
- `supabase/functions/get-public-invoice/index.ts` — Verify paid state returns minimal data (already correct)

