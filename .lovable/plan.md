

# Add Receiver Details & Full Editing to EditInvoiceDialog

## Problem
The Edit Invoice dialog only allows editing line items, VAT rate, due date, and notes. The Create Custom Invoice dialog has more capabilities: receiver details (name, business name, street/zip/city, BTW number), line item removal, and a prices-include-VAT toggle. These should also be available when editing any invoice.

## Changes

| File | Change |
|------|--------|
| `src/components/invoices/EditInvoiceDialog.tsx` | **Expand interface**: Add `player_name`, `player_business_name`, `player_address`, `player_btw_number`, `prices_include_vat` to `EditInvoiceData`. **Add state**: `playerName`, `playerBusinessName`, `playerStreet`, `playerZipCode`, `playerCity`, `playerBtwNumber`, `pricesIncludeVat` — initialize from invoice (parse `player_address` by splitting on `\n`). **Add UI**: Receiver details section (same layout as CreateCustomInvoiceDialog), prices-include-VAT toggle, trash button per line item. **Update save**: Include receiver fields and `prices_include_vat` in the update call. |
| `src/pages/academy/AcademyInvoices.tsx` | Pass the additional fields (`player_name`, `player_business_name`, `player_address`, `player_btw_number`, `prices_include_vat`) when setting `editInvoice`. |
| `src/components/trainer/InvoiceList.tsx` | Same — pass the additional fields to `editInvoice` so the Edit dialog has access to them. |

## Details
- `player_address` is stored as a newline-separated string (`street\nzip\ncity`). On load, split by `\n` into three fields. On save, join back.
- Line item removal: add a `Trash2` icon button per row (disabled when only 1 item remains), matching `CreateCustomInvoiceDialog`.
- The `pricesIncludeVat` toggle affects VAT calculation — reuse the same `useMemo` logic already present but make it reactive to the toggle instead of reading from the immutable `invoice` prop.

