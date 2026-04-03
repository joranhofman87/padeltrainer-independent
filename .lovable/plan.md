

# Auto-Suggest Player Links from Notes

## Problem
Players often write in their notes who they want to train with (e.g., "Ik wil graag samen met Angelique, Ingrid, en Christel"). Trainers currently have to read every note manually and then search for those players to link them. This is tedious with 77+ registrations.

## Solution
Add a "Suggested links" section in the `IntakeRequestDetailSheet`, between the Notes card and the "Samen trainen" (linked players) card. When a player has notes, we fuzzy-match names mentioned in the notes against all other registrations in the same cycle. Matches appear as clickable suggestions that can be linked with one click.

## How it works

1. **Name extraction + fuzzy matching** — For each request with notes, compare every other player's `full_name` against the notes text using a simple substring/token match:
   - Split the other player's name into parts (first name, last name)
   - Check if the last name (or a significant portion of the full name) appears in the notes text (case-insensitive)
   - Require at least the last name to match (to avoid false positives on common first names like "Noor")
   - Skip players already linked to this request

2. **UI** — Show suggested matches as a highlighted card with a lightbulb icon:
   - Each suggestion shows the player name + a "Link" button
   - Clicking "Link" calls the existing `linkPlayers()` function
   - A "Link all" button links all suggestions at once
   - The section only appears when there are unlinked suggestions

3. **No AI needed** — This is pure string matching. The notes are in Dutch but names are proper nouns, so direct substring matching works well. We normalize diacritics and case.

## Changes

### `src/components/cycles/IntakeRequestDetailSheet.tsx`
- Add a `useMemo` that computes `suggestedLinks` by scanning `request.notes` against `allRequests[].full_name`
- Render a "Suggested links" card above the existing "Samen trainen" card when suggestions exist
- Each suggestion has a quick-link button that calls `handleLinkPlayer`
- Add a "Link all suggested" button when there are multiple matches

### Matching logic (inside the component)
```text
For each otherRequest in allRequests (same cycle, not self, not already linked):
  - Normalize notes and otherRequest.full_name (lowercase, remove diacritics)
  - Split full_name into tokens
  - If the last name token (≥3 chars) appears in normalized notes → suggest
  - If 2+ name tokens appear in notes → also suggest (handles partial names)
```

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Add suggested links section with fuzzy name matching |

