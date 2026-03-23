

# Extra Costs: One-Time vs Per-Session Type

## Summary
Add a `type` field to extra costs so trainers can specify whether a cost is **per session** (multiplied by number of weeks) or **one-time** (flat amount). Auto-calculate totals accordingly, and reflect this on invoices.

## Current State
- `ExtraCost` is `{ description: string; price: number }` — always treated as per-session in pricing calculations
- Used in: CycleForm, AddSlotDialog, TrainerScheduleOverview (cycle edit), and auto-create-invoice edge function

## Changes

### 1. `src/lib/cycles.ts`
Update the `ExtraCost` interface:
```ts
export interface ExtraCost {
  description: string;
  price: number;
  type?: 'per_session' | 'one_time'; // defaults to 'per_session' for backwards compat
}
```

### 2. `src/components/cycles/CycleForm.tsx`
- Add a toggle/select per extra cost row to choose "Per session" or "One-time"
- Update pricing breakdown: per-session costs multiply by weeks, one-time costs add once
- Default new costs to `per_session`

### 3. `src/components/trainer/AddSlotDialog.tsx`
- Add the same type toggle per extra cost row
- Update `autoCalcPricing`: per-session costs multiply by `recurrenceWeeks`, one-time costs divided by `recurrenceWeeks` for per-session display (or kept separate in total)

### 4. `src/pages/TrainerScheduleOverview.tsx`
- Add type selector in the cycle edit dialog's extra costs section
- When repeat count changes, totals auto-recalculate (per-session scales, one-time stays fixed)

### 5. `supabase/functions/auto-create-invoice/index.ts`
- Read `ec.type` — if `one_time`, set `quantity: 1`; if `per_session` (or missing/default), set `quantity` to number of sessions being invoiced
- This ensures invoices correctly reflect the cost type

### 6. Translation keys (`en/trainer.json`, `nl/trainer.json`, `en/cycles.json`, `nl/cycles.json`)
- `perSession`: "Per session" / "Per sessie"
- `oneTime`: "One-time" / "Eenmalig"

### Backwards Compatibility
- Existing extra costs without `type` default to `per_session` (current behavior preserved)

## Files
- `src/lib/cycles.ts` — Update ExtraCost interface
- `src/components/cycles/CycleForm.tsx` — Add type toggle, update pricing calc
- `src/components/trainer/AddSlotDialog.tsx` — Add type toggle, update pricing calc
- `src/pages/TrainerScheduleOverview.tsx` — Add type toggle in cycle edit
- `supabase/functions/auto-create-invoice/index.ts` — Handle type in invoice line items
- `src/i18n/locales/en/trainer.json` + `nl/trainer.json` — Translation keys
- `src/i18n/locales/en/cycles.json` + `nl/cycles.json` — Translation keys

