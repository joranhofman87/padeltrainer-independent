

# Server-Side Pagination & Search for Locations Page

## Problem
The page loads all 13,000+ locations in 13 sequential API calls, then renders them all at once. This causes multi-second load times and UI freezing.

## Solution
Move filtering and pagination to the database. Load 48 locations per page. Search queries the full database server-side.

## Changes

### 1. Add `searchLocationsPage()` to `src/lib/locations.ts`
New function that accepts `{ search, country, city, trainersAvailable, indoorOnly, page, pageSize }`:
- Uses Supabase `.select()` with only the columns needed for `LocationCard` (no `description`, `opening_hours`, etc.)
- Applies `.ilike()` for search (name + city), `.eq()` for country/city filters
- For `trainersAvailable` filter: use an `.in()` subquery against `trainer_locations` location IDs
- For `indoorOnly`: `.gt('indoor_courts', 0)`
- Uses `.range()` for pagination (48 per page)
- Requests `{ count: 'exact' }` to get total for pagination UI
- Returns `{ data: Location[], totalCount: number }`

### 2. Refactor `src/pages/Locations.tsx`
- Replace `getActiveLocations()` with `searchLocationsPage()` — call it reactively when filters or page change
- Debounce search input (300ms) before triggering query
- Remove client-side `filteredLocations` useMemo — server handles filtering now
- Add page state and pagination controls at bottom (using existing `Pagination` components)
- Keep `getUniqueCities()`, `getUniqueCountries()`, `getClaimedLocationIds()`, `getLocationTrainerCounts()` as-is for filter dropdowns and card badges (these are lightweight)
- Featured locations: fetch separately with a small dedicated query filtered by `subscription_status = 'active'` (max ~10 rows)
- Map view: pass only the current page's locations (not all 13K)

### 3. Translation keys
Add `locations.page` / `locations.of` or similar for pagination labels (likely already covered by existing `pagination.previous` / `pagination.next` keys).

## Performance impact
- **Before**: 13 sequential queries → 13,000 rows → 13,000 DOM cards
- **After**: 1 query → 48 rows → 48 DOM cards
- Load time drops from 5-10s to <500ms

## Files
- `src/lib/locations.ts` — Add `searchLocationsPage()`
- `src/pages/Locations.tsx` — Server-side search, pagination, debounced input

