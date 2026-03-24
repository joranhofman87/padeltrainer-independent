
# Fix stuck “Redirecting…” on invoice pay

## Diagnosis
- Clicking **Pay** calls `create-invoice-payment`.
- That function currently fails with Mollie `422`:
  - `"A website profile is required for payments"`
  - field: `profileId`
- After that backend failure, the frontend catch block in `PublicInvoicePay.tsx` runs `JSON.parse(err.message)`, which throws a second error (`Unexpected token 'E'...`), so loading state never resets.
- Result: button stays in **“Redirecting…”** even though checkout was never opened.
- The CORS warning for `/app/analytics` is unrelated to this payment failure.

Do I know what the issue is? Yes.

## Files to update
- `supabase/functions/create-invoice-payment/index.ts`
- `src/pages/PublicInvoicePay.tsx`

## Implementation plan

1. **Fix Mollie payment creation in edge function**
   - In `create-invoice-payment`, when using connected-account OAuth token:
     - Fetch merchant profiles via `GET /v2/profiles`.
     - Select a usable profile and pass `paymentBody.profileId`.
   - If no profile is available, return a structured `400` error (e.g. `missing_mollie_profile`) with clear message.
   - Keep current payment isolation model (no fallback to platform recipient).

2. **Fix frontend error handling so loader never gets stuck**
   - In `handlePay`:
     - Remove direct `JSON.parse(err.message)`.
     - Safely read edge-function error payload (or fallback to generic).
     - Move `setPayLoading(false)` into `finally` so it always resets after failures.
   - Keep redirect behavior only when `result.paymentUrl` is valid.

3. **Improve user feedback**
   - Map backend error codes to clear toasts:
     - `missing_mollie_profile` → merchant account setup incomplete.
     - `no_mollie_account` → online payment unavailable.
     - fallback → generic payment creation error.

4. **Add robust logging for this critical flow**
   - Log payment creation failures with `logger.error` (include invoice id and token context) in `PublicInvoicePay.tsx`.

5. **Verification after implementation**
   - Call `create-invoice-payment` with invoice `3f39a319-8ab2-4986-8c10-84456a492678` and confirm it returns `paymentUrl` (no 422).
   - Confirm clicking Pay redirects to Mollie.
   - Confirm on simulated failure the button exits “Redirecting…” and shows a toast.
