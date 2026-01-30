
# Plan: Display Location Logo Even When Not Claimed

## Problem Identified

The location "De Stouwe Indoor Tennis & Padel" has a `logo_url` stored in the `locations` table:
- `logo_url: https://www.sportcentrumdestouwe.nl/wp-content/uploads/2021/07/De-Stouwe-Logo-diap.png`

However, this location is **not claimed** (no entry in `club_profiles`), so:
1. The logo is not fetched (logos only come from `club_profiles_public`)
2. The avatar is not displayed (only shows when `isClaimed` is true)

## Solution

Update the LocationCard to display logos from the `locations` table as well, even for unclaimed locations.

## Technical Changes

### File: `src/pages/Locations.tsx`

Update the logo fetching logic to also include `logo_url` from the `locations` table itself:

```tsx
// After fetching club profiles, merge location logos as fallback
if (clubProfiles) {
  const logosMap: Record<string, string> = {};
  // ... existing logic for club profile logos
  
  // Also add logos from locations table for unclaimed locations
  locationsData.forEach(loc => {
    if (loc.logo_url && !logosMap[loc.id]) {
      logosMap[loc.id] = loc.logo_url;
    }
  });
  setClubLogos(logosMap);
}
```

### File: `src/components/locations/LocationCard.tsx`

Update the component to show the avatar/logo when a `logoUrl` is provided, not just when claimed:

```tsx
// Before (line 52-60):
{isClaimed && (
  <Avatar className="h-10 w-10 shrink-0">
    <AvatarImage src={logoUrl || undefined} alt={location.name} />
    <AvatarFallback>...</AvatarFallback>
  </Avatar>
)}

// After:
{(isClaimed || logoUrl) && (
  <Avatar className="h-10 w-10 shrink-0">
    <AvatarImage src={logoUrl || undefined} alt={location.name} className="object-contain" />
    <AvatarFallback className="bg-primary/10 text-primary text-xs">
      {getInitials(location.name)}
    </AvatarFallback>
  </Avatar>
)}
```

Note: Added `object-contain` to prevent logo distortion (per visual identity guidelines).

## Summary of Changes

| File | Change |
|------|--------|
| `src/pages/Locations.tsx` | Include `logo_url` from locations table as fallback |
| `src/components/locations/LocationCard.tsx` | Show avatar when logoUrl exists (not just when claimed) |

This ensures locations with logos in the `locations` table (from bulk import) display their logos on the card, even if the club hasn't claimed the profile yet.
