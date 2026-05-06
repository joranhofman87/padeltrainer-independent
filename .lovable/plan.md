## Root cause

The bookkeeper email for invoice 26000214 was sent without a PDF attachment. Logs from `forward-invoice` show:

```
PDF not found in storage, triggering generate-invoice...
Could not obtain PDF even after generation attempt, sending without attachment
```

The PDF cannot be regenerated because `generate-invoice` is broken. Its trainer profile query selects a column that no longer exists:

```ts
// supabase/functions/generate-invoice/index.ts (line ~615)
.from('trainer_profiles')
.select('business_name, ..., logo_url, invoice_logo_url')
```

Confirmed via the DB: `trainer_profiles` has only `invoice_logo_url` — `logo_url` was removed. This makes the Postgres query fail, the function returns `Trainer profile not found` (404), so:

1. `forward-invoice` cannot generate the PDF on the fly → bookkeeper gets email without attachment.
2. Any newly-created academy invoice with a `trainer_id` (most of them) never gets a `pdf_url` saved either. DB confirms: every recent academy invoice for this trainer has `pdf_url IS NULL` and no PDF in storage.

This is a regression — older invoices in storage exist for invoices without a `trainer_id`, but every invoice that has a trainer is broken.

## Fix

### 1. Remove the dead `logo_url` reference in `generate-invoice`

In `supabase/functions/generate-invoice/index.ts`:

- In the `trainer_profiles` select, drop `logo_url` and keep `invoice_logo_url`.
- In the `InvoiceData` build (lines 731-732), remove the `trainerProfile?.logo_url` fallback. Use `invoice_logo_url` only, then fall back to `academyProfile?.logo_url` / `invoice_logo_url` as today.

### 2. Backfill missing PDFs (optional but recommended)

The 100+ existing academy invoices currently have no PDF in storage. After the fix:
- Adding a small admin action / one-off script that re-invokes `generate-invoice` for invoices where `pdf_url IS NULL` will heal historical data.
- For 26000214 specifically, simply re-sending the bookkeeper email after the fix will trigger `generate-invoice` and attach the PDF.

### 3. Verify

- Call `generate-invoice` for invoice 26000214 → expect `pdfUrl` returned and a `.pdf` object in the `invoices` storage bucket.
- Re-trigger forward to bookkeeper → expect the email to include the PDF attachment.

## Scope of change

- `supabase/functions/generate-invoice/index.ts` — one select string + two property references.
- No DB schema, RLS, or UI changes needed.
