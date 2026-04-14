
Goal: restore actual PDF generation end-to-end so invoices can both download from the app and be attached when forwarded to the bookkeeper.

What I found
- The UI “PDF” buttons do not download a stored PDF at all. They call `generate-invoice`, expect `data.html`, open a new window, and trigger browser print. This exists in:
  - `src/pages/academy/AcademyEditInvoice.tsx`
  - `src/pages/trainer/TrainerEditInvoice.tsx`
  - `src/pages/academy/AcademyInvoices.tsx`
  - `src/pages/trainer/TrainerInvoices.tsx`
  - `src/components/trainer/InvoiceList.tsx`
  - `src/components/player/PlayerInvoicesTab.tsx`
- The backend function `supabase/functions/generate-invoice/index.ts` does generate a real PDF and uploads both:
  - `${folderKey}/${invoice.invoice_number}.html`
  - `${folderKey}/${invoice.invoice_number}.pdf`
- But the function currently stores `pdf_url` using a signed URL created for the HTML file, not the PDF:
  - `createSignedUrl(fileName, 3600)` where `fileName` is `.html`
  - then updates `invoices.pdf_url` with that HTML URL
- The screenshot also shows `generate-invoice` is currently failing with `500`, so even the PDF upload path is breaking before the UI can use it.

Implementation plan

1. Fix `generate-invoice` runtime failure first
- Inspect the latest backend logs for `generate-invoice` and patch the exact crash.
- Most likely harden the function around optional invoice/business fields and any unsafe assumptions in PDF creation.
- Keep the function returning success even if HTML/PDF generation differs, but log clearly when PDF upload fails.

2. Correct the generated file URLs
- In `supabase/functions/generate-invoice/index.ts`:
  - create a signed URL for the PDF file, not the HTML file
  - store that PDF signed URL in `invoices.pdf_url`
  - optionally also return both URLs in the response:
    - `pdfUrl`
    - `htmlUrl`
- This fixes downstream flows that rely on `pdf_url`.

3. Replace print-based “PDF download” behavior in the UI
- Update all invoice download handlers to use a real file download flow:
  - call `generate-invoice`
  - prefer `data.pdfUrl`
  - if unavailable, fall back to downloading the PDF directly from storage path if possible
  - open/download the PDF via an anchor or fetched blob instead of `window.print()`
- Reuse the existing blob-download pattern already used in `src/pages/admin/AdminBackups.tsx`.

4. Make forwarding strictly PDF-first
- Keep the existing generation-on-demand behavior in `forward-invoice`.
- Tighten it so the bookkeeper email only uses the PDF path and PDF signed URL.
- Remove the misleading HTML-based download link source:
  - today `pdfLink` is derived from the signed URL of the `.html` file
- Use the PDF signed URL in the email CTA so both the attachment and link point to a real PDF.

5. Verify invoice edit/regeneration flow
- Keep the existing `pdf_url: null` reset after invoice edits.
- Confirm the next download/forward action regenerates the PDF correctly after edits in:
  - academy edit
  - trainer edit
  - player billing edits
  - shared edit dialog

Technical details
- Root issue 1: UI is not downloading PDFs; it is printing HTML.
- Root issue 2: backend stores an HTML signed URL inside `pdf_url`.
- Root issue 3: current `generate-invoice` runtime error (500) is blocking both download and forwarding regeneration.

Files to update
- `supabase/functions/generate-invoice/index.ts`
- `supabase/functions/forward-invoice/index.ts`
- `src/pages/academy/AcademyEditInvoice.tsx`
- `src/pages/trainer/TrainerEditInvoice.tsx`
- `src/pages/academy/AcademyInvoices.tsx`
- `src/pages/trainer/TrainerInvoices.tsx`
- `src/components/trainer/InvoiceList.tsx`
- `src/components/player/PlayerInvoicesTab.tsx`

Validation after implementation
- Download PDF from academy invoice edit page
- Download PDF from trainer invoice pages
- Download PDF from player invoice tab
- Forward a paid invoice to the bookkeeper and confirm:
  - attachment is `.pdf`
  - email link opens a PDF
- Edit an invoice, regenerate, and confirm the newly downloaded/forwarded file reflects the changes
- Check the full flow end-to-end with one academy invoice and one trainer invoice
