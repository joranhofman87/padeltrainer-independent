

# Fix: Map View Shows Only Current Page of Locations

## Problem
The map view receives `locations` from the paginated state (48 items per page via `searchLocationsPage`). When the user switches to map view, they only see one page's worth of markers — not all matching locations.

## Fix
When switching to map view, fetch **all** matching locations (without pagination) and pass those to `LocationsMap`. Keep the paginated fetch for list view.

## Changes

| File | Change |
|------|--------|
| `src/lib/locations.ts` | Add a new `searchLocationsAll` function that reuses the same filter logic as `searchLocationsPage` but without `.range()` — returns all matching `LocationListItem[]`. Handle Supabase's 1000-row default limit by paginating internally if `totalCount > 1000`. |
| `src/pages/Locations.tsx` | Add state `allMapLocations`. When `viewMode === 'map'`, call `searchLocationsAll` with current filters and store result. Pass `allMapLocations` (instead of paginated `locations`) to `<LocationsMap>`. |

This ensures the map always shows every location matching the active filters, regardless of pagination.

