
# Fix Mollie 404 by Fetching Actual Profile ID

## Problem

The `profileId: "me"` shortcut is returning a 404 when creating payments with the connected account's access token. This likely means "me" isn't resolving to a valid website profile for this Mollie account.

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

Instead of hardcoding `profileId: "me"`, fetch the connected account's actual profile ID before creating the payment:

1. After obtaining the `recipientAccessToken`, call `GET /v2/profiles/me` using that token to get the real profile ID (e.g. `pfl_zcfJRjkf6P`)
2. Use the actual profile ID in the payment request
3. Add logging to capture the profile lookup result for debugging
4. If the profile lookup fails, fall back to the platform API key (no application fee)

**New logic (before payment creation):**
```typescript
let mollieProfileId: string | null = null;
if (recipientAccessToken) {
  const profileResp = await fetch('https://api.mollie.com/v2/profiles/me', {
    headers: { 'Authorization': `Bearer ${recipientAccessToken}` },
  });
  if (profileResp.ok) {
    const profile = await profileResp.json();
    mollieProfileId = profile.id;
    logStep("Mollie profile found", { profileId: mollieProfileId });
  } else {
    logStep("Could not fetch Mollie profile, falling back to platform", 
      { status: profileResp.status });
    recipientAccessToken = null; // fall back to platform key
  }
}
```

Then in the payment data:
```typescript
paymentData.profileId = mollieProfileId; // actual ID like "pfl_..."
```

## Files changed

- `supabase/functions/create-mollie-payment/index.ts` -- fetch actual profile ID instead of using "me"
