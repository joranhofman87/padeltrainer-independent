

# Invoices Page: Move Buttons, Translate, Remove Backfill

## Changes (single file: `AcademyInvoices.tsx`)

### 1. Remove "Generate missing invoices" button & backfill mutation
Delete the `backfillMutation` definition (~lines 187-208) and its button (~lines 484-498). Also remove unused `FileText` from imports if no longer needed.

### 2. Move remaining buttons below the stats cards
Move "Create invoice" and "Invoice settings" buttons from the header area (next to the title) to a row between the stats cards and the bulk actions/tabs section.

### 3. Translate button text
- **Create invoice** → `"Nieuwe factuur"` (update the fallback string)
- **Invoice Settings** → `"Factuur instellingen"` (add space, update fallback string)

### Layout after change

```text
Facturen
Beheer facturen voor je academy

[Stats cards: Onbetaald | Open invoices | Betaald]

[+ Nieuwe factuur]  [⚙ Factuur instellingen]

[Bulk actions row]
[Tabs + filters + search]
[Table]
```

## Files Changed

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Remove backfill mutation + button; move Create/Settings buttons below stats; update Dutch fallback text |

