

# Fix VAT Calculation on Joran & Nick Invoices

## Root Cause

The trainer has `prices_include_vat = false`, meaning €46.25 is the **net** price (VAT gets added on top). But the invoices were manually patched using the **inclusive** formula (`740 / 1.09 = 678.90`, VAT = `61.10`), which is wrong.

Correct calculation (VAT-exclusive):
- Sessions: 16 × €46.25 = **€740.00** net, VAT 9% = **€66.60**
- Extra costs: 16 × €19.00 = **€304.00** net, VAT 0% = €0.00
- **Subtotal: €1,044.00 | VAT: €66.60 | Total: €1,110.60**

The `auto-create-invoice` edge function code actually handles this correctly (lines 298-300), so the bug is only in the manually patched data from earlier. Future auto-created invoices will be correct.

## Changes

**Data patch only** — update both invoices:

| Field | Wrong (current) | Correct |
|-------|-----------------|---------|
| subtotal | €982.90 | €1,044.00 |
| vat_amount | €61.10 | €66.60 |
| total | €1,044.00 | €1,110.60 |
| vat_breakdown 9% | subtotal: 678.90, vat: 61.10 | subtotal: 740.00, vat: 66.60 |
| vat_breakdown 0% | subtotal: 304, vat: 0 | unchanged |

Both INV-2026-0001 and INV-2026-0002 get the same correction. PDF URLs reset to null for regeneration.

Also check and fix INV-2026-0003 (Maarten) if it has the same issue.

