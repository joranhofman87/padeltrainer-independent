

# Hide Number Spinners Globally & Add Column Headers to Line Items

## Changes

### 1. `src/index.css` — Hide number input spinners globally
Add CSS rules in `@layer base` to remove the up/down arrows from all `input[type="number"]` fields across the entire app:

```css
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type="number"] {
  -moz-appearance: textfield;
}
```

### 2. `src/components/invoices/CreateCustomInvoiceDialog.tsx` — Add column headers
Above the line items rows (before the `.map()`), add a header row matching the grid layout `grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem]` with labels: **Omschrijving**, **Aantal**, **Prijs**, **BTW**, **Totaal**, and an empty cell for the delete button.

### 3. `src/components/trainer/CreateInvoiceDialog.tsx` — Add column headers
Same approach: add a header row above the line item cards with labels for **Omschrijving**, **Datum**, **Aantal**, **Prijs** matching the existing grid layout.

### 4. Check `EditInvoiceDialog.tsx` for same issues
Search for the edit invoice dialog and apply the same header row pattern if it has line items without headers.

## Files Changed

| File | Change |
|------|--------|
| `src/index.css` | Global CSS to hide number input spinners |
| `CreateCustomInvoiceDialog.tsx` | Add column header row above line items |
| `CreateInvoiceDialog.tsx` | Add column header row above line items |
| `EditInvoiceDialog.tsx` | Add column header row if applicable |

