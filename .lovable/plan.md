

# Fix: Stale Test-Mode Payment URL Being Reused

## Problem
The invoice `INV-2026-0048` already has a `mollie_payment_url` saved from when the platform key was still `test_`. The `create-invoice-payment` function (line 129-132) checks: "if already has a payment URL and not paid, return it." So it keeps returning the old test-mode checkout URL instead of creating a fresh live payment.

## Solution

### 1. Database migration — Clear stale test-mode payment data
Null out the old test payment references for all unpaid invoices so fresh live payments get created on next click:

```sql
UPDATE invoices
SET mollie_payment_id = NULL, mollie_payment_url = NULL
WHERE status != 'paid'
  AND mollie_payment_id IS NOT NULL;
```

### 2. No code changes needed
Once the stale URLs are cleared, clicking Pay will create a new payment using the now-live `MOLLIE_API_KEY`. The `isTestMode` check will correctly evaluate to `false` and no `testmode: true` flag will be sent.

## Files
- Database migration only (data cleanup)

