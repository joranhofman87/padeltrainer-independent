

# Fix Invoice Page Padding + European Number Formatting

## Problem
1. The invoices page wrapper is `<div className="space-y-6">` — missing the `container mx-auto px-4 py-6` padding that all other academy pages use, causing content to sit flush against the sidebar.
2. Currency amounts show US-style formatting (`100620.59`) instead of European (`100.620,59`).

## Changes

### File: `src/pages/academy/AcademyInvoices.tsx`

**1. Add container padding** (line 171)
- Change `<div className="space-y-6">` to `<div className="container mx-auto px-4 py-6 space-y-6">`

**2. European number formatting**
- Add a helper function to format currency in European style using `toLocaleString('nl-NL')` or manual formatting:
  ```
  const formatEuro = (amount: number) =>
    amount.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ```
- Replace all `€${....toFixed(2)}` occurrences with `€${formatEuro(...)}`
- This affects: stats card (totalUnpaid), table amount column, and mobile card amounts

