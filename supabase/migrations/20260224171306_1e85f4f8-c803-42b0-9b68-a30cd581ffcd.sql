
-- 1. Add academy_profile_id column
ALTER TABLE public.guest_players
ADD COLUMN academy_profile_id UUID REFERENCES public.academy_profiles(id) ON DELETE CASCADE;

-- 2. Make trainer_id nullable
ALTER TABLE public.guest_players
ALTER COLUMN trainer_id DROP NOT NULL;

-- 3. Add CHECK constraint: must belong to either a trainer or an academy
ALTER TABLE public.guest_players
ADD CONSTRAINT guest_players_owner_check
CHECK (trainer_id IS NOT NULL OR academy_profile_id IS NOT NULL);

-- 4. Drop the old unique constraint and index, create new ones
ALTER TABLE public.guest_players DROP CONSTRAINT IF EXISTS unique_trainer_email;
DROP INDEX IF EXISTS idx_guest_players_trainer_email_unique;

-- Unique email per trainer (when trainer is set)
CREATE UNIQUE INDEX idx_guest_players_trainer_email_unique
ON public.guest_players (trainer_id, email)
WHERE (email IS NOT NULL AND email <> '' AND trainer_id IS NOT NULL);

-- Unique email per academy (when academy is set and no trainer)
CREATE UNIQUE INDEX idx_guest_players_academy_email_unique
ON public.guest_players (academy_profile_id, email)
WHERE (email IS NOT NULL AND email <> '' AND academy_profile_id IS NOT NULL AND trainer_id IS NULL);

-- 5. Add index for academy lookups
CREATE INDEX idx_guest_players_academy_profile_id
ON public.guest_players (academy_profile_id)
WHERE academy_profile_id IS NOT NULL;

-- 6. Update academy RLS policies to also cover academy-level players

DROP POLICY IF EXISTS "Academy managers can view their trainers guest players" ON public.guest_players;
CREATE POLICY "Academy managers can view their trainers guest players"
ON public.guest_players FOR SELECT
USING (
  (trainer_id IN (
    SELECT at.trainer_profile_id FROM academy_trainers at
    WHERE at.status = 'active'
    AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  ))
  OR
  (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())))
);

DROP POLICY IF EXISTS "Academy managers can create guest players for their trainers" ON public.guest_players;
CREATE POLICY "Academy managers can create guest players for their trainers"
ON public.guest_players FOR INSERT
WITH CHECK (
  (trainer_id IN (
    SELECT at.trainer_profile_id FROM academy_trainers at
    WHERE at.status = 'active'
    AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  ))
  OR
  (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())))
);

DROP POLICY IF EXISTS "Academy managers can update their trainers guest players" ON public.guest_players;
CREATE POLICY "Academy managers can update their trainers guest players"
ON public.guest_players FOR UPDATE
USING (
  (trainer_id IN (
    SELECT at.trainer_profile_id FROM academy_trainers at
    WHERE at.status = 'active'
    AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  ))
  OR
  (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())))
);

DROP POLICY IF EXISTS "Academy managers can delete their trainers guest players" ON public.guest_players;
CREATE POLICY "Academy managers can delete their trainers guest players"
ON public.guest_players FOR DELETE
USING (
  (trainer_id IN (
    SELECT at.trainer_profile_id FROM academy_trainers at
    WHERE at.status = 'active'
    AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  ))
  OR
  (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())))
);
