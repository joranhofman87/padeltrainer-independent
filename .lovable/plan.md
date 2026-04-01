

# Enforce Minimum Quantity of 1 on Invoice Line Items

## Problem
In `CreateCustomInvoiceDialog` and `EditInvoiceDialog`, the quantity field passes the raw string value without parsing or enforcing a minimum. A user can set quantity to 0 or leave it empty, causing the total to show €0.00 — confusing users who don't understand why.

`CreateInvoiceDialog` already does `parseInt(e.target.value) || 1` which is correct.

## Changes

### 1. `src/components/invoices/CreateCustomInvoiceDialog.tsx`
- Change quantity `onChange` from passing raw `e.target.value` to `Math.max(1, parseInt(e.target.value) || 1)`
- Add `min="1"` to the input

### 2. `src/components/invoices/EditInvoiceDialog.tsx`
- Same fix: parse and enforce minimum 1 on quantity onChange
- Add `min="1"` to the input

### 3. `src/components/trainer/CreateInvoiceDialog.tsx`
- Already uses `parseInt(e.target.value) || 1` — just add `Math.max(1, ...)` for extra safety (already has `min="1"` on the input)

## Files Changed

| File | Change |
|------|--------|
| `CreateCustomInvoiceDialog.tsx` | Parse quantity as int with min 1, add `min="1"` |
| `EditInvoiceDialog.tsx` | Parse quantity as int with min 1, add `min="1"` |
| `CreateInvoiceDialog.tsx` | Wrap existing parse in `Math.max(1, ...)` |

