

# Keep Wizard Draft When Resetting Proposals

## Problem
When resetting proposals, the localStorage draft for the Generate wizard is cleared (because generation succeeded previously). After reset, the trainer returns to step 3 but has to re-enter all settings (trainers, times, weights, etc.) from scratch.

## Fix
Only clear the localStorage draft on **successful generation**, not on reset. Currently, `localStorage.removeItem` is called inside `handleGenerate` in the wizard — this is correct and stays. The issue is that the draft was already cleared from the *previous* successful generation. On reset, the trainer goes back to step 3 with no draft.

Actually, the real fix is simpler: the draft IS cleared after generation succeeds (line 310). When the trainer resets and goes back to step 3, there's no draft because it was removed after the last generation. The solution is to **not clear the draft on successful generation** — instead, only clear it when the user **leaves the cycle detail page entirely** or when the cycle changes. This way, after reset, the draft is still available.

Wait — that would mean the draft persists forever even after proposals are accepted. Better approach: **keep clearing on generation, but re-save the draft immediately before resetting proposals**. The reset handler in `AcademyCycleDetail.tsx` can snapshot the current wizard state back to localStorage before calling reset.

Simplest approach: In `GenerateProposalsWizard.tsx`, **don't clear localStorage on successful generation**. The draft naturally gets overwritten on every change anyway. Only clear it when the component unmounts AND proposals exist (i.e., the workflow moved past generation). This way after reset, the last config is still there.

Even simpler: Just remove the `localStorage.removeItem(STORAGE_KEY)` call from `handleGenerate`. The draft stays until the trainer changes it. When they come back after reset, everything is pre-filled. When they eventually move past the generate step for good, the draft just sits harmlessly in localStorage.

## Change

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Remove `localStorage.removeItem(STORAGE_KEY)` from `handleGenerate` (line 310)
- The draft persists and is always available when returning to step 3

That's it — one line removal.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/GenerateProposalsWizard.tsx` | Remove `localStorage.removeItem(STORAGE_KEY)` from handleGenerate |

