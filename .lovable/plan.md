

# Fix PDF Invoice: Logo, Layout, and Payment Link

## Problems

1. **No logo in PDF** — The HTML version embeds the logo via `<img>`, but `generateInvoicePDF()` only draws a colored rectangle with text. The `logo_url` from the invoice data is completely ignored in the PDF path.

2. **Layout misalignment** — The table columns total only 480pt (`250+50+90+90`) but the page content area is ~495pt. The totals section and payment info box don't stretch to match properly.

3. **Payment link on paid invoices** — The code builds `paymentUrl` based on whether Mollie is connected and a `public_token` exists, but never checks the invoice's `status`. Paid invoices should show IBAN details instead of a payment link.

## Solution

### File: `supabase/functions/generate-invoice/index.ts`

**A) Embed logo in PDF header**
- When `invoice.logo_url` is set, fetch the image, embed it into the PDF document using `pdfDoc.embedPng()` or `pdfDoc.embedJpg()`, and draw it in the header bar
- Fall back to text-only header when logo fetch fails or no logo is configured

**B) Fix table column widths**
- Adjust `colWidths` to use the full content width (`width - 2 * margin = ~495pt`)
- Right-align the totals block to match the table's right edge
- Adjust payment info box width to match table width

**C) Conditionally exclude payment link for paid invoices**
- In the handler (around line 633), check `invoice.status` — if `'paid'`, set `paymentUrl = null` regardless of Mollie connection
- This applies to both HTML and PDF outputs since they share the same `invoiceData`

### Deploy
Redeploy `generate-invoice` after changes.

## File Summary

| File | Change |
|---|---|
| `supabase/functions/generate-invoice/index.ts` | Embed logo in PDF, fix column widths, skip payment link when paid |

