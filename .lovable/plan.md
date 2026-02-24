
# Academy-Level Players

## Problem
Currently, every player in the `guest_players` table **must** be assigned to a specific trainer (`trainer_id NOT NULL`). When an academy manager adds a player, they're forced to pick a trainer first. This doesn't make sense for academies who want to manage players at the organization level -- players belong to the academy, not necessarily to one trainer.

## Solution
Add an optional `academy_profile_id` column to `guest_players` and make `trainer_id` nullable. When an academy manager adds a player from the academy dashboard, the player is linked to the academy by default. A trainer can optionally be assigned, but it's not required.

## What changes for users

**Academy managers:**
- Click "Add Player" on the players page -- the player is added to the academy directly
- The trainer selector becomes optional (they *can* assign a trainer, but don't have to)
- Players without a trainer show up as "Academy" in the trainer column

**Trainers:**
- No change -- trainers still add players to themselves as before

## Technical Details

### 1. Database Migration
- Add `academy_profile_id` column (nullable FK to `academy_profiles`)
- Make `trainer_id` nullable
- Add a CHECK constraint: either `trainer_id` or `academy_profile_id` must be set (a player must belong to something)
- Update the unique email index to work with the new structure (unique per trainer OR per academy)
- Add RLS policies so academy managers can manage academy-level players (where `academy_profile_id` matches their academy)
- Update existing academy RLS policies to also cover academy-level players (not just trainer-owned)

### 2. AcademyPlayers page changes (`src/pages/academy/AcademyPlayers.tsx`)
- Fetch players where `academy_profile_id` matches the active academy, in addition to trainer-owned players
- The trainer selector in the header becomes a filter (not a prerequisite for adding)
- When adding a player, pass `academyId` instead of requiring `trainerId`

### 3. AddPlayerDialog changes (`src/components/trainer/AddPlayerDialog.tsx`)
- Accept an optional `academyId` prop alongside the existing `trainerId`
- When `academyId` is provided, insert with `academy_profile_id` set and `trainer_id` as optional
- Add an optional trainer dropdown when adding from academy context
- Keep existing trainer-only behavior when used from trainer pages

### 4. ImportPlayersDialog changes (`src/components/trainer/ImportPlayersDialog.tsx`)
- Same approach: accept optional `academyId`, insert academy-level players

### Files to modify
- **Database migration** (new file) -- add column, update constraints, update RLS
- `src/pages/academy/AcademyPlayers.tsx` -- fetch academy-level players, make trainer optional
- `src/components/trainer/AddPlayerDialog.tsx` -- support `academyId` prop
- `src/components/trainer/ImportPlayersDialog.tsx` -- support `academyId` prop
