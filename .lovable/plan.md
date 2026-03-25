

# Fix Incorrect Split Invoice Totals and Recalculate All Unpaid Invoices

## Problem

Invoices 0059 (Rob, €1,044) and 0060 (Sander, €1,044) were created **before** the multi-rate VAT fix was deployed. The old code dropped VAT when splitting, so these show the excl-VAT subtotal as the total instead of adding 9% VAT on the training portion. Each should be ~€1,110.60 (or whatever €2,221.20 ÷ N works out to).

The code fix is already in place for new invoices — we just need to recalculate the existing broken ones.

## Approach

### 1. Create `recalculate-invoices` edge function

A one-off (but reusable) function that:
- Fetches all unpaid invoices (status in `draft`, `sent`, `pending`)
- For each invoice, recalculates `subtotal`, `vat_amount`, and `total` from the stored `line_items`, using the invoice's `prices_include_vat` flag and per-line `vat_rate`
- Updates the invoice record and clears `pdf_url` for regeneration
- Returns a summary of what was updated

This ensures every unpaid invoice's totals are mathematically consistent with its line items — regardless of when it was created.

### 2. Call it from the frontend or directly

Add a simple trigger (e.g. admin button or direct invocation) to run the recalculation. Can also be called via curl for a one-time fix.

### 3. Verify the `auto-create-invoice` multi-rate split path

Double-check one edge case: when `prices_include_vat = false` and `hasMultipleVatRates = true` and `splitAmongPlayers > 1`, the current code at lines 288-327 calculates correctly because:
- Line items are already divided by N (line 271-274)
- Per-line VAT is added on top of the divided excl-VAT prices
- The `!hasMultipleVatRates` guard correctly skips the broken single-rate override

This path is correct — no additional code changes needed in `auto-create-invoice`.

| File | Change |
|------|--------|
| `supabase/functions/recalculate-invoices/index.ts` | New edge function: recalculates totals from line items for all unpaid invoices |

The function will be invoked once to fix 0059, 0060, and any other affected invoices, and can be kept as a safety tool for future use.

