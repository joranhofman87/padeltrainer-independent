

# Fix Split Invoice Calculation for Multi-Rate VAT

## Root Cause

The split payment correction in `auto-create-invoice` (lines 344-358) is broken for invoices with **multiple VAT rates**:

1. `unsplitTotal` captures the sum of **excl-VAT** line items = €2,088
2. The correction sets `totalInclusive = floor(2088/4) = €522.00` — treating this as the final total
3. It then recalculates VAT using a **single** `vatRate` (9%), ignoring that baanhuur is 0%

**Result**: each invoice = €522.08 instead of the correct €555.30 (= €2,221.20 ÷ 4). The VAT on training sessions (€33.30 per person) is effectively lost.

Maarten's unsplit invoice (INV-2026-0003) is correct at €2,221.20, confirming the expected total.

## Fix

### 1. Code fix in `auto-create-invoice/index.ts` (lines 342-358)

Skip the split total correction when `hasMultipleVatRates` is true. The per-line VAT calculation (lines 288-327) already handles split prices correctly — each line item was divided by N and VAT calculated individually. The single-rate override destroys this.

```typescript
// Only apply split correction for single-rate VAT
if (unsplitTotal !== null && splitAmongPlayers && splitAmongPlayers > 1 && !hasMultipleVatRates) {
  // ... existing correction logic
}
```

### 2. Fix the 4 existing invoices via migration

Update INV-2026-0062 through 0065 with correct values:
- **subtotal**: €522.00 (370 training + 152 baanhuur)
- **vat_amount**: €33.30 (370 × 9%)
- **total**: €555.30
- **vat_breakdown**: `{0: {subtotal: 152, vat: 0}, 9: {subtotal: 370, vat: 33.30}}`
- Clear `pdf_url` to force regeneration

| File | Change |
|------|--------|
| `supabase/functions/auto-create-invoice/index.ts` | Add `&& !hasMultipleVatRates` guard to split correction block (line 344) |
| Migration SQL | Update totals on the 4 draft invoices to €555.30 each |

