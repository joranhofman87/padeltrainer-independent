

# Block Platform Fallback for Invoice Payments + Show Pay Button Only When Mollie Connected

## Problem
When an academy hasn't connected Mollie, the `create-invoice-payment` function falls back to the platform's `MOLLIE_API_KEY`, routing payments to Reditus Software Holding BV. Invoices should still be generated (they have IBAN for manual payment), but the online "Pay" button should only appear when the academy/trainer has a connected Mollie account.

## Changes

### 1. Edge function: Return Mollie connection status
**File: `supabase/functions/get-public-invoice/index.ts`**

- After fetching the invoice, check if the academy (or trainer) has a connected Mollie account (`onboarding_complete = true` and `charges_enabled = true`)
- Return a `hasMollieAccount: boolean` field in the response (alongside the existing `hasMolliePayment`)

### 2. Edge function: Block platform key fallback
**File: `supabase/functions/create-invoice-payment/index.ts`**

- After resolving `accessToken`, if it's still `null`, return `{ error: "no_mollie_account" }` with status 400 instead of falling back to `mollieApiKey`
- Remove the `const authToken = accessToken || mollieApiKey` fallback — use `accessToken` directly

### 3. Frontend: Conditionally show Pay button
**File: `src/pages/PublicInvoicePay.tsx`**

- Update `PublicInvoiceData` interface to include `hasMollieAccount: boolean`
- Only show the "Pay €X" button when `hasMollieAccount` is true
- When no Mollie account, show the bank details (IBAN) more prominently as the primary payment method with a message like "Please transfer the amount to the bank account below"
- Handle the `no_mollie_account` error gracefully in `handlePay` (edge case fallback)

### Files
- `supabase/functions/get-public-invoice/index.ts` — Check Mollie connection, return `hasMollieAccount`
- `supabase/functions/create-invoice-payment/index.ts` — Remove platform key fallback
- `src/pages/PublicInvoicePay.tsx` — Conditionally show pay button vs bank transfer info

