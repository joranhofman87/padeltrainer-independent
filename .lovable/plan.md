

# Surface "Unmatched Names" from Notes

## Problem
Players mention names in their notes (e.g., "I want to train with Angelique, Ingrid, and Christel"), but some of those names don't match any registration. Trainers currently have no way to know this without reading every note manually. These are potential new registrations — low-hanging fruit for growing the group.

## Approach

### 1. Extract mentioned names that don't match (`src/lib/suggestLinks.ts`)
Add a new function `getUnmatchedMentions` that:
- Takes a request's notes and the list of all requests in the same cycle
- Extracts name-like tokens/phrases from the notes (split by commas, "en"/"and", newlines)
- For each extracted phrase, checks if it matches any registration's `full_name` (using the same normalization logic)
- Returns the list of phrases that did NOT match any registration — these are the "unmatched mentions"
- Also filters out already-dismissed unmatched mentions (reuse the localStorage dismissal pattern with a separate key like `dismissed-unmatched-mentions`)

### 2. Show warning indicator in the table (`src/components/cycles/IntakeRequestsTable.tsx`)
Next to the existing lightbulb (matched suggestions), show an `AlertTriangle` icon (orange/amber) with a count when there are unmatched mentions. Clicking opens a popover showing:
- Each unmatched name phrase
- A dismiss button (X) per name to mark it as "handled" (persisted in localStorage)
- Brief explanation: "These names were mentioned but not found in registrations"

### 3. Show in detail sheet (`src/components/cycles/IntakeRequestDetailSheet.tsx`)
In the existing suggestions section, add an "Unmatched names" subsection below the matched suggestions, showing the same unmatched names with dismiss buttons.

## Technical detail

### Name extraction heuristic
Notes like `"Ik wil graag samen met Angelique Bakker, Ingrid de Vries en Christel"` get split by:
1. Common Dutch/English conjunctions: `, `, ` en `, ` and `
2. Each fragment is trimmed and checked against all registrations' normalized `full_name`
3. Fragments that are too short (< 3 chars) or are common Dutch filler words are ignored
4. Fragments that match a registration are excluded (those are already handled by the existing suggestion system)

### Dismissal
- New localStorage key: `dismissed-unmatched-mentions`
- Store as `requestId::normalizedPhrase` pairs
- Same pattern as existing `dismissed-link-suggestions`

### Computing in the table
- Add a `unmatchedMap` alongside the existing `suggestionsMap`, computed in a `useMemo`
- The `renderLinkedColumn` function renders the warning icon when unmatched mentions exist

## Files

| File | Change |
|------|--------|
| `src/lib/suggestLinks.ts` | Add `getUnmatchedMentions`, `dismissUnmatchedMention`, `getDismissedUnmatched` |
| `src/components/cycles/IntakeRequestsTable.tsx` | Compute unmatched mentions per row, show `AlertTriangle` indicator + popover with dismiss |
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Show unmatched names section below existing suggestions |

