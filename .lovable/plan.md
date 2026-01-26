

# Auto-Follow and Prospect Tracking for Cycle Registrations

## Overview
When a player submits a cycle registration form, we will:
1. **Auto-follow** the trainer or club (depending on cycle owner type)
2. **Add them to the student list** with a "prospect" status (hasn't trained yet)

This builds an email list for trainers and clubs to market future lessons.

---

## Current State Analysis

### Registration Flow
- Players register via `CycleApplicationForm.tsx` (public pages) or `AddIntakeRequestDialog.tsx` (manual registration by managers)
- Registration calls `submitIntakeRequest()` in `src/lib/cycles.ts`
- The cycle has `owner_type` ('trainer' or 'club') and `owner_id` to identify who owns the cycle

### Follower System
- **Trainers**: `trainer_followers` table exists with `player_id`, `trainer_id`, `notify_new_availability`
- **Clubs**: No `club_followers` table exists - **needs to be created**

### Student Lists
- **Trainers**: `guest_players` table (no status/source tracking)
- **Clubs**: `club_players` table (no status/source tracking)
- Neither table currently tracks whether someone has trained or is just a prospect

---

## Implementation Plan

### 1. Database Changes

#### 1.1 Create `club_followers` Table
```sql
CREATE TABLE public.club_followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  club_profile_id UUID NOT NULL REFERENCES club_profiles(id) ON DELETE CASCADE,
  notify_new_availability BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, club_profile_id)
);

ALTER TABLE public.club_followers ENABLE ROW LEVEL SECURITY;

-- RLS policies for club_followers
CREATE POLICY "Players can view their club follows"
ON public.club_followers FOR SELECT
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can create club follows"
ON public.club_followers FOR INSERT
WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can delete club follows"
ON public.club_followers FOR DELETE
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Club managers can view their followers"
ON public.club_followers FOR SELECT
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));
```

#### 1.2 Add Status Columns to Student Tables
```sql
-- Add source and training status to guest_players
ALTER TABLE public.guest_players 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS has_trained BOOLEAN NOT NULL DEFAULT false;

-- Add source and training status to club_players
ALTER TABLE public.club_players 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS has_trained BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN guest_players.source IS 'How they were added: manual, cycle_registration';
COMMENT ON COLUMN guest_players.has_trained IS 'Whether they have completed at least one lesson';
COMMENT ON COLUMN club_players.source IS 'How they were added: manual, cycle_registration';
COMMENT ON COLUMN club_players.has_trained IS 'Whether they have completed at least one lesson';
```

#### 1.3 Add RLS Policy for Cycle Registration Insert
Since players submit registrations themselves but aren't trainers/club managers, we need RLS policies that allow inserting into student tables during registration:

```sql
-- Allow players to be added to guest_players when registering for trainer cycles
CREATE POLICY "Players can register as guest players for trainer cycles"
ON public.guest_players FOR INSERT
WITH CHECK (
  linked_profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
  AND source = 'cycle_registration'
);

-- Allow players to be added to club_players when registering for club cycles
CREATE POLICY "Players can register as club players for club cycles"
ON public.club_players FOR INSERT
WITH CHECK (
  linked_profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
  AND source = 'cycle_registration'
);
```

---

### 2. Backend Changes

#### 2.1 Update `submitIntakeRequest()` Function
Modify `src/lib/cycles.ts` to:
1. Fetch the cycle to determine owner type/id
2. Auto-follow the trainer or club (upsert to avoid duplicates)
3. Add player to appropriate student list as a prospect

```typescript
export async function submitIntakeRequest(input: IntakeRequestInput): Promise<IntakeRequest> {
  // ... existing rate limiting code ...

  // 1. Fetch cycle to get owner info
  const { data: cycle } = await supabase
    .from('cycles')
    .select('owner_type, owner_id')
    .eq('id', input.cycle_id)
    .single();

  // 2. Insert intake request (existing code)
  const { data, error } = await supabase
    .from('intake_requests')
    .insert(insertData)
    .select()
    .single();
  
  if (error) throw error;

  // 3. Auto-follow trainer or club (silent - don't fail registration if this fails)
  if (cycle) {
    await autoFollowOwner(cycle.owner_type, cycle.owner_id, input.player_id);
    await addToStudentList(cycle.owner_type, cycle.owner_id, input);
  }

  return toIntakeRequest(data);
}
```

#### 2.2 Helper Functions

```typescript
// Auto-follow the cycle owner (trainer or club)
async function autoFollowOwner(
  ownerType: 'trainer' | 'club',
  ownerId: string,
  playerId: string
): Promise<void> {
  try {
    if (ownerType === 'trainer') {
      await supabase
        .from('trainer_followers')
        .upsert({
          player_id: playerId,
          trainer_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,trainer_id' });
    } else {
      await supabase
        .from('club_followers')
        .upsert({
          player_id: playerId,
          club_profile_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,club_profile_id' });
    }
  } catch (error) {
    console.error('Auto-follow failed (non-blocking):', error);
  }
}

// Add player to student list as a prospect
async function addToStudentList(
  ownerType: 'trainer' | 'club',
  ownerId: string,
  input: IntakeRequestInput
): Promise<void> {
  try {
    if (ownerType === 'trainer') {
      await supabase
        .from('guest_players')
        .upsert({
          trainer_id: ownerId,
          full_name: input.full_name,
          email: input.email,
          phone: input.phone || null,
          skill_rating: input.rating || null,
          rating_system: input.rating_system || 'knltb',
          linked_profile_id: input.player_id,
          source: 'cycle_registration',
          has_trained: false,
        }, { 
          onConflict: 'trainer_id,email',
          ignoreDuplicates: false 
        });
    } else {
      await supabase
        .from('club_players')
        .upsert({
          club_profile_id: ownerId,
          full_name: input.full_name,
          email: input.email,
          phone: input.phone || null,
          skill_rating: input.rating || null,
          rating_system: input.rating_system || 'knltb',
          linked_profile_id: input.player_id,
          source: 'cycle_registration',
          has_trained: false,
        }, { 
          onConflict: 'club_profile_id,email',
          ignoreDuplicates: false 
        });
    }
  } catch (error) {
    console.error('Add to student list failed (non-blocking):', error);
  }
}
```

---

### 3. Frontend Updates

#### 3.1 Students Table - Show Prospect Badge
Update the player list components (`TrainerPlayers.tsx`, `ClubPlayers.tsx`) to:
- Show a "Prospect" badge for players where `has_trained = false`
- Allow filtering by trained/not-trained status
- Show the source (manual vs. registration)

#### 3.2 Create `useFollowClub` Hook
Mirror `useFollowTrainer.ts` for clubs:
```typescript
// src/hooks/useFollowClub.ts
export function useFollowClub(clubProfileId: string | null) {
  // Similar implementation to useFollowTrainer
  // Uses club_followers table instead
}
```

#### 3.3 Add Follow Button to Club Profiles
Add a follow button to the public club page (`src/pages/club/ClubProfile.tsx`) so players can manually follow clubs too.

---

### 4. Unique Constraint for `club_players`
Add email uniqueness constraint to prevent duplicate entries:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS unique_club_player_email 
ON public.club_players (club_profile_id, email) 
WHERE email IS NOT NULL AND email != '';
```

---

## Technical Details

### Files to Modify:
1. **Database Migration** - Create `club_followers` table, add columns to student tables
2. `src/lib/cycles.ts` - Add auto-follow and student list logic to `submitIntakeRequest()`
3. `src/hooks/useFollowClub.ts` - New hook for club following
4. `src/pages/TrainerPlayers.tsx` - Show prospect/trained status
5. `src/pages/club/ClubPlayers.tsx` - Show prospect/trained status
6. `src/pages/club/ClubProfile.tsx` - Add follow button

### Error Handling:
- Follow and student list operations are **non-blocking** (won't fail registration)
- Use `upsert` to handle duplicates gracefully
- Log errors for debugging but don't surface them to users

### Data Flow:
```text
Player submits registration
       ↓
submitIntakeRequest() called
       ↓
Insert intake_request (existing)
       ↓
Fetch cycle owner_type/owner_id
       ↓
   ┌──────────────────┐
   │ owner_type check │
   └──────────────────┘
         ↓                    ↓
   [trainer]            [club]
         ↓                    ↓
Upsert trainer_followers  Upsert club_followers
Upsert guest_players      Upsert club_players
(source: cycle_registration, has_trained: false)
```

---

## Benefits
- **Email Marketing**: Trainers/clubs can send notifications to all followers and prospects
- **Lead Tracking**: Clear distinction between prospects and active students
- **Engagement**: Players stay connected even if they don't book immediately
- **Data Quality**: `linked_profile_id` connects guest records to real user accounts

