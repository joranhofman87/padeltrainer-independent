

# Fix Payment Routing to Trainer's Account

## Problem

The `GET /v2/profiles/me` endpoint returns 403 with OAuth access tokens (Mollie only allows it with API keys). This triggers the fallback every time, so all payments go to the platform account instead of the trainer.

## Solution

When using the Mollie Connect Platform model with OAuth, you simply create the payment using the connected account's **access token** -- no `profileId` needed. Mollie automatically routes the payment to that connected account. The `applicationFee` is then deducted and sent to the platform.

### Changes to `supabase/functions/create-mollie-payment/index.ts`

1. **Remove the `GET /v2/profiles/me` call entirely** -- it doesn't work with OAuth tokens and isn't needed
2. **When a valid `recipientAccessToken` exists**, just add the `applicationFee` to the payment data (no `profileId`)
3. **Create the payment using the access token** -- Mollie handles the routing automatically

The flow becomes:

```text
recipientAccessToken exists?
  YES --> Create payment with access token + applicationFee
          --> Money goes to trainer, platform fee goes to you
  NO  --> Create payment with platform API key
          --> Money goes to platform (fallback)
```

**Before (broken):**
- Fetch profile ID with access token --> 403 error --> fallback to platform key --> money goes to platform

**After (fixed):**
- Use access token directly --> payment created on trainer's account --> application fee deducted for platform

### Simplified payment creation block

```typescript
if (recipientAccessToken) {
  platformFee = Math.min(platformFee, amount);
  paymentData.applicationFee = {
    amount: { currency: "EUR", value: platformFee.toFixed(2) },
    description: "Platform fee",
  };
  logStep("Application fee configured", { recipientType, platformFee });
} else {
  logStep("No Mollie account found, payment goes to platform");
}

const authToken = recipientAccessToken || mollieApiKey;
```

## Files changed

- `supabase/functions/create-mollie-payment/index.ts` -- remove profile fetch, use access token directly with application fee

