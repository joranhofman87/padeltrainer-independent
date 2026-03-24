

# Switch Mollie from Test Mode to Production

## What's happening
All 5 edge functions check if `MOLLIE_API_KEY` starts with `"test_"`. When it does, they add `testmode: true` to every payment request — which is why the Mollie checkout shows "Note: this is a testmode payment."

This is **not** about RL Performance Academy's account — it's your **platform-level** Mollie API key that's a test key.

## What you need to do

### Step 1: Get your live API key from Mollie
1. Go to [Mollie Dashboard](https://my.mollie.com/dashboard) → **Developers** → **API keys**
2. Copy your **Live API key** (starts with `live_`)
3. Make sure your Mollie account is fully activated (identity verified, bank account confirmed)

### Step 2: Update the secret
I'll use the `add_secret` tool to update `MOLLIE_API_KEY` with your live key. No code changes needed — all 5 edge functions already use the same `MOLLIE_API_KEY` environment variable.

## No code changes required
The logic `mollieApiKey.startsWith("test_")` will automatically detect the live key and stop adding `testmode: true`. All functions handle this correctly already:
- `create-mollie-payment` — booking payments
- `create-invoice-payment` — invoice payments  
- `mollie-webhook` — payment status callbacks
- `verify-mollie-payment` — payment verification
- `mollie-callback` — OAuth token exchange (unaffected)

## Important before switching
- Confirm your Mollie account is **fully verified** and approved for live payments
- The connected academy account (RL Performance) should also work in live mode automatically via OAuth
- Once switched, all new payments will be **real charges** — there's no going back per-payment

