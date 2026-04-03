

# Unmatched Mentions: Info-Only (Non-Blocking)

## Problem
Unmatched mentions (names mentioned in notes but not registered) currently count as "pending actions" in the Review Links step. This blocks the workflow — trainers can't proceed without dismissing each one, even though most are informational and not actionable.

## Change
Make unmatched mentions purely informational. Only **link suggestions** (actual matchable players) count as pending actions. Unmatched mentions are still shown but don't block the step.

## Implementation

### `src/pages/academy/AcademyCycleDetail.tsx`
- Remove `getUnmatchedMentions` from the `pendingLinkActions` count (line 242). Only link suggestions count.

### `src/components/cycles/PreGenerationReview.tsx`
- Change the `totalActions` calculation to only count `suggestions.length` (not unmatched)
- The "all clear" green card shows when there are no link suggestions (unmatched mentions may still exist)
- Move the unmatched section into a separate collapsible info block with a softer style (no amber/orange warning — use a muted info style with a subtle icon)
- Keep the dismiss X button so trainers can clean up the list if they want, but it's optional

### `src/components/cycles/ProposalWorkflowSteps.tsx`
- No changes needed — it already uses `pendingLinkActions` which will now only reflect link suggestions

## Result
- Step 2 shows "All clear" and is marked complete even with unmatched mentions present
- Unmatched names are still visible as an informational section below the main actions
- Trainers can proceed to Generate without being blocked
- The X dismiss button remains for optional cleanup

## Files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCycleDetail.tsx` | Remove unmatched mentions from `pendingLinkActions` count |
| `src/components/cycles/PreGenerationReview.tsx` | Unmatched = info-only section, not counted in `totalActions` |

