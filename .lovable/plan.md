

## Add "Claim this Club" to the About Section

### Problem 1: Auth not persisting on some club pages
Both featured and non-featured clubs use the exact same `LocationCard` component and navigation logic (`localizePath('/locations/slug')`). This means the auth loss you're experiencing is likely a transient issue or related to browser state -- not a code difference between featured and non-featured clubs. I'd recommend testing again, and if the issue persists we can investigate further with console/network logs.

### Problem 2: Bug in Player Dashboard club links
While investigating, I found a bug: on the Player Dashboard "My Clubs" section, clicking a club's arrow button navigates to `location/slug` (singular) instead of `locations/slug` (plural), which leads to a 404. This will be fixed.

### Change: Add "Claim this Club" to the "About this Club" card

**File: `src/pages/LocationDetail.tsx`**

In the "About this Club" card (around line 487-498), add a call-to-action for unclaimed clubs below the description text:

- If the club is not claimed (`!isClaimed`), show a prominent section with:
  - A short message explaining that this club hasn't been claimed yet
  - A "Claim this Club" button that opens the existing `ClaimClubDialog` (or redirects to auth if not logged in)
- This reuses the existing `showClaimDialog` state and `ClaimClubDialog` component

**File: `src/pages/PlayerDashboard.tsx`**

- Fix line 649: change `location/` to `locations/` so club links work correctly

### Visual result
The "About this Club" card will look like:

```text
+----------------------------------+
| About this Club                  |
|                                  |
| [description or no description]  |
|                                  |
| --- (if unclaimed) ------------- |
| [icon] This club hasn't been     |
| claimed yet. Are you the owner?  |
| [Claim this Club]                |
+----------------------------------+
```

