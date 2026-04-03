

# Pre-Generation Link Review + Keep Groups Intact

## Two Features

### 1. "Review Links" step before Generate

Add a new step between the current workflow steps. When the Proposals tab is active and proposals haven't been generated yet, show an inline action list (not a drawer) that surfaces:

- **Link suggestions**: Players who mentioned names in their notes that match other registrations. Each row shows: "[Player] mentioned [Suggested player]" with a "Link" button and "✕" dismiss button.
- **Unmatched warnings**: Players who mentioned names not found in registrations. Each row shows: "[Player] mentioned [Name] — not registered" with a "✕" dismiss button.
- A summary line: "3 link suggestions, 1 unmatched mention" or "All clear — no actions needed"
- A "Mark as reviewed" / "Continue to Generate" button to proceed

This uses the existing `getSuggestedLinks` and `getUnmatchedMentions` from `suggestLinks.ts` — no new matching logic needed. The step runs client-side against the already-loaded `requests` and `playerLinksData`.

### 2. "Keep complete groups intact" option

Currently the edge function gives a +25 cohesion bonus when linked players are in the same slot, but it can still split them if another slot scores higher. For complete groups (where linked group size = slot max_participants, typically 4), the trainer should be able to force them to stay together.

Add a checkbox in the `GenerateProposalsWizard`: **"Keep complete groups together"** (default: checked). When enabled, pass `keepCompleteGroups: true` in the config to the edge function. The edge function then:
- Identifies link groups where member count >= slot max_participants
- Places the entire group into the best-scoring slot as a unit (skips individual scoring)
- Remaining linked players (incomplete groups) still use the cohesion bonus as today

## Implementation

### `src/components/cycles/ProposalWorkflowSteps.tsx`
- Add a new step between the current step 1 (Generate) and step 2 (Review & Edit) when `hideCycleSelector` is true
- New step: "Review Links" — status logic: if there are pending suggestions/warnings → active; if reviewed/none → completed
- New props: `pendingActionCount`, `onReviewLinks`, `isReviewed`

### `src/components/cycles/PreGenerationReview.tsx` (new)
- Standalone component rendered in the Proposals tab between the workflow steps and the generate button
- Takes `requests`, `playerLinks`, computes suggestions and unmatched mentions
- Renders a card with two sections:
  - Link suggestions: each as a row with player name, suggested name, "Link" and "✕" buttons
  - Unmatched mentions: each as a row with player name, mentioned name, "✕" dismiss button
- "Link" calls the same `linkPlayers` function used elsewhere (optimistic UI)
- When all items are handled or dismissed, shows a green "All clear" state
- Collapsible so it doesn't dominate the page once reviewed

### `src/pages/academy/AcademyCycleDetail.tsx`
- In the Proposals tab, render `PreGenerationReview` above the workflow steps when `newCount > 0` (pre-generation phase)
- Pass `requests`, `playerLinksData`, and `refreshData` callback

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Add `keepCompleteGroups` checkbox (default: true) in the wizard UI
- Add to `GenerateProposalsConfig` interface: `keepCompleteGroups: boolean`

### `supabase/functions/generate-proposals/index.ts`
- Read `keepCompleteGroups` from request body
- When true: before individual scoring loop, find link groups where `groupSize >= maxParticipants` (default 4)
- For each complete group: find the best slot (using average scoring across all members), assign all members to it as a batch, mark them as processed
- Skip these players in the normal individual loop

## Files

| File | Change |
|------|--------|
| `src/components/cycles/PreGenerationReview.tsx` | **New** — inline action list for link suggestions + unmatched warnings |
| `src/components/cycles/ProposalWorkflowSteps.tsx` | Add "Review Links" step with pending count |
| `src/pages/academy/AcademyCycleDetail.tsx` | Render `PreGenerationReview` in Proposals tab |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Add `keepCompleteGroups` checkbox + config field |
| `supabase/functions/generate-proposals/index.ts` | Handle complete groups as atomic units when flag is set |

