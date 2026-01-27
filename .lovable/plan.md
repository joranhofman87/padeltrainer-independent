

# Add Geocoding Coordinates to Club Locations

## Overview
Add latitude and longitude coordinates to the `locations` table and create an edge function to batch geocode all 575 existing club addresses using a free geocoding service.

## Database Changes

### Migration: Add coordinate columns to locations table
```sql
-- Add latitude and longitude columns
ALTER TABLE public.locations
ADD COLUMN latitude NUMERIC(10, 7),
ADD COLUMN longitude NUMERIC(10, 7);

-- Add index for spatial queries (useful for future "nearby clubs" feature)
CREATE INDEX idx_locations_coordinates ON public.locations (latitude, longitude)
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
```

**Column Precision**: Using `NUMERIC(10, 7)` allows for 7 decimal places, which provides ~1cm accuracy - more than sufficient for club locations.

## Edge Function: `geocode-locations`

Create a new edge function that:
1. Fetches locations without coordinates (or all if forced)
2. Uses the **Nominatim** geocoding API (free, no API key required)
3. Processes locations in batches with rate limiting (1 request/second for Nominatim)
4. Updates the database with coordinates

### Nominatim API Details
- **Endpoint**: `https://nominatim.openstreetmap.org/search`
- **Rate Limit**: 1 request per second (we'll use 1.5s delay to be safe)
- **No API Key Required**: Just needs a custom User-Agent header
- **Format**: Returns JSON with lat/lon for matched addresses

### Edge Function Structure
```typescript
// supabase/functions/geocode-locations/index.ts

Key features:
- Batch processing with configurable batch_size (default: 50)
- Offset-based pagination for processing all 575 locations
- Dry-run mode for testing
- 1.5 second delay between requests to respect rate limits
- Constructs address from: street_address, postal_code, city, country
- Stores latitude/longitude in locations table
- Returns detailed results with success/error counts
```

### Request Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `batch_size` | number | 50 | Locations per batch (max 100) |
| `offset` | number | 0 | Starting position for pagination |
| `dry_run` | boolean | false | Preview without saving |
| `location_ids` | string[] | null | Specific locations to geocode |
| `force` | boolean | false | Re-geocode even if coords exist |

### Expected Response
```json
{
  "success": true,
  "batch_size": 50,
  "offset": 0,
  "next_offset": 50,
  "total_processed": 50,
  "summary": {
    "success": 45,
    "skipped": 2,
    "errors": 3
  },
  "results": [...]
}
```

## Running the Batch Geocoding

After deployment, call the edge function multiple times to process all 575 locations:

```bash
# Process first batch
curl -X POST https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/geocode-locations \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 50, "offset": 0}'

# Process next batch (offset increases by batch_size)
# Repeat with offset: 50, 100, 150, ... until all processed
```

**Estimated Time**: 575 locations × 1.5s delay = ~14.4 minutes total for all locations (can be split across multiple calls).

## Code Changes

### 1. Database Migration
- Add `latitude` and `longitude` columns to `locations` table
- Add composite index for future spatial queries

### 2. New Edge Function
**File**: `supabase/functions/geocode-locations/index.ts`
- Full implementation of batch geocoding using Nominatim
- CORS headers for web requests
- Rate limiting with delays
- Error handling and logging

### 3. Update TypeScript Types (Auto-generated)
The `src/integrations/supabase/types.ts` will automatically update after migration to include:
```typescript
latitude: number | null;
longitude: number | null;
```

### 4. Update Location Interface
**File**: `src/lib/locations.ts`
```typescript
export interface Location {
  // ... existing fields ...
  latitude: number | null;
  longitude: number | null;
}
```

## Technical Considerations

### Why Nominatim?
- **Free**: No API key or payment required
- **Reliable**: Maintained by OpenStreetMap
- **Good for addresses**: Works well with European (Dutch) addresses
- **Trade-off**: Rate limited to 1 req/sec (acceptable for one-time batch)

### Future Enhancements (not in this phase)
- Trigger geocoding when locations are created/updated
- Interactive map view on `/locations` page using Leaflet
- "Nearby clubs" feature using stored coordinates

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/[timestamp].sql` | Create | Add lat/lng columns |
| `supabase/functions/geocode-locations/index.ts` | Create | Batch geocoding function |
| `supabase/config.toml` | Modify | Add function config (verify_jwt = false) |
| `src/lib/locations.ts` | Modify | Add lat/lng to Location interface |

