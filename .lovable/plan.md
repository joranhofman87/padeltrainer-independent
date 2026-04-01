

# Fix Quantity Input UX — Allow Empty During Editing

## Problem
The current `Math.max(1, parseInt(...) || 1)` runs on every keystroke, so users can never clear the field to type a new number. They have to awkwardly prepend digits then delete the old ones.

## Solution
Track quantity as a **string** during editing. Parse and enforce minimum of 1 only **on blur** (when the user leaves the field). This lets users freely clear and retype.

## Changes

### 1. `CreateCustomInvoiceDialog.tsx`
- Store quantity as string in state during editing
- `onChange`: pass raw string value, no parsing
- `onBlur`: parse to int, enforce `Math.max(1, ...)`, update line item
- Same pattern for the quantity input

### 2. `EditInvoiceDialog.tsx`
- Same approach: raw string on change, parse+enforce on blur

### 3. `CreateInvoiceDialog.tsx`
- Same approach: raw string on change, parse+enforce on blur

### Technical approach (all 3 files)
Instead of changing the line item model, simply change the input handling:

```tsx
// quantity input
value={item.quantity === 0 ? '' : item.quantity}
onChange={(e) => updateLineItem(index, 'quantity', e.target.value === '' ? 0 : parseInt(e.target.value) || 0)}
onBlur={() => {
  if (!item.quantity || item.quantity < 1) {
    updateLineItem(index, 'quantity', 1);
  }
}}
```

Using `0` as sentinel for "empty field", and resetting to `1` on blur. The `value` shows empty when quantity is 0, and the totals recalculate live (showing €0 while empty, which is fine since it resets on blur).

## Files Changed

| File | Change |
|------|--------|
| `CreateCustomInvoiceDialog.tsx` | Allow empty quantity, enforce min 1 on blur |
| `EditInvoiceDialog.tsx` | Same |
| `CreateInvoiceDialog.tsx` | Same |

