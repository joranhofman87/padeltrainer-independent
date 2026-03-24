

# Hide Bank Transfer Details When Mollie Is Connected

## Why
Mollie does not auto-match incoming bank transfers to invoices — even with the correct reference. Bank transfers bypass automatic payment tracking entirely, so showing them alongside the Mollie button encourages a path that requires manual reconciliation.

## Change

### `src/pages/PublicInvoicePay.tsx`
In the bank details section (~line 340), change the condition from `academy?.iban` to `academy?.iban && !invoice.hasMollieAccount`. This hides the entire bank transfer block when Mollie is connected, keeping the Pay button as the sole payment method.

When Mollie is **not** connected, bank details continue to show as the primary payment method (unchanged).

