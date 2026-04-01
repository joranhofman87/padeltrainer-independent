

# Fix forward-invoice Edge Function & Retrigger INV-2026-0068

## Root Cause

The `forward-invoice` Edge Function has **three fatal bugs** — it references variables that are never defined:

1. **`resend`** — `resend.emails.send(...)` is called on line 152, but `new Resend(resendApiKey)` is never assigned. This means every invocation crashes with `ReferenceError: resend is not defined`.
2. **`formatCurrency`** — used in the subject line and email body but never defined as a function.
3. **`EMAIL_LOGO`** — used in the email HTML but never defined as a constant.

This explains why the bookkeeper never received INV-2026-0068 (or any other forwarded invoice since this version was deployed). The function crashes before it can send anything.

## Fix

**File: `supabase/functions/forward-invoice/index.ts`**

Add the three missing definitions (matching the patterns in `send-invoice-email`):

```typescript
// After line 16 (after resendApiKey check):
const resend = new Resend(resendApiKey);

// At top level (before handler or inside try block):
const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);
```

## Deploy & Retrigger

1. Deploy the fixed `forward-invoice` edge function
2. Call the function with invoice ID `46a2e500-b0cd-42af-a65d-f851ef3805f7` using service-role auth to retrigger forwarding for INV-2026-0068
3. Check edge function logs to confirm successful send

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/forward-invoice/index.ts` | Add missing `resend`, `formatCurrency`, and `EMAIL_LOGO` definitions |

