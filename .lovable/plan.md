

# Add Club Subscription Fields to Location Edit Dialog

## Problem
When editing a location from the Admin Locations page, there's no way to see or change the linked club's subscription status or trial end date. The dedicated Admin Clubs page has this functionality, but it's not accessible from the location edit flow shown in your screenshot.

## Solution
Add a "Club" section to the `LocationEditDialog` that appears when a club profile is linked to the location. This section will show and allow editing:
- Verified status (toggle)
- Subscription status (Inactive / Trial / Active)
- Subscription tier (Starter / Club)
- Trial ends at (date picker, hidden when status is "active")

## Changes

### 1. `src/components/admin/LocationEditDialog.tsx`
- On dialog open, fetch the linked `club_profiles` row for the location (if any)
- Add a new "Club Management" section (with a separator) after the existing sections
- Show the 4 fields: verified toggle, subscription status select, subscription tier select, trial end date input
- On save, update both the `locations` table and the `club_profiles` table in one flow
- If no club profile is linked, this section simply won't appear

### Files modified
- `src/components/admin/LocationEditDialog.tsx`

