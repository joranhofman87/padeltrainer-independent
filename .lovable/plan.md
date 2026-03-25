
## Fix Plan: Restore Academy Data + Player Bookings After RLS Recursion

### What I found
- The app is still hitting `500` with: **`infinite recursion detected in policy for relation "trainer_profiles"`**.
- The failing request is even a simple profile read (`/profiles?user_id=...`), which explains why:
  - academy context appears empty
  - player bookings page also breaks
- The previous migration fixed one part (`get_profile_id_for_user`) but the current `trainer_profiles` player policy still queries `bookings` directly under RLS, which re-enters other policies and loops.

### Implementation
1. **Create a new migration** to fully break recursion at the source (policy-level, no frontend changes).
2. **Add a SECURITY DEFINER helper** (public schema) that checks if the current user has ever booked a given trainer:
   - input: `trainer_profile_id`
   - internally resolves player profile id (via `get_profile_id_for_user(auth.uid())`)
   - checks `bookings + availability_slots`
   - returns boolean
3. **Replace policy** `Players can view profiles of their trainers` on `trainer_profiles` to use that helper function, so policy evaluation no longer queries `bookings` with RLS.
4. **Harden bookings player policies** (same migration) to remove direct `profiles` subqueries:
   - `Players can view their own bookings`
   - `Players can create bookings`
   - `Players can update their own bookings`
   Use `player_id = public.get_profile_id_for_user(auth.uid())`.
5. Keep all existing access scope intact (only recursion path removed, no broad permission expansion).

### Files to change
- `supabase/migrations/<new_timestamp>_fix_trainer_profiles_recursion.sql` (new)

### Technical details
- Root cycle currently involves:
  - `profiles` policy referencing `trainer_profiles`
  - `trainer_profiles` player policy referencing `bookings`
  - `bookings` policies referencing `profiles` / `trainer_profiles`
- Moving the trainer-visibility check into a **SECURITY DEFINER** function prevents RLS re-entry loops while preserving row filtering logic.
- No changes needed in React code; once RLS stops failing, existing queries should render academy data and player bookings again.

### Verification after migration
1. Confirm `/profiles?user_id=...` returns 200 (no recursion error).
2. Open RL Performance academy dashboard/profile: data and forms should reappear.
3. Open player bookings page: bookings list should load again.
4. Spot-check trainer name resolution still works in bookings/cards.
