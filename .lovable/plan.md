

# Fix Invoice Download + Add Academy Branding to Generated Invoice

## Problems

1. **Download may fail silently** — the `generate-invoice` function returns `{ html }` but any server-side error (e.g. missing trainer profile for academy-only invoices) would silently fail. Need to check edge function logs and add better error handling on the frontend.

2. **No academy branding** — the generated invoice HTML uses a generic green color (`#16a34a`) and doesn't apply the academy's `invoice_banner_color` or logo styling. The public payment page already uses these, but the PDF/print invoice does not.

## Fix

### 1. Update `generate-invoice` edge function

**Fetch `invoice_banner_color`** from `academy_profiles` (line 274 — add it to the select):
```
.select('name, business_name, business_address, kvk_number, btw_number, iban, bic, invoice_logo_url, invoice_banner_color, payment_terms_days')
```

**Pass banner color to the HTML generator** — add `banner_color` to the `InvoiceData` interface and pass it through.

**Update `generateInvoiceHTML`** to apply branding:
- Use `invoice.banner_color || '#16a34a'` as the accent color for the invoice title, table headers, and payment info section
- Add a colored banner bar at the top of the invoice when a banner color is set
- Style the logo more prominently in the header

### 2. Update HTML template styling

Replace the hardcoded green with the dynamic banner color:
- `.invoice-title` color → dynamic
- `.items-table th` background → light tint of banner color
- Add a top banner strip: `<div style="height: 6px; background: ${bannerColor}; ..."></div>`
- Payment info section border-left with banner color

### 3. Better error feedback on frontend

In `AcademyInvoices.tsx` `handleDownloadPdf`, log the actual error to console so we can debug if it fails again.

## Changes

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Add `invoice_banner_color` to academy select; add `banner_color` to InvoiceData; update HTML template to use dynamic branding colors |
| `src/pages/academy/AcademyInvoices.tsx` | Add `console.error` in the catch block for better debugging |

