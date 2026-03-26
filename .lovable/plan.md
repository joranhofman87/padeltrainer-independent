

# Manual Fix for INV-2026-0002 (Split Price Correction)

## Problem

INV-2026-0002 currently has `unit_price: 130.5` (the full session price) instead of `65.25` (half, since it's split 1/2). The re-save didn't re-split because the split detection now works for *future* edits, but the existing data was already wrong.

## Current vs Correct Values

| Field | Current | Correct |
|-------|---------|---------|
| unit_price | 130.50 | 65.25 |
| line total | 2,088.00 | 1,044.00 |
| subtotal | 2,088.00 | 957.80 |
| vat_amount | 187.92 | 86.20 |
| total | 2,275.92 | 1,044.00 |

(VAT 9%, prices include VAT: subtotal = 1044/1.09 ≈ 957.80, vat = 86.20)

## Fix

Run a direct database update on the invoice to correct the unit_price and recalculate totals, then regenerate the PDF.

| Step | Action |
|------|--------|
| 1 | Update INV-2026-0002: set `unit_price` to 65.25, recalculate subtotal/vat/total, clear `pdf_url` |
| 2 | Invoke `generate-invoice` edge function to regenerate the PDF |

