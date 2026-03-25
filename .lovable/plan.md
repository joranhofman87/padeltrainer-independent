

# Fix Academy Invoice Download

## Problem

`AcademyInvoices.tsx` tries to use `invoice.pdf_url` as a storage path to create a signed URL via `supabase.storage.from("invoices").createSignedUrl(...)`. But `pdf_url` contains a **full signed URL** (or is null), not a storage path. This always fails silently.

Meanwhile, the trainer's `InvoiceList.tsx` correctly calls the `generate-invoice` edge function, which returns fresh HTML for printing.

## Fix

Replace `handleDownloadPdf` in `AcademyInvoices.tsx` with the same approach used in `InvoiceList.tsx`: call `generate-invoice`, open the returned HTML in a new window, and trigger print.

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Replace `handleDownloadPdf` with `generate-invoice` function call + print window (matching `InvoiceList.tsx` pattern) |

The `generate-invoice` edge function already authorizes academy managers, so no backend changes needed.

