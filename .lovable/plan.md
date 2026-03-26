

# Make Invoice Payment Section More Compact (Fit on One Page)

## Problem
The Mollie payment section (QR code + link) takes too much vertical space, pushing the invoice to two pages. The branded header, payment box padding, and QR code size all contribute.

## Changes

**File**: `supabase/functions/generate-invoice/index.ts`

1. **Reduce branded header padding**: `24px 40px` → `14px 40px`, and logo max-height `48px` → `36px`
2. **Reduce payment-info box**: padding `20px` → `14px`, margin-top `40px` → `20px`
3. **Shrink QR code**: from `120x120` (requesting `150x150`) → `80x80` (requesting `100x100`)
4. **Reduce text spacing** in payment section: smaller font, tighter margins
5. **Reduce invoice-container padding**: `40px` → `30px`
6. **Reduce header/parties margin-bottom**: `40px` → `24px`

These changes together should save ~150-200px of vertical space, keeping most invoices on a single page.

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Reduce padding/margins on branded header, invoice container, parties section, and payment-info box; shrink QR code; tighten text spacing |

