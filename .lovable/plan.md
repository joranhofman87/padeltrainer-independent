

# Enhance Location Import: Lat/Lng Duplicate Detection

Replace the current slug-based duplicate detection with coordinate-based matching for more accurate identification of existing locations.

---

## Current Behavior

The import dialog checks for duplicates using **name + city slug matching**:
```
"Padel Club Amsterdam" + "Amsterdam" → "padel-club-amsterdam-amsterdam"
```

**Problem**: Same physical venue with different name spellings gets imported as duplicate.

---

## Proposed Solution

Add **proximity-based matching** using latitude/longitude coordinates:

| Detection Method | Threshold | Purpose |
|-----------------|-----------|---------|
| Exact coordinates | < 50 meters | Same venue (GPS variance) |
| Nearby location | < 200 meters | Likely same venue, flag for review |

---

## Implementation Changes

### 1. Fetch Existing Coordinates on Parse

When CSV is parsed, query database for all locations with coordinates:

```typescript
// Fetch existing locations with coordinates
const { data: existingLocations } = await supabase
  .from("locations")
  .select("id, name, city, latitude, longitude")
  .not("latitude", "is", null);
```

### 2. Add Distance Calculation Function

```typescript
// Haversine formula for distance between two GPS points
function calculateDistance(
  lat1: number, lon1: number, 
  lat2: number, lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) ** 2 + 
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distance in meters
}
```

### 3. Update Duplicate Detection Logic

After parsing each row, check:

1. **If imported row has lat/lng** → Check proximity to existing locations
2. **Fallback to slug matching** → For rows without coordinates

```typescript
// Check coordinate-based duplicates
if (latitude !== null && longitude !== null) {
  for (const existing of existingLocations) {
    if (existing.latitude && existing.longitude) {
      const distance = calculateDistance(
        latitude, longitude,
        existing.latitude, existing.longitude
      );
      
      if (distance < 50) {
        location.isDuplicate = true;
        location.errors.push(`Matches "${existing.name}" (${Math.round(distance)}m away)`);
        break;
      }
    }
  }
}
```

### 4. Enhanced Preview Display

Show match details in the preview table:

| Status | Badge | Message Example |
|--------|-------|-----------------|
| Exact match | 🟡 Yellow | `Matches "TC Rotterdam" (12m away)` |
| Valid new | 🟢 Green | Ready to import |
| Missing coords | 🔵 Blue | Falls back to slug check |

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/admin/ImportLocationsDialog.tsx` | Add distance calculation, coordinate-based duplicate check, enhanced error messages |

---

## Edge Cases Handled

- **No coordinates in CSV**: Falls back to existing slug-based matching
- **No coordinates in database**: Only new locations with coords are checked
- **Multiple close matches**: First match under threshold is flagged
- **Performance**: Single DB query fetches all existing coordinates upfront

