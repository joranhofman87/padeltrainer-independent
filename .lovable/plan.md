

# Linked Player Strategy: Replace Checkbox with Clear Options

## Current State
- A single `keepCompleteGroups` checkbox that only handles full groups (e.g. 4/4)
- Partial groups (2-3 linked players) get a soft +25 cohesion bonus but can still be split
- No control over what happens with incomplete linked groups

## Proposed UX
Replace the checkbox with a simple **"Linked players"** select dropdown with 3 clear options:

| Option | Label | What it does |
|--------|-------|-------------|
| `strict` | **Always keep together** | Linked players are placed as a unit. Remaining spots filled with compatible players. If no slot fits the group, they're skipped (waitlisted). |
| `prefer` (default) | **Try to keep together** | Strong preference (+50 cohesion bonus instead of +25). Can still split if no suitable slot exists. |
| `ignore` | **Ignore links** | Treat everyone individually. No cohesion bonus. |

Additionally, a secondary option appears when `strict` or `prefer` is selected:

**"Fill incomplete groups?"** — Switch (default: on)
- **On**: remaining spots in a group's slot are filled with other compatible players
- **Off**: leave spots empty (the group trains alone or finds someone themselves)

## Changes

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Replace `keepCompleteGroups` boolean state with `linkStrategy: 'strict' | 'prefer' | 'ignore'` (default: `prefer`)
- Add `fillIncompleteGroups: boolean` state (default: `true`)
- Replace the checkbox UI with a Select dropdown + conditional Switch
- Update `GenerateProposalsConfig` interface: remove `keepCompleteGroups`, add `linkStrategy` and `fillIncompleteGroups`
- Update `handleGenerate` to pass new fields

### `src/pages/academy/AcademyCycleDetail.tsx`
- Update the config passthrough (replace `keepCompleteGroups` with new fields)

### `src/lib/cycles.ts`
- Update the `generateProposals` function signature to pass `linkStrategy` and `fillIncompleteGroups` instead of `keepCompleteGroups`

### `supabase/functions/generate-proposals/index.ts`
- Accept `linkStrategy` and `fillIncompleteGroups` from request body (with backward compat: treat `keepCompleteGroups: true` as `linkStrategy: 'strict'`)
- **`strict` mode**: Place all linked groups (any size ≥ 2) as atomic units. If no slot fits, skip them. When `fillIncompleteGroups` is false, reserve the slot capacity (don't assign unlinked players to remaining spots).
- **`prefer` mode**: Increase cohesion bonus from 25 → 50. Process complete groups first as atomic units (existing logic). Partial groups get the strong bonus but can be split.
- **`ignore` mode**: Skip all group cohesion logic entirely.
- When `fillIncompleteGroups` is false: after placing a linked group, mark remaining capacity in that slot as reserved (skip in individual scoring).

## Files

| File | Change |
|------|--------|
| `src/components/cycles/GenerateProposalsWizard.tsx` | Replace checkbox with Select + Switch, update config interface |
| `src/pages/academy/AcademyCycleDetail.tsx` | Pass new config fields |
| `src/lib/cycles.ts` | Update function signature |
| `supabase/functions/generate-proposals/index.ts` | Implement 3 strategy modes + fill toggle |

