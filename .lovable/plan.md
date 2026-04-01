

# Fix Stale Mollie Payment URL Reuse

## Summary
Move the existing-payment-URL reuse check to **after** token resolution, and verify the payment is still `open` via Mollie API before reusing. Include `?testmode=true` when applicable.

## Changes — `supabase/functions/create-invoice-payment/index.ts`

### 1. Remove early return (lines ~131-136)
Delete the block that blindly returns `mollie_payment_url` if status isn't `paid`.

### 2. Add verified reuse check after token resolution (~line 190, after `accessToken` is resolved)
```typescript
// Check if existing payment is still usable
if (invoice.mollie_payment_url && invoice.mollie_payment_id && invoice.status !== "paid") {
  try {
    const testParam = isTestMode ? "?testmode=true" : "";
    const checkResp = await fetch(
      `https://api.mollie.com/v2/payments/${invoice.mollie_payment_id}${testParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (checkResp.ok) {
      const existing = await checkResp.json();
      if (existing.status === "open") {
        return new Response(JSON.stringify({ paymentUrl: invoice.mollie_payment_url, existing: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    // Stale — clear stored URL
    await supabase.from("invoices")
      .update({ mollie_payment_url: null, mollie_payment_id: null })
      .eq("id", invoice.id);
    logStep("Cleared stale payment URL", { oldPaymentId: invoice.mollie_payment_id });
  } catch { /* proceed to create new */ }
}
```

Note: `isTestMode` is already derived from `mollieApiKey` earlier in the function.

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/create-invoice-payment/index.ts` | Remove blind URL reuse; add Mollie status check after token resolution; clear stale URLs |

