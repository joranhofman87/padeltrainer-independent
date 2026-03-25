

# Skip Invoice Generation for Manual Payment Cycles

## Changes

### 1. Remove auto-invoice call for manual payment
In `src/pages/BookLesson.tsx` (lines 309-312), remove the block that calls `auto-create-invoice` when `paymentTiming === 'manual'`. This ensures no invoice is generated when a cycle is marked as manually paid.

### 2. Update help text to mention "no invoice"
In `src/i18n/locales/en/cycles.json`, update `form.paymentManualHelp` from:
> "You handle payment collection yourself (cash, bank transfer, etc.)"

to:
> "You handle payment collection yourself (cash, bank transfer, etc.). No invoice will be generated."

| File | Change |
|------|--------|
| `src/pages/BookLesson.tsx` | Remove lines 309-312 (auto-create-invoice call for manual payment) |
| `src/i18n/locales/en/cycles.json` | Update `paymentManualHelp` to mention no invoice is generated |

