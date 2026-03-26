

# Filter Out 0% VAT Rows from Invoice

## Problem
The invoice VAT breakdown section shows "BTW 0%" even when the VAT amount for that rate is €0.00. This happens because the `vat_breakdown` object contains a 0% entry from line items that have 0% VAT rate, but if there's no actual value it shouldn't be displayed.

## Fix

**File**: `supabase/functions/generate-invoice/index.ts` (lines 164-172)

Add a filter to skip VAT breakdown entries where the VAT amount is 0:

```typescript
Object.entries(invoice.vat_breakdown)
  .filter(([_, data]) => (data as any).vat !== 0)  // Skip 0 VAT rows
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([rate, data]) => `...`)
```

Also adjust the condition for when to use multi-rate display: only count rates that actually have a non-zero VAT amount.

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Lines 164-172: Filter out VAT breakdown entries where `vat === 0` |

