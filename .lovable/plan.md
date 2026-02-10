

## Add Extra Costs to Cyclus/Slot Creation (BulkCreateSheet)

### What's changing
Adding an "Extra costs" option to the BulkCreateSheet (the form used when trainers/academies create recurring slots from the calendar). This matches the existing extra costs feature already in the CycleForm.

### How it works
- A checkbox "Add extra costs" appears below the pricing section in each cyclus config
- When checked, it reveals:
  - A text input for the cost description (e.g., "Court rental")
  - A number input for the price per session
  - An "Add" button for multiple cost lines, with delete buttons
- The total price auto-recalculates to include extra costs (session price + extra costs per session) x number of weeks

### Technical Details

**1. Database migration** -- Add a `extra_costs` JSONB column to `availability_slots`

```sql
ALTER TABLE availability_slots ADD COLUMN extra_costs jsonb DEFAULT '[]';
```

This stores the extra cost data alongside each slot, consistent with how `cycles.settings` stores it.

**2. Update `BulkSlotConfig` interface** in `src/components/trainer/AddSlotDialog.tsx`

Add `extraCosts: ExtraCost[]` to the interface and default it to `[]` in `createDefaultSlotConfig`.

**3. Update `autoCalcPricing`** to accept extra costs and include them in total price calculation:

```
totalPrice = (pricePerSession + extraCostPerSession) * recurrenceWeeks
```

**4. Add UI section** in the BulkCreateSheet pricing area (after the price inputs, before participants):

- Checkbox to toggle visibility
- List of extra cost rows (description + price + delete button)
- "Add cost" button

**5. Update slot insert** to include `extra_costs` in the data sent to the database.

**6. Update `updateBulkSlot`** to recalculate total price when extra costs change.

### Files to modify
- `src/components/trainer/AddSlotDialog.tsx` -- Add extra costs UI and logic to BulkCreateSheet
- Database migration -- Add `extra_costs` column to `availability_slots`

### Files unchanged
- `src/components/cycles/CycleForm.tsx` -- Already has extra costs implemented
- `src/lib/cycles.ts` -- `ExtraCost` type already exported, will be reused

