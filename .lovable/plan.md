

# Fix: Invoice Forwarding Not Triggered on Payment

## Root Cause

The `mollie-webhook` has two payment paths:

1. **Invoice-only payments** (lines 272-308) — when a player pays via an invoice payment link (`create-invoice-payment`). This path marks the invoice as paid and syncs bookings, but **never calls `forward-invoice`**. It returns at line 308 without forwarding.

2. **Booking-based payments** (lines 362-375) — calls `auto-create-invoice`, which internally forwards if all bookings are paid. But this path is only for direct booking payments, not invoice payments.

Since RL Performance Academy uses invoice payment links, the invoice-only path is hit — and forwarding is completely skipped.

## Fix

### `supabase/functions/mollie-webhook/index.ts`

After the invoice is marked as paid (line 281) and bookings are synced (line 304), add a call to `forward-invoice` before the `return` on line 308:

```typescript
// Forward invoice to bookkeeping emails
try {
  await supabase.functions.invoke("forward-invoice", {
    body: { invoiceId: invoiceIdFromMetadata },
    headers: { Authorization: `Bearer ${supabaseServiceKey}` },
  });
  logStep("Invoice forwarded to bookkeeping");
} catch (fwdErr) {
  logStep("Invoice forwarding failed (non-fatal)", { error: String(fwdErr) });
}
```

This is ~8 lines added inside the `if (payment.status === "paid")` block, before `return new Response("OK", ...)`.

No other files need changes — the `forward-invoice` function already handles fetching the trainer's forwarding emails and sending via Resend.

| File | Change |
|------|--------|
| `supabase/functions/mollie-webhook/index.ts` | Add `forward-invoice` call in invoice-only payment path |

