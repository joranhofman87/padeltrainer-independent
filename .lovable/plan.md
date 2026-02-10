

## Add "Manage Club" Button on Academy Locations Page

### What's changing

On the Academy Locations page, for locations where the current user is also a club manager, a new "Manage Club" button will appear alongside the existing "View Club" and "Edit" buttons. This gives academy owners a direct way to switch to their club dashboard without needing the profile switcher dropdown.

### How it works

1. When the page loads, fetch the user's club profiles (via `getUserClubProfiles`) to determine which locations they also manage as a club
2. Build a map of `location_id -> club_profile` for quick lookup
3. For each location card, if the user manages that location as a club, show a "Manage Club" button that navigates to `/app/club` (triggering the club context switch)

### Changes

**`src/pages/academy/AcademyLocations.tsx`**
- Import `getUserClubProfiles` from `@/lib/club` and `useAuth` hook
- Fetch user's club profiles on mount, build a `Map<locationId, clubProfile>`
- Pass `managedClubId` (or null) to each `LocationCard`
- In `LocationCard`, render a "Manage Club" button (with `Building2` icon) when the location has a linked club profile, navigating to `/app/club`

**`src/i18n/locales/en/academy.json`**
- Add `"manageClub": "Manage Club"` under `locations`

**`src/i18n/locales/nl/academy.json`**
- Add `"manageClub": "Beheer Club"` under `locations`

### UI Result

The action buttons row for a claimed location will look like:

`[Edit] [View Club] [Manage Club] [Delete]`

The "Manage Club" button only appears for locations where the logged-in user is also a club manager. It uses a distinct style (e.g., default variant or outline with primary color) to differentiate it from "View Club" (which opens the public page).
