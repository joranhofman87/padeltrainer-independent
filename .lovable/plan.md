

## Add Price Columns to Price List Table

### What changes
Currently each price table row has a `label` and a single `price`. We'll add support for multiple named price columns (e.g., "Adults", "Kids") so trainers can set different prices per lesson type for different categories.

### Data model change

**`src/lib/cycles.ts`** — Update `PriceTableRow`:
```typescript
export interface PriceTableRow {
  label: string;
  price: number;
  // New: additional named price columns
  extra_prices?: { column_name: string; price: number }[];
}
```

Add a new field to `CycleSettings`:
```typescript
price_columns?: string[]; // e.g. ["Jeugd", "Volwassenen"]
```

No database migration needed — `price_table` is stored as JSONB, so the new fields are automatically supported.

### CycleForm.tsx (Trainer view)

- Add state `priceColumns: string[]` initialized from `cycle.settings.price_columns` (default: empty = single price column like today).
- Above the price rows, add a row of column headers: a "Label" header, then one header per column with an editable name input + delete button, plus an "Add column" button.
- Default column name (when no columns defined): just show the current single `€` price field (backward compatible).
- When columns are added, each price row gets one price input per column instead of the single `€` field.
- Save `price_columns` to `settings` and map prices into `extra_prices` on each row.

### CycleDetailDisplay.tsx (Player view)

- Read `price_columns` from settings.
- If columns exist, render table headers for each column name and show the corresponding prices.
- Duration matrix: multiply each column's price by weeks.
- Fallback: single price column when no `price_columns` defined (current behavior preserved).

### CycleApplicationForm.tsx (Summary calculator)

- Update price lookup to check `extra_prices` when matching lesson types — no functional change needed unless columns map to lesson types (future enhancement).

### Translations
- Add keys: `form.addPriceColumn`, `form.columnName`, `form.defaultColumnName` in EN and NL.

### Files to modify
- `src/lib/cycles.ts`
- `src/components/cycles/CycleForm.tsx`
- `src/components/cycles/CycleDetailDisplay.tsx`
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`

