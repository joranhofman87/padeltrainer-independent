

# Fix: Only Show Registrations for the Correct Location

## Problem
The `getLocationCycles` function finds all academies/trainers/clubs linked to a location, then fetches **all** their cycles — regardless of which location the cycle is actually assigned to. So a registration for "TC Boemerang (Kaatsheuvel)" shows up on the "Udenhout" club page because the academy "RL Padel Performance" is linked to both locations.

## Solution
Add a `location_id` filter to each cycle query inside `getLocationCycles`. Since cycles already have a `location_id` field, we just need to also match `location_id = locationId` in the queries.

## Changes

### File: `src/lib/cycles.ts` — `getLocationCycles` function (~lines 362-390)

For each of the three cycle queries (trainer, academy, club), add `.eq('location_id', locationId)` so only cycles specifically assigned to that location are returned.

**Before:**
```typescript
.eq('owner_type', 'academy')
.in('owner_id', academyIds)
.eq('status', 'open');
```

**After:**
```typescript
.eq('owner_type', 'academy')
.in('owner_id', academyIds)
.eq('status', 'open')
.eq('location_id', locationId);
```

Same change for trainer and club queries. This ensures the Boemerang registration only shows on the Boemerang/Kaatsheuvel location page, not on Udenhout.

### Files
- `src/lib/cycles.ts` — Add `location_id` filter to all 3 queries in `getLocationCycles`

