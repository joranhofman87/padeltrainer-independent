

# Fix Persistent Leading Zero in Invoice Line Item Inputs

## Problem
When creating/editing an invoice, the quantity and unit_price fields are initialized to `0`. When the user clicks into the field and starts typing, the browser keeps the leading zero (e.g., `0346` instead of `346`).

## Fix
Convert the numeric `value` to a string for display, showing an empty string when the value is `0`. This way, when the user focuses the field, they get a clean empty input instead of a sticky `0`.

## Changes

| File | Change |
|------|--------|
| `src/components/invoices/CreateCustomInvoiceDialog.tsx` | For `quantity` and `unit_price` inputs: change `value={li.quantity}` → `value={li.quantity || ''}` and `value={li.unit_price}` → `value={li.unit_price || ''}`. Same for `vat_rate`. |
| `src/components/invoices/EditInvoiceDialog.tsx` | Apply the same fix to the equivalent line item inputs. |

This ensures `0` values render as empty placeholders, preventing the leading-zero problem.

