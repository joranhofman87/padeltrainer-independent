

# Add Missing Pricing & Scheduling Fields to Slot Detail Edit

## Summary
The slot detail page edit form currently only shows date/time, trainer, location, max participants, price per session, and rating. It's missing: total price, VAT mode, split payment, extra costs, and private toggle — all of which exist on `availability_slots` and are set during creation.

## Changes — `src/pages/academy/AcademySlotDetail.tsx`

### 1. Extend SlotDetail interface + fetch
Add fields to `SlotDetail`:
- `total_price: number | null`
- `split_payment: boolean`
- `prices_include_vat: boolean`
- `extra_costs: ExtraCost[] | null`

Update the select query to include these columns. Map them into `setDetail()`.

### 2. Add edit state variables
```
editTotalPrice: string
editSplitPayment: boolean
editPricesIncludeVat: boolean
editExtraCosts: ExtraCost[]
```
Initialize in `startEditing()` from `detail`.

### 3. Extend the edit form UI
After the existing price/max participants grid, add:

- **Total price** field (€ input, same style as price per session)
- **VAT mode** toggle (Switch + label: "Prices include VAT" / "Prices exclude VAT") — same pattern as `CyclePricingCard`
- **Split payment** toggle (Switch + description text)
- **Mark as private** toggle (Switch — move from view-mode-only into the edit form as well)
- **Extra costs** section: list of description + price + type (one_time/per_session) rows with add/remove buttons — reuse the pattern from `CyclePricingCard`

### 4. Update `handleSave` payload
Add the new fields to `updatePayload`:
```typescript
total_price: editTotalPrice ? Number(editTotalPrice) : null,
split_payment: editSplitPayment,
prices_include_vat: editPricesIncludeVat,
extra_costs: editExtraCosts.length > 0 ? editExtraCosts : null,
```

### 5. Update view mode display
Show the additional info as badges/labels when not editing:
- VAT mode indicator
- Split payment indicator
- Extra costs summary (count + total)
- Total price badge alongside price per session

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Add missing fields to interface, fetch, edit state, edit form, save payload, and view display |

