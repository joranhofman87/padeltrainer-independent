## What this finding means

`supabase/functions/generate-invoice/index.ts` builds the invoice HTML with raw template literals. User-controlled fields (player name, business name, address, BTW number, notes, line item descriptions/dates, even trainer business fields) are interpolated **without HTML escaping**.

On its own this HTML is only delivered to authorised callers, but two things make it a real XSS sink:

1. `src/lib/downloadInvoicePdf.ts` falls back to `printWindow.document.write(data.html)` when no `pdfUrl` is returned. Any `<script>` / `onerror=` payload in the HTML executes in the trainer's browser.
2. `update-public-invoice-details` lets an unauthenticated holder of a public invoice token write `playerBusinessName`, `playerAddress`, `playerBtwNumber`. So a player (or anyone with the public link) can plant a payload that fires when the trainer downloads the invoice and the PDF path fails.

## Fix plan

### 1. Escape all user-controlled fields in `generate-invoice/index.ts`

Add a helper at top of the file:

```ts
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
```

Wrap every interpolated user/trainer string in `generateInvoiceHTML()`:

- `invoice.trainer.business_name`, `business_address`, `kvk_number`, `btw_number`, `iban`, `bic`
- `invoice.player_business_name`, `player_name`, `player_address`, `player_btw_number`
- `invoice.invoice_number` (defence in depth)
- `invoice.notes`
- Line items: `item.description` (and the formatted date string is safe, but wrap to be consistent)
- `invoice.logo_url` inside `src="..."` and `alt`
- `invoice.payment_url` in `href` — additionally validate it starts with `https://` to block `javascript:` URLs

Numeric/date/currency outputs from `Intl.NumberFormat` / `formatDate` / `formatCurrency` don't need escaping.

The PDF rendering path already runs through `sanitize()` and `pdf-lib` — no XSS risk there, no change needed.

### 2. Remove the unsafe `document.write` fallback in `src/lib/downloadInvoicePdf.ts`

Replace the HTML print-window fallback with a clear error toast/return value. If we ever want a print fallback later, render into a sandboxed iframe (`sandbox="allow-same-origin"` only, no `allow-scripts`) instead of `document.write`. Callers already handle a `false` return.

### 3. (defence in depth) length-cap the public-write fields

In `update-public-invoice-details`, trim and cap `playerBusinessName` / `playerAddress` / `playerBtwNumber` to sane lengths (e.g. 200 / 500 / 32 chars). Out of scope for this XSS fix but cheap and prevents abuse of the same input vector — flag only, do not block this PR on it.

## Files touched

- `supabase/functions/generate-invoice/index.ts` — add `esc()`, wrap interpolations, validate `payment_url` / `logo_url` schemes
- `src/lib/downloadInvoicePdf.ts` — drop `document.write` fallback, return false / surface error

## Verification

- Manually re-render an invoice where a field contains `<img src=x onerror=alert(1)>` and confirm it appears as literal text in both the served HTML and any fallback path.
- Generate a normal invoice and confirm PDF + HTML still render correctly (apostrophes, ampersands, accented characters in names/addresses look right).
- Mark the `invoice_html_xss` finding fixed after deploy.
