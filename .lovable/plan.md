# Remove platform-key fallback in mollie-webhook

## Problem (confirmed)

`supabase/functions/mollie-webhook/index.ts` lines 228-246: when no connected-account token resolves, the webhook falls back to `MOLLIE_API_KEY` (the platform key) and fetches the payment with that. The platform key has visibility into every payment routed through the OAuth app, and the rest of the function then trusts `payment.metadata.booking_ids` / `invoice_id` to flip booking and invoice rows to `paid`.

Since the webhook URL is publicly callable and Mollie payment IDs (`tr_…`) are easy to enumerate / leak, an attacker can:
1. Make a real €0.01 payment on their own connected trainer (or any unrelated Mollie merchant in the same connect app), seeding `metadata.booking_ids` with a victim's booking IDs.
2. POST the payment ID to our webhook.
3. The trainer/academy lookup misses, we fall back to the platform key, fetch the attacker-controlled payment, see `status:"paid"`, and mark the victim's bookings + invoices paid.

## Fix

In `supabase/functions/mollie-webhook/index.ts`:

1. Drop the platform-key fallback. If `recipientAccessToken` is still null after both lookups (booking → invoice), do not fetch the payment, do not mutate any rows. Log + Slack-notify and return 200 (so Mollie doesn't retry forever). Concretely:

   ```ts
   if (!recipientAccessToken) {
     logStep("No connected-account token resolved, refusing to process", { paymentId, trainerId });
     await notifySlackError(
       "mollie-webhook",
       "Refused payment processing: no connected Mollie account resolved",
       { paymentId, trainerId },
     );
     return new Response("OK", { status: 200 });
   }
   ```

2. Remove the now-dead `const authToken = recipientAccessToken || mollieApiKey;` and the warning branch at lines 230-233; always use the connected token. Keep the existing `?testmode=true` query-string logic, but it can drop the `&& recipientAccessToken` guard (token is always connected at this point).

3. Leave `MOLLIE_API_KEY` env read in place if it's still used elsewhere in the file — quick scan above shows it isn't after this change, so also remove the early `if (!mollieApiKey) throw …` guard and the env read to avoid future accidental reuse.

## Verification

- Real path: existing trainer/academy webhook (with a connected Mollie account) still resolves a token and flips booking/invoice status. Verified by looking at recent successful webhook logs after deploy.
- Attack path: `curl -X POST` the function with `id=tr_unknown` form body → expect "No connected-account token resolved" log line, Slack alert fired, no DB writes, 200 response.
- Negative path: payment whose booking row exists but the trainer's Mollie account was disconnected → same refusal, no fallback to platform key.

## Out of scope

- Verifying that the inbound `paymentId` belongs to the connected merchant we resolved (the connected-token fetch already enforces this — Mollie returns 404 if the payment isn't on that merchant's organization).
- Reworking how `bookings.mollie_payment_id` / `invoices.mollie_payment_id` is stored at checkout time (separate hardening).
- The `mollie-callback` / OAuth-state issue (already fixed in the previous turn).
