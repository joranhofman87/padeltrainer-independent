

# Switch from Routing to Application Fees (Mollie Connect Platform model)

## Problem

The current code uses Mollie's **routing** (split payments), which is designed for the **Marketplace** model. Your Mollie Connect setup uses the **Platform** model, which requires **Application fees** instead. That's why Mollie rejects the payment with "Routing not allowed for provided organization".

## How Application Fees Work

Instead of creating the payment on your platform account and splitting it, you:

1. Create the payment **on the connected account** (trainer/academy) using **their OAuth access token**
2. Add an `applicationFee` parameter with your platform fee
3. Mollie automatically moves the fee to your platform account

The trainer receives the payment minus your fee and the Mollie transaction costs.

## Changes

### `supabase/functions/create-mollie-payment/index.ts`

**1. Fetch the access token** (not just the organization ID)

Update the trainer and academy Mollie lookups to also retrieve `access_token` alongside `mollie_organization_id`. The access token is needed to create payments on their behalf.

**2. Replace routing with Application fees**

Replace the `routing` block (lines 218-234):

```
// OLD (routing - marketplace model)
paymentData.routing = [{
  amount: { currency: "EUR", value: (amount - platformFee).toFixed(2) },
  destination: { type: "organization", organizationId: recipientMollieId }
}];
```

With the Application fee approach:

```
// NEW (application fee - platform model)
paymentData.applicationFee = {
  amount: { currency: "EUR", value: platformFee.toFixed(2) },
  description: "Platform fee"
};
```

**3. Use the connected account's access token** for the Mollie API call

When a trainer/academy Mollie account is found, use their `access_token` in the Authorization header instead of the platform `MOLLIE_API_KEY`:

```
const authToken = recipientAccessToken || mollieApiKey;

const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${authToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(paymentData),
});
```

**4. Rename tracking variable**

Change `recipientMollieId` to `recipientAccessToken` since we no longer need the org ID -- we need the token.

## Summary of flow after fix

```text
Player pays EUR 25.00
  |
  v
Payment created on TRAINER's Mollie account (using their access_token)
  with applicationFee: EUR 1.00 (your platform fee)
  |
  v
Mollie processes: Trainer gets EUR 25.00 - EUR 1.00 fee - Mollie costs
                  Platform gets EUR 1.00
```

## Files changed

- `supabase/functions/create-mollie-payment/index.ts` -- switch from routing to application fees, use connected account's access token

