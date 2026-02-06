

# Fix: Bookings Not Loading (Missing Database Relationship)

## Root Cause

The error `"Could not find a relationship between 'trainer_profiles' and 'profiles'"` means there is **no foreign key** between the `trainer_profiles` table and the `profiles` table. Both tables have a `user_id` column, but PostgREST (the API layer) needs an explicit foreign key constraint to allow nested joins like `trainer_profiles(profiles(...))`.

Three places use this broken nested join pattern:

1. **`src/pages/PlayerBookings.tsx`** (line 73-76) -- causes "Failed to load bookings" error
2. **`src/pages/PlayerDashboard.tsx`** (line 150-153) -- causes dashboard stats to show 0
3. **`src/lib/lessons.ts`** (line 174) -- `getPlayerBookings` function (unused currently since PlayerBookings has its own inline query, but still broken)

## Fix Approach

Instead of adding a FK constraint (which could have side effects on cascade deletes), we'll **restructure the queries** to fetch trainer info in a separate step -- the same pattern `BookingSuccess.tsx` already uses successfully.

### File 1: `src/pages/PlayerBookings.tsx`

**Current (broken):**
```
availability_slots(
  trainer_profiles(
    profiles(full_name, avatar_url, email)
  )
)
```

**Fixed:** Query `availability_slots(start_time, end_time, trainer_id)` and `lessons(...)` only. Then fetch trainer info (name, avatar) with a second query joining `trainer_profiles` + `profiles_public` by `user_id`.

Update the interface and all references to `booking.availability_slots.trainer_profiles.profiles.full_name` to use the enriched data instead.

### File 2: `src/pages/PlayerDashboard.tsx`

**Current (broken):**
```
availability_slots(
  trainer_id,
  trainer_profiles(
    user_id,
    profiles(full_name)
  )
)
```

**Fixed:** Query only `availability_slots(start_time, trainer_id)` and `lessons(title, location)`. Then do a separate lookup for trainer names via `trainer_profiles` + `profiles_public`.

### File 3: `src/lib/lessons.ts`

**Current (broken):**
```
availability_slots(*, trainer_profiles(*, profiles(*)))
```

**Fixed:** Simplify the select to `availability_slots(*), lessons(*)` and remove the nested join. The calling code should handle trainer enrichment separately if needed.

## Files to Change

1. **`src/pages/PlayerBookings.tsx`** -- restructure query, enrich trainer data separately, update template references
2. **`src/pages/PlayerDashboard.tsx`** -- restructure query, enrich trainer data separately
3. **`src/lib/lessons.ts`** -- remove broken nested join from `getPlayerBookings`

