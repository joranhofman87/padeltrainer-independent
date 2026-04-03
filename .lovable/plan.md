

# Show Suggestion Indicators in the Table + Quick Actions

## Problem
Trainers have to open each player's detail sheet to discover link suggestions. They need a visual indicator in the table to spot suggestions at a glance, and a way to dismiss false positives so the table becomes "clean."

## Approach

### 1. Compute suggestions at the table level
Move the suggestion-matching logic (currently in `IntakeRequestDetailSheet`) into a shared utility so both the table and the detail sheet can use it. The table will show a small indicator per row; the detail sheet keeps the full suggestion UI.

### 2. Table indicator
Add a `Lightbulb` icon (or small badge) in the **Linked** column cell for any row that has unlinked suggestions. Clicking the icon opens a small **Popover** inline showing:
- List of suggested names
- "Link" button per suggestion
- "Dismiss" button per suggestion (removes it from view)

### 3. Dismiss suggestions
Store dismissed suggestion pairs in `localStorage` (key: `dismissed-link-suggestions`, value: array of `[requestId, suggestedId]` pairs). When computing suggestions, filter out dismissed pairs. This keeps things simple with no database changes.

### 4. Detail sheet integration
The detail sheet's existing "Suggested links" section also respects dismissed suggestions and offers the same dismiss action.

## Files

| File | Action |
|------|--------|
| `src/lib/suggestLinks.ts` | **New** — extract the fuzzy matching logic into a reusable function |
| `src/components/cycles/IntakeRequestsTable.tsx` | Import suggestion logic, show indicator + popover with link/dismiss actions in linked column |
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Use shared `suggestLinks` util, respect dismissed suggestions |

## Detail

### `src/lib/suggestLinks.ts`
```typescript
export function getSuggestedLinks(request, allRequests, linkedIds, dismissedPairs): IntakeRequestWithProposal[]
export function dismissSuggestion(requestId, suggestedId): void
export function getDismissedSuggestions(): Set<string>
```

### Table column — Linked cell enhancement
When a row has suggestions (after filtering dismissed), show a small amber `Lightbulb` icon with count badge. Clicking opens a `Popover` with:
- Each suggestion as a row: name + "Link" button + "✕" dismiss button
- "Link all" if multiple

### Props change
`IntakeRequestsTable` needs `allRequests` (the full unfiltered list) and callbacks `onLinkPlayer(requestId, suggestedId)` and a way to trigger re-render after dismiss. Since dismiss is localStorage-based, a local state counter bump suffices.

