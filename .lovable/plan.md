
# Academy-Level Players — COMPLETED

## What was done

### Database Migration
- Added `academy_profile_id` column (nullable FK to `academy_profiles`) to `guest_players`
- Made `trainer_id` nullable
- Added CHECK constraint: either `trainer_id` or `academy_profile_id` must be set
- Updated unique email indexes for both trainer-scoped and academy-scoped uniqueness
- Updated all 4 academy RLS policies (SELECT/INSERT/UPDATE/DELETE) to cover academy-level players

### Frontend Changes
- `AddPlayerDialog`: accepts optional `academyId` prop, inserts with `academy_profile_id` when provided
- `ImportPlayersDialog`: same approach with optional `academyId`
- `AcademyPlayers`: fetches both trainer-owned and academy-level players, trainer selector is now a filter (not a prerequisite), "Trainer" column always visible showing "Academy" for academy-level players
