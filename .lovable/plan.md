

# Persist Generate Proposals Wizard State Across Navigation

## Problem
All wizard state (start date, selected trainers, weights, criteria, link strategy) is stored in `useState` — it resets when the trainer navigates to a different step and comes back.

## Approach
Persist the wizard configuration to `localStorage` keyed by `cycle.id`. On mount, restore saved state. On every change, save automatically. Clear the stored config when proposals are successfully generated.

## Changes

### `src/components/cycles/GenerateProposalsWizard.tsx`
1. Create a `STORAGE_KEY` using the cycle ID: `generate-proposals-draft-${cycle.id}`
2. On mount: check localStorage for saved config. If found, restore `step`, `startDate`, `trainerConfigs`, `weights`, `additionalCriteria`, `linkStrategy`, `fillIncompleteGroups`
3. Add a `useEffect` that saves current state to localStorage whenever any config value changes (debounced or on every change — the data is small)
4. After successful `onGenerate` call, clear the localStorage entry
5. Add a small "Draft restored" toast or subtle indicator so the trainer knows their previous selections were loaded

### No other files change
This is entirely internal to the wizard component. The parent page (`AcademyCycleDetail`) doesn't need modifications.

## Result
- Trainer configures step 3 partially, navigates away, comes back → picks up exactly where they left off
- Sub-step number, selected trainers, time windows, weights, criteria — all preserved
- Once proposals are generated, the draft is cleared automatically
- No database changes needed — localStorage is sufficient for draft state

## Files

| File | Change |
|------|--------|
| `src/components/cycles/GenerateProposalsWizard.tsx` | Add localStorage save/restore for all wizard state |

