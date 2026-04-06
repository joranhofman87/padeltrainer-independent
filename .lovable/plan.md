

# Add Testing & Monitoring to Prevent Breakages

## Summary

The codebase has ~14 unit test files covering utilities but **zero tests on the two riskiest modules**: invoice calculation (`invoiceSync.ts`) and cycle management (`cycles.ts`). The VAT calculation logic, split-payment math, and line-item building are all pure computation that can be extracted and tested without mocking Supabase.

## Strategy

### 1. Extract Pure Computation from `invoiceSync.ts` into Testable Functions

The invoice recalculation logic (lines 80-267) contains pure math that's currently buried inside async Supabase-calling functions. Extract these into standalone pure functions:

- **`detectSplitCount(lineItems)`** — already exists, just needs exporting
- **`buildLineItems(bookings, splitCount, cyclusName, extraCosts)`** — extract the line-item builder (lines 96-200)
- **`calculateVatTotals(lineItems, defaultVatRate, pricesIncludeVat)`** — extract the VAT computation (lines 202-267)

Then write ~15 unit tests covering:
- Single-rate VAT (inclusive and exclusive)
- Multi-rate VAT with extra costs at different rates
- Split payment math (1/2, 1/3, 1/4 players)
- Edge cases: zero price, single booking, all bookings removed
- Rounding precision (the `Math.round * 100 / 100` pattern)

### 2. Add Unit Tests for `cycles.ts` Pure Logic

- `DEFAULT_SCORING_WEIGHTS` sums to 100 (already tested)
- `toCycle()` / `toIntakeRequest()` type converters — test with edge-case JSON
- `exportIntakeRequestsToCsv()` — test CSV output format
- Rate-limiting logic in `submitIntakeRequest` — test the time-window check

### 3. Edge Function Integration Tests

Expand the existing `rls-health.spec.ts` pattern to cover the critical edge functions:

- **`auto-create-invoice`** — call with a test booking ID, verify invoice structure returned
- **`split-invoice`** — call with known data, verify split math
- **`generate-invoice`** — verify PDF URL is returned
- **`health-check`** — already exists, add assertions for each sub-check

### 4. Add a CI Smoke Test for Invoice Math

Create a lightweight Vitest test that runs the extracted pure functions through real-world scenarios based on the bugs we've already fixed (€0 invoices, missing splits, pagination limits).

### 5. Runtime Monitoring: Invoice Anomaly Detection

Add a periodic edge function (`invoice-health-check`) that queries for common anomalies:
- Invoices with `total = 0` but `status != cancelled`
- Invoices where `booking_ids` is empty but status is `sent`
- Split invoices where sibling totals don't match
- Invoices with `due_date` in the past and status still `draft`

This runs on a cron (weekly) and sends a Slack alert via the existing `slack-notify` function.

## File Summary

| File | Change |
|------|--------|
| `src/lib/invoiceCalc.ts` | New — extracted pure functions for line items + VAT math |
| `src/lib/invoiceCalc.test.ts` | New — ~20 unit tests for invoice calculation edge cases |
| `src/lib/invoiceSync.ts` | Refactor to use `invoiceCalc.ts` functions internally |
| `src/lib/cycles.test.ts` | Expand with CSV export + type converter tests |
| `e2e/invoice-health.spec.ts` | New — integration tests calling invoice edge functions |
| `supabase/functions/invoice-health-check/index.ts` | New — weekly anomaly detection, Slack alerts |

## Implementation Priority

1. Extract + test invoice math (highest value — prevents €0 invoice bugs)
2. Invoice anomaly detection edge function (catches issues in production)
3. Expand cycles tests
4. Edge function integration tests

