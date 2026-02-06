

# Fix "A website profile is required for payments" Error

## Problem

When creating a payment using the trainer's OAuth `access_token`, Mollie requires a `profileId` parameter to identify which website profile to use. With API keys this is implicit, but with access tokens it must be specified.

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

Add `profileId: "me"` to the payment data when using a connected account's access token. The special value `"me"` tells Mollie to use the account's current/default website profile.

In the section where `applicationFee` is configured (when `recipientAccessToken` is set), also add:

```typescript
paymentData.profileId = "me";
```

This is a one-line addition. No other changes needed.

