

# Extend Time Options to 24:00 in Generate Proposals Wizard

## Problem
The `TIME_OPTIONS` in `GenerateProposalsWizard.tsx` only goes up to 22:00. The `DayAvailabilityPicker` already goes to 00:00 (midnight), so the proposal wizard should match.

## Change

### `src/components/cycles/GenerateProposalsWizard.tsx`
Update the `TIME_OPTIONS` generation (lines 37-43) to go up to 23:30 and include 00:00:

```typescript
const TIME_OPTIONS: string[] = [];
for (let h = 6; h <= 23; h++) {
  TIME_OPTIONS.push(`${h.toString().padStart(2, '0')}:00`);
  TIME_OPTIONS.push(`${h.toString().padStart(2, '0')}:30`);
}
TIME_OPTIONS.push('00:00');
```

This adds 22:30, 23:00, 23:30, and 00:00 (midnight) as selectable end times, consistent with the player-facing `DayAvailabilityPicker`.

### Files

| File | Change |
|------|--------|
| `src/components/cycles/GenerateProposalsWizard.tsx` | Extend `TIME_OPTIONS` to include times up to 00:00 |

