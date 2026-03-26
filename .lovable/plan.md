

# Add Online Payment Link to Invoice (Replace IBAN When Mollie Connected)

## Problem
The generated invoice always shows IBAN bank transfer details in the "Betalingsgegevens" section, even when the academy has Mollie connected. Since online payment is available, the invoice should show a payment link (and optionally a QR code) instead of IBAN details.

## Approach

In `generate-invoice/index.ts`:

1. **Check for Mollie connection** — query `academy_mollie_accounts` (or `trainer_mollie_accounts`) to see if `onboarding_complete = true` and `charges_enabled = true`
2. **Fetch academy slug** — already available from `academy_profiles`; add `slug` to the select
3. **Build payment URL** — use the invoice's `public_token` + academy slug: `https://padeltrainer.ai/nl/academies/{slug}/pay/{public_token}`
4. **Conditionally render payment section**:
   - **Mollie connected + public_token exists**: Show "Betaal online" button/link + QR code (generated via a public QR API like `https://api.qrserver.com/v1/create-qr-code/?data=URL&size=150x150`), hide IBAN
   - **No Mollie**: Keep current IBAN details as fallback

## HTML Template Changes

Replace the static IBAN payment-info block (lines 183-203) with conditional logic:

```html
<!-- When Mollie is connected -->
<div class="payment-info">
  <div class="payment-title">Betaal online</div>
  <div style="display: flex; align-items: center; gap: 24px;">
    <img src="https://api.qrserver.com/v1/create-qr-code/?data={paymentUrl}&size=150x150" 
         alt="QR code" width="120" height="120" />
    <div>
      <p>Scan de QR code of klik op de link:</p>
      <a href="{paymentUrl}" style="color: {accentColor}; font-weight: bold;">{paymentUrl}</a>
      <p style="margin-top: 8px; font-size: 13px; color: #6b7280;">
        Referentie: {invoice_number} · Vervaldatum: {due_date}
      </p>
    </div>
  </div>
</div>

<!-- Fallback: no Mollie → show IBAN as before -->
```

## Data Requirements

Add to the `academy_profiles` select: `slug`
Add query: check `academy_mollie_accounts` or `trainer_mollie_accounts` for active connection
Add to invoice select: `public_token` (already in the `*` select)

## Changes

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Add Mollie account check; add `slug` to academy select; add `paymentUrl` + `hasMollie` to `InvoiceData`; replace IBAN section with conditional online payment block (QR + link) or IBAN fallback |

