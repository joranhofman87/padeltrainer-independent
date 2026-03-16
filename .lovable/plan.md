

## Show Duration-Based Pricing Table

The current price table shows cyclus options as fixed packages. The user wants a new table layout that combines **lesson types** (from `price_table`) with **duration options** to show calculated totals per duration.

### Target layout

```text
| Type    | Per les  | 5 weken | 10 weken | 15 weken |
|---------|----------|---------|----------|----------|
| Privé   | €35.00   | €175.00 | €350.00  | €525.00  |
| Duo     | €25.00   | €125.00 | €250.00  | €375.00  |
```

Columns are dynamic based on `settings.duration_options`.

### Changes

**`src/components/cycles/CycleDetailDisplay.tsx`**
- Replace the current cyclus options table and the separate duration badges with a single combined pricing table when both `price_table` (or `price_per_session`) and `duration_options` exist.
- Table headers: Type | Per les | {N} weken (for each duration option, sorted ascending).
- Each row: label from `price_table`, price per lesson, and `price × weeks` for each duration column.
- If no `price_table` but a single `price_per_session` exists on the cycle, show one row using cycle name/type as label.
- Keep the old cyclus options table as fallback when `duration_options` is empty.
- Remove the standalone duration badges section (now integrated into the table).

**`src/i18n/locales/nl/cycles.json`**
- Add `detail.weeksColumn` key for the column header pattern (e.g. "{{count}} weken").

### Files to modify
- `src/components/cycles/CycleDetailDisplay.tsx`
- `src/i18n/locales/nl/cycles.json`

