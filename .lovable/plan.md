

# Fix: Show Club Description in Admin Location Edit

## Problem
The admin dialog has two separate description fields:
1. **Location description** (under "Details") -- reads from `locations.description` -- this is what you see empty
2. **Club profile description** (under "Club Profile Details") -- reads from `club_profiles.description` -- this is where the club owner saved their text

They are not connected, so the visible description field appears empty even though the club has text.

## Solution
When a club profile is linked to the location, hide the location-level description field in the "Details" section. The club's description (already shown in the "Club Profile Details" section below) becomes the single source of truth.

This avoids confusion and ensures the admin always sees the same description the club owner edits.

## Technical Changes

### `src/components/admin/LocationEditDialog.tsx`
- In the "Details" section (around line 388-397), conditionally hide the location description textarea when `clubData` is present
- This means: no club linked = location description is shown as before; club linked = only the club profile description (already in the Club Management section) is visible

One small change, no new files.

