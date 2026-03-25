

# Add Split Payment Toggle to Cyclus Creation Form

## Problem
The `BulkCreateSheet` (cyclus creation form) stores `splitPayment` in the slot data model and uses it when creating invoices, but there is **no UI toggle** in the form for the trainer/academy to enable it. The checkbox/switch is simply missing from the form UI.

## Fix

Add a split payment toggle in the cyclus creation form, placed after the "Allow Single Booking" checkbox (around line 1427 in `AddSlotDialog.tsx`). It should be a checkbox with a label explaining that costs will be divided among participants.

| File | Change |
|------|--------|
| `src/components/trainer/AddSlotDialog.tsx` | Add a split payment checkbox after the "Allow Single Booking" section (~line 1427), toggling `slot.splitPayment` via `updateBulkSlot` |

### UI Addition (after line 1427)
```tsx
{/* Split Payment */}
<div className="flex items-center space-x-2">
  <Checkbox
    id={`split-payment-${index}`}
    checked={slot.splitPayment}
    onCheckedChange={(checked) =>
      updateBulkSlot(index, { splitPayment: !!checked })
    }
  />
  <div>
    <Label htmlFor={`split-payment-${index}`} className="text-sm cursor-pointer">
      {t("calendar.splitPayment", "Split payment among participants")}
    </Label>
    <p className="text-xs text-muted-foreground">
      {t("calendar.splitPaymentHint", "Total price will be divided equally among all booked players")}
    </p>
  </div>
</div>
```

Also add the translation keys to the trainer translation files (en/nl).

| File | Change |
|------|--------|
| `src/i18n/locales/en/trainer.json` | Add `calendar.splitPayment` and `calendar.splitPaymentHint` |
| `src/i18n/locales/nl/trainer.json` | Add Dutch translations for the same keys |

