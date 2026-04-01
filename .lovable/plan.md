

# Attach PDF Invoice to Bookkeeper Forwarding Email

## Current State
- `generate-invoice` creates a well-structured **HTML** invoice, stores it in Supabase Storage as `.html`, and returns the HTML to the browser (where trainers print-to-PDF)
- `forward-invoice` downloads the `.html` file and attaches it to the bookkeeper email — bookkeepers can't auto-scan HTML files

## Approach: Generate PDF alongside HTML in `generate-invoice`

Since Deno edge functions don't have a browser/DOM for HTML-to-PDF conversion, we'll use **`pdf-lib`** (works natively in Deno) to build a clean, OCR-friendly PDF programmatically. We reuse all the same invoice data that's already fetched — just render it to PDF format instead of HTML.

The PDF gets stored in the same Storage bucket alongside the HTML. Then `forward-invoice` simply downloads the `.pdf` instead of the `.html`.

## Changes

### 1. `supabase/functions/generate-invoice/index.ts`
- Import `pdf-lib` (`https://esm.sh/pdf-lib@1.17.1`)
- Add a `generateInvoicePDF(invoice: InvoiceData): Promise<Uint8Array>` function that builds a structured PDF with:
  - Colored header bar with business name
  - Invoice number, dates
  - From/To party details (business name, address, KvK, BTW)
  - Line items table (description, quantity, price, amount)
  - Subtotal, VAT breakdown, total
  - Payment info (IBAN or payment URL)
  - Notes if present
- After uploading the `.html`, also upload `{folder}/{invoice_number}.pdf` to the `invoices` bucket
- Return the PDF signed URL as well

### 2. `supabase/functions/forward-invoice/index.ts`
- Change download path from `.html` to `.pdf`
- Change attachment filename from `{number}.html` to `{number}.pdf`
- Update the folder resolution to also check academy folder (same logic as generate-invoice uses `trainerProfile?.user_id || invoice.academy_profile_id || 'custom'`)

## PDF Layout (text-based, bookkeeper-scannable)

```text
┌──────────────────────────────────┐
│  [Colored bar: Business Name]    │
├──────────────────────────────────┤
│  FACTUUR          INV-2026-0068  │
│                   Datum: ...     │
│                   Vervaldatum:   │
│                                  │
│  Van:             Aan:           │
│  Business Name    Player Name    │
│  Address          Address        │
│  KvK / BTW        BTW            │
│                                  │
│  ┌─────┬───┬──────┬──────┐      │
│  │Omschr│Qty│Prijs │Bedrag│      │
│  ├─────┼───┼──────┼──────┤      │
│  │...   │ 1 │€50  │€50   │      │
│  └─────┴───┴──────┴──────┘      │
│                                  │
│            Subtotaal: €50.00     │
│            BTW 21%:   €10.50     │
│            Totaal:    €60.50     │
│                                  │
│  Betalingsgegevens:              │
│  IBAN: NL... / Ref: INV-...     │
└──────────────────────────────────┘
```

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Add `pdf-lib` PDF generation; upload `.pdf` alongside `.html` |
| `supabase/functions/forward-invoice/index.ts` | Download and attach `.pdf` instead of `.html`; fix folder path |

