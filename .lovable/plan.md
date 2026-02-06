

# Fix: Add `testmode` Parameter for OAuth Payments

## Problem

When using Mollie Connect with OAuth access tokens, the `testmode` parameter must be explicitly set to `true` for test payments. Unlike API keys (where `test_` prefix auto-enables test mode), OAuth tokens require this parameter explicitly. Without it, Mollie tries to process a live payment on the connected account, which fails because payment methods aren't activated in live mode yet.

From Mollie docs:
> "For organization-level credentials (such as your OAuth access tokens), you can enable the test mode by setting the `testmode` parameter to `true` in your Create Payment API call."

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

1. Check if the platform is using a test API key (starts with `test_`)
2. When using an OAuth access token AND the platform is in test mode, add `testmode: true` to the payment request
3. Also cap the application fee properly (from previous plan)

```typescript
// Detect test mode from platform API key
const isTestMode = mollieApiKey.startsWith("test_");

// When using OAuth token, explicitly set testmode
if (recipientAccessToken && isTestMode) {
  paymentData.testmode = true;
}
```

This ensures test payments work correctly on connected accounts while live payments remain unaffected.

## Files changed

- `supabase/functions/create-mollie-payment/index.ts` -- add `testmode: true` when using OAuth in test mode, and cap application fee below payment amount

