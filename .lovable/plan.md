# Stripe webhook signature verification

## Problem (confirmed in code)

`supabase/functions/stripe-subscription-webhook/index.ts:36-41` accepts any POST as a valid Stripe event:

```ts
const body = await req.text();
const sig = req.headers.get("stripe-signature");
// For now, we process without signature verification
// TODO: Add STRIPE_WEBHOOK_SECRET for production signature verification
const event = JSON.parse(body) as Stripe.Event;
```

The webhook URL (`/functions/v1/stripe-subscription-webhook`) is publicly reachable. Any caller can forge:
- `checkout.session.completed` with `metadata.profile_id` + `metadata.type` + `metadata.tier` → activates a paid tier on any `trainer_profiles` / `academy_profiles` / `club_profiles` row for free.
- `invoice.paid` referencing any known `subscription_id` → keeps an expired sub `active` forever (the `stripe.subscriptions.retrieve` call on a real ID still returns a real `current_period_end` to set).
- `customer.subscription.deleted` with any `subscription.id` → griefer can deactivate paying customers.

`STRIPE_WEBHOOK_SECRET` is not currently in project secrets.

## Fix

### 1. Add the `STRIPE_WEBHOOK_SECRET` secret
Use `add_secret` so the user pastes the signing secret from the Stripe dashboard (Developers → Webhooks → the endpoint pointing at `…/functions/v1/stripe-subscription-webhook` → "Signing secret" — starts with `whsec_…`).

### 2. Replace the JSON.parse with signature verification

In `supabase/functions/stripe-subscription-webhook/index.ts`, lines 36-41 become:

```ts
const body = await req.text();
const sig = req.headers.get("stripe-signature");
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

if (!webhookSecret) {
  logStep("STRIPE_WEBHOOK_SECRET not set");
  return new Response("Webhook secret not configured", { status: 500 });
}
if (!sig) {
  return new Response("Missing stripe-signature header", { status: 400 });
}

let event: Stripe.Event;
try {
  // constructEventAsync is required in Deno (sync version uses Node crypto).
  event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logStep("Signature verification failed", { message });
  return new Response(`Webhook Error: ${message}`, { status: 400 });
}
```

Everything below (the `switch` on `event.type`) stays unchanged.

### 3. Verify

1. Unauthenticated `curl` with no signature → expect `400 Missing stripe-signature header`.
2. `curl` with a bogus `stripe-signature` and a fake `checkout.session.completed` body → expect `400 Webhook Error: …`.
3. Confirm in Stripe dashboard → Webhooks → "Send test webhook" that real test events return `200`.

## Out of scope

- Refactoring the three-table fan-out lookup (`for table in ['trainer_profiles', …]`) into a unified subscriptions table — separate cleanup.
- Adding idempotency on `event.id` (Stripe occasionally redelivers). Worth a follow-up but lower priority than fixing the open auth bypass.
- Touching the unrelated `stripe-payments-webhook` / `mollie-webhook` files unless you want me to audit those too in a follow-up turn.
