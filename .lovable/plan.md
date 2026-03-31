

# Move Player Linking from Table Checkboxes to Detail Sheet

## Summary
Remove the confusing checkbox-based bulk linking from the table. Instead, add a dedicated "Linked" column in the table showing colored indicators, and move all link/unlink actions into the detail drawer with a searchable dropdown.

## Changes

### 1. IntakeRequestsTable.tsx — Simplify table
- **Remove**: Checkbox column, `selectedIds` state, bulk action bar, `onLinkPlayers` prop
- **Keep**: `playerLinks` prop and `onUnlinkPlayer` prop for data display
- **Add**: A new "Linked" column (between Status and Proposal, or after Player name) that shows:
  - Nothing if not linked
  - Colored dot + linked player names as a compact badge/tooltip if linked
  - No click-to-unlink on the table — just visual indicator

### 2. IntakeRequestDetailSheet.tsx — Add linking section
- Add a new **"Linked Players"** card section (after Notes, before Proposal)
- Shows currently linked players as badges with an X to unlink
- Has a **searchable dropdown** (Popover + Command) to search other registrations in the same cycle and add them as linked
- When linking: calls `linkPlayers([currentRequestId, selectedRequestId])` or adds to existing group
- When unlinking: calls `unlinkPlayer(requestId)`
- New props: `playerLinks`, `allRequests` (list of all requests in the cycle for the search), `onLinkPlayer`, `onUnlinkPlayer`

### 3. Page components (AcademyIntakeRequests.tsx, TrainerIntakeRequests.tsx)
- Remove `onLinkPlayers` from table props
- Pass `playerLinks`, `allRequests`, `onLinkPlayer`, `onUnlinkPlayer` to the detail sheet instead
- Keep existing link data fetching logic

### 4. No database changes
The `player_links` table and existing CRUD functions (`linkPlayers`, `unlinkPlayer`, `getPlayerLinks`) remain unchanged.

## Files Changed

| File | Change |
|------|--------|
| `IntakeRequestsTable.tsx` | Remove checkboxes, bulk action bar, selection state. Add read-only "Linked" column with colored dot + names. |
| `IntakeRequestDetailSheet.tsx` | Add "Linked Players" card with searchable dropdown to link/unlink. New props for link data and actions. |
| `AcademyIntakeRequests.tsx` | Move link handlers from table to detail sheet props. Pass `allRequests` to sheet. |
| `TrainerIntakeRequests.tsx` | Same as above. |

