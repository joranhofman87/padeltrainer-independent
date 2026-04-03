

# Constrain Scoring Weights to Always Sum to 100

## Problem
The weight sliders are independent — each goes 0-100, so the total can exceed 100. The presets all sum to 100 but manual adjustments break this. Since the algorithm uses relative weights, going over 100 isn't a bug, but it's confusing UX.

## Approach
Auto-normalize: when a slider changes, proportionally adjust the other sliders so the total always equals 100. This is how most "budget allocation" UIs work.

When the user drags one slider up by N, reduce the others proportionally. When dragged down, increase the others. If all others are at 0, cap the active slider.

## Changes

### `src/components/cycles/ScoringWeightsPanel.tsx`
Replace `updateWeight` with a normalizing version:

```typescript
const updateWeight = (key: keyof ScoringWeights, newValue: number) => {
  const oldValue = weights[key];
  const delta = newValue - oldValue;
  if (delta === 0) return;

  const otherKeys = Object.keys(weights).filter(k => k !== key) as (keyof ScoringWeights)[];
  const otherSum = otherKeys.reduce((sum, k) => sum + weights[k], 0);

  const updated = { ...weights, [key]: newValue };

  if (otherSum === 0) {
    // Can't reduce others below 0 — cap this slider
    updated[key] = 100;
  } else {
    // Distribute -delta proportionally among others
    const scale = (otherSum - delta) / otherSum;
    let remaining = 100 - newValue;
    otherKeys.forEach((k, i) => {
      if (i === otherKeys.length - 1) {
        updated[k] = Math.max(0, remaining);
      } else {
        const adj = Math.max(0, Math.round(weights[k] * scale));
        updated[k] = adj;
        remaining -= adj;
      }
    });
  }

  onWeightsChange(updated);
  setActivePreset(null);
};
```

Also apply same logic in `ScoringWeightsDialog.tsx` if it has its own `updateWeight`.

## Result
- Total always shows 100
- Dragging one slider automatically adjusts others proportionally
- Presets still work as before (they already sum to 100)

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ScoringWeightsPanel.tsx` | Replace `updateWeight` with normalizing version |
| `src/components/cycles/ScoringWeightsDialog.tsx` | Same normalizing logic if it has independent `updateWeight` |

