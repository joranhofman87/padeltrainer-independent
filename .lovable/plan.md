

# Fix: Always Attach PDF (Not HTML) to Bookkeeper Emails

## Problem

The `forward-invoice` edge function tries to download a PDF from storage, but when none exists (e.g. it was never generated, or was cleared after an edit), it silently falls back to attaching the `.html` file. The bookkeeper receives an HTML file instead of a proper PDF.

## Solution

In `forward-invoice`, when the PDF download fails, call `generate-invoice` first to create the PDF, then retry the download. This guarantees a PDF attachment.

### File: `supabase/functions/forward-invoice/index.ts`

**Change the PDF download section (lines 141-175):**

Instead of:
1. Try download PDF → if missing, fall back to HTML

Do:
1. Try download PDF
2. If missing, call `generate-invoice` to create it
3. Retry PDF download
4. Only fall back to HTML if the generation also fails (should be rare)

The call to `generate-invoice` is made server-to-server using the service role key, matching the existing pattern used in `auto-create-invoice` and `mollie-webhook`.

### Deploy

Redeploy `forward-invoice` after the change.

## File Summary

| File | Change |
|---|---|
| `supabase/functions/forward-invoice/index.ts` | Add generate-invoice call when PDF not found |

