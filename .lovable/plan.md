

# Plan: Enhance Location Pages with SEO, Stats & Similar Clubs

## Overview

Three enhancements for location pages:
1. Verify unique SEO title & meta tags (already implemented, but can be improved)
2. Add "Similar Clubs" section at the bottom
3. Add Indoor/Outdoor court counts to quick stats (always show, even if unknown)

## Current State Analysis

### 1. SEO (Already Implemented)

**LocationDetail.tsx (lines 281-288):**
```jsx
<SEO
  title={`${location.name} - Padel Training in ${location.city}`}
  description={seoDescription}
  url={`/locations/${location.slug}`}
  type="place"
  image={displayLogo || clubProfile?.banner_url || 'https://padeltrainer.ai/og-locations.png'}
  structuredData={getStructuredData() || undefined}
/>
```

Each location already has:
- Unique title with location name and city
- Dynamic description with trainer count
- SportsClub structured data
- Place type for Open Graph

**Improvement**: Make titles more localized using translation keys instead of hardcoded English.

### 2. Quick Stats (lines 235-255)

Currently shows:
- Number of courts (only if > 0)
- Number of trainers (always shown)
- Member since (if claimed)

**Problem**: Indoor/outdoor courts are NOT shown separately. They exist in the database (`indoor_courts`, `outdoor_courts`) but aren't displayed.

### 3. Similar Clubs (Not Implemented)

Need to add a new section at the bottom showing other clubs in the same city.

## Proposed Changes

### 1. Improve SEO Titles (Minor Enhancement)

Keep existing unique SEO but consider using localized text. The current implementation is good.

| Aspect | Current | Status |
|--------|---------|--------|
| Unique title per location | Yes (`{location.name} - Padel Training in {location.city}`) | Good |
| Unique description | Yes (uses club description or dynamic fallback) | Good |
| Structured data | Yes (SportsClub schema) | Good |
| Localized | Partially (title is hardcoded English) | Could improve |

### 2. Add Indoor/Outdoor Courts to Quick Stats

**File:** `src/pages/LocationDetail.tsx`

Replace the current court stat logic with separate indoor/outdoor entries that always show (displaying "-" or "Unknown" if null):

```text
Before (Quick Stats):
+------------------+-------+
| Courts           | 8     |  (only shows if > 0)
| Trainers         | 3     |
| Member since     | Jan 25|
+------------------+-------+

After (Quick Stats):
+------------------+-------+
| Indoor Courts    | 4     |  (always shows, "-" if unknown)
| Outdoor Courts   | 4     |  (always shows, "-" if unknown)
| Trainers         | 3     |
| Member since     | Jan 25|
+------------------+-------+
```

**Implementation:**
```jsx
// Always show indoor courts
quickStats.push({
  icon: <Home className="h-4 w-4" />,
  label: t('common:locations.indoorCourts'),
  value: location.indoor_courts ?? '-',
});

// Always show outdoor courts
quickStats.push({
  icon: <Sun className="h-4 w-4" />,
  label: t('common:locations.outdoorCourts'),
  value: location.outdoor_courts ?? '-',
});
```

### 3. Add Similar Clubs Section

**File:** `src/pages/LocationDetail.tsx`

Add a new state for similar locations and a new section at the bottom showing other clubs from the same city:

```text
+------------------------------------------+
| Similar Clubs in {city}                  |
| 3 more clubs                             |
+------------------------------------------+
| [Club Card 1] [Club Card 2] [Club Card 3]|
+------------------------------------------+
```

**Implementation Steps:**

1. Add new state: `const [similarLocations, setSimilarLocations] = useState<Location[]>([]);`

2. Fetch similar locations in the useEffect:
```jsx
// Fetch similar locations from same city (exclude current location)
const { data: similar } = await supabase
  .from('locations')
  .select('*')
  .eq('city', locationData.city)
  .eq('is_active', true)
  .neq('id', locationData.id)
  .limit(6);
if (similar) setSimilarLocations(similar);
```

3. Add the section before the ClaimClubDialog:
```jsx
{similarLocations.length > 0 && (
  <ProfileFullWidthSection>
    <h2>{t('common:locations.similarClubs', 'Similar Clubs in {{city}}', { city: location.city })}</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {similarLocations.map(loc => (
        <LocationCard 
          key={loc.id} 
          location={loc} 
          trainerCount={trainerCounts[loc.id] || 0}
          isClaimed={claimedIds.has(loc.id)}
          logoUrl={clubLogos[loc.id]}
        />
      ))}
    </div>
  </ProfileFullWidthSection>
)}
```

4. Will also need to fetch trainer counts and claimed status for similar locations.

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/LocationDetail.tsx` | Add indoor/outdoor stats, add similar clubs section, add Home/Sun icons |
| `src/i18n/locales/en/common.json` | Add "similarClubs" translation key |
| `src/i18n/locales/nl/common.json` | Add "similarClubs" translation key |

## Translation Additions

**English (common.json):**
```json
{
  "locations": {
    "similarClubs": "Similar Clubs in {{city}}",
    "unknown": "-"
  }
}
```

**Dutch (common.json):**
```json
{
  "locations": {
    "similarClubs": "Vergelijkbare Clubs in {{city}}",
    "unknown": "-"
  }
}
```

## Technical Implementation Details

### Indoor/Outdoor Stats Logic

```jsx
import { Home, Sun } from 'lucide-react';

// Build quick stats - always include indoor/outdoor courts
const quickStats = [];

// Indoor courts - always show
quickStats.push({
  icon: <Home className="h-4 w-4" />,
  label: t('common:locations.indoorCourts'),
  value: location.indoor_courts != null ? location.indoor_courts : '-',
});

// Outdoor courts - always show  
quickStats.push({
  icon: <Sun className="h-4 w-4" />,
  label: t('common:locations.outdoorCourts'),
  value: location.outdoor_courts != null ? location.outdoor_courts : '-',
});

// Trainers - always show
quickStats.push({
  icon: <Users className="h-4 w-4" />,
  label: trainers.length === 1 ? t('common:locations.trainer') : t('common:locations.trainers'),
  value: trainers.length,
});

// Member since - only if claimed
if (clubProfile?.claimed_at) {
  quickStats.push({
    icon: <Calendar className="h-4 w-4" />,
    label: t('common:locations.memberSince'),
    value: format(new Date(clubProfile.claimed_at), 'MMM yyyy', { locale: dateLocale }),
  });
}
```

### Similar Clubs Fetch

```jsx
// In the useEffect, after fetching the location:
const [claimedIdsForSimilar, setClaimedIdsForSimilar] = useState<Set<string>>(new Set());
const [trainerCountsForSimilar, setTrainerCountsForSimilar] = useState<Record<string, number>>({});
const [logoUrlsForSimilar, setLogoUrlsForSimilar] = useState<Record<string, string>>({});

// Fetch similar locations
const { data: similar } = await supabase
  .from('locations')
  .select('*')
  .eq('city', locationData.city)
  .eq('is_active', true)
  .neq('id', locationData.id)
  .limit(6);

if (similar && similar.length > 0) {
  setSimilarLocations(similar);
  
  // Fetch trainer counts for similar locations
  const similarIds = similar.map(l => l.id);
  const { data: trainerLocs } = await supabase
    .from('trainer_locations')
    .select('location_id')
    .in('location_id', similarIds);
  
  // ... count trainers per location
  
  // Fetch claimed status for similar locations
  const { data: clubProfiles } = await supabase
    .from('club_profiles')
    .select('location_id, logo_url')
    .in('location_id', similarIds);
  
  // ... build claimed set and logo map
}
```

## Summary

| Feature | Description |
|---------|-------------|
| SEO | Already unique per location. Working correctly. |
| Indoor/Outdoor Courts | Add as separate stats, always visible (show "-" if unknown) |
| Similar Clubs | New section at bottom showing 3-6 clubs from same city |

