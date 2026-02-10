

## Fix "Beheer Club" Button to Switch to Correct Club

### Problem

The "Beheer Club" button on the Academy Locations page navigates to `/app/club` but doesn't set the active club, so the ClubLayout picks whatever club was last active (or the first one). It should switch to the specific club that corresponds to that location.

### Solution

Before navigating to `/app/club`, store the `managedClubId` in `localStorage` under the `activeClubId` key. This is the same mechanism `ClubLayout` uses to determine which club to display.

### Changes

**`src/pages/academy/AcademyLocations.tsx`** (line 335)

Update the "Beheer Club" button's `onClick` handler:

```typescript
onClick={() => {
  localStorage.setItem('activeClubId', managedClubId);
  navigate('/app/club');
}}
```

This ensures `ClubLayout` picks up the correct club on mount, matching exactly what the ProfileSwitcher does when selecting a club.

### Files to modify

- `src/pages/academy/AcademyLocations.tsx` (1 line change in the onClick handler)
