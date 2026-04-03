

# Improve Pre-Generation Review: Steps on Top + Clickable Players + Include Link Suggestions

## Problem
1. The workflow steps are rendered **below** the review card — they should be at the top so trainers always see progress
2. Each row in the review only shows text — trainers can't click a player name to open the detail drawer and see their notes or make changes
3. The review currently shows both link suggestions and unmatched mentions, but confirming both are present

## Changes

### 1. Move steps above review in `AcademyCycleDetail.tsx`
Swap the render order in the Proposals tab: `ProposalWorkflowSteps` first, then `PreGenerationReview` below it.

### 2. Add player click handler to `PreGenerationReview`
- Add `onPlayerClick?: (requestId: string) => void` prop
- Make player names in both suggestion rows and unmatched rows clickable (underline, cursor-pointer)
- Clicking a name calls `onPlayerClick(requestId)` which opens `IntakeRequestDetailSheet` in the parent

### 3. Render the detail drawer in the Proposals tab
Currently `IntakeRequestDetailSheet` is only rendered in the Registrations tab. Add it to the Proposals tab too (or move it outside tab content so it works from any tab), so that clicking a player name opens the drawer with their full details, notes, and linking controls.

### 4. Confirm link suggestions are shown
The `PreGenerationReview` component already computes and renders both link suggestions (lightbulb icon, Link/dismiss buttons) and unmatched mentions (warning icon, dismiss button). Both are already present — no logic change needed.

## Files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCycleDetail.tsx` | Swap render order (steps above review); render `IntakeRequestDetailSheet` outside tab content so it works from any tab; pass `onPlayerClick` to `PreGenerationReview` |
| `src/components/cycles/PreGenerationReview.tsx` | Add `onPlayerClick` prop; make player names clickable buttons/links |

