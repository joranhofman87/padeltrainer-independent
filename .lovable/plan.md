

# Fix Level Range Display - Round to 1 Decimal Place

## Problem
The trainer level range slider in the Edit Profile page shows values with multiple decimal places (e.g., `4.877`) instead of clean single decimal values (e.g., `4.9`).

This occurs because:
1. The slider uses `step={preferredSystem.step}` (typically `0.1`)
2. JavaScript floating-point arithmetic can introduce precision errors
3. The display simply outputs the raw value without formatting

## Solution
Format the displayed values to show only 1 decimal place using `toFixed(1)`.

## Files to Change

| File | Changes |
|------|---------|
| `src/pages/EditProfile.tsx` | Format `minVal` and `maxVal` in the level range display to 1 decimal place |

## Implementation Details

In `EditProfile.tsx` at lines 814-817, change the level range display from:

```tsx
<span className="font-medium">
  {minVal} - {maxVal} ({preferredSystem.name})
</span>
```

To:

```tsx
<span className="font-medium">
  {minVal.toFixed(1)} - {maxVal.toFixed(1)} ({preferredSystem.name})
</span>
```

## Additional Consideration
To ensure the actual stored values are also rounded (not just the display), the slider's `onValueChange` handler should also round the values:

```tsx
onValueChange={([min, max]) => {
  setTrainerData({
    ...trainerData,
    preferred_min_rating: Math.round(min * 10) / 10,
    preferred_max_rating: Math.round(max * 10) / 10,
  });
}}
```

This ensures both:
1. ✅ Display shows clean values like `0.1 - 4.9`
2. ✅ Database stores clean values without floating-point artifacts

