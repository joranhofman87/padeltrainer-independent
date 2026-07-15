-- S01 (audit, CRITICAL — cross-tenant takeover): the academy_trainers INSERT policy validated
-- ONLY the academy side —
--   CREATE POLICY "Academy managers can create trainer records" ON public.academy_trainers
--     FOR INSERT WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));
-- so any academy manager could POST a row linking an ARBITRARY trainer_profile_id at
-- status='active' — no trainer consent, no invitation. That single self-authored row makes
-- is_academy_trainer / is_active_academy_trainer(me, victim) return true, unlocking read/write
-- over the victim trainer's profile, PII, students, availability and bookings: a full
-- cross-tenant takeover of ANY trainer on the platform, from one INSERT.
--
-- Requiring merely "an accepted invitation exists" (the audit's first-pass fix) is NOT enough on
-- its own: the invitations UPDATE policy "Academy managers can update invitations" lets a manager
-- set status='accepted' + trainer_profile_id on an invitation they created, i.e. forge the
-- acceptance. The robust consent gate is that the accepting INSERT is attributable to the TRAINER
-- — trainer_profile_id must belong to auth.uid() — which a manager can never satisfy for a victim.
--
-- Legitimate INSERT paths, all preserved:
--   * manager provisions a trainer   -> create-academy-trainer edge fn (service role, bypasses RLS)
--   * admin links a trainer          -> "Admins can insert academy trainers" (unchanged)
--   * trainer joins own academy      -> new self-add policy (they manage it → both sides are them)
--   * trainer accepts an invitation  -> new accept policy (their own profile + an invite to them)
-- The manager can NO LONGER unilaterally attach an arbitrary trainer via PostgREST.

DROP POLICY IF EXISTS "Academy managers can create trainer records" ON public.academy_trainers;

-- A trainer may add THEMSELVES to an academy they manage (an owner/manager listing themselves as a
-- coach). Both sides resolve to auth.uid(), so it is inherently consented. Backs addSelfAsAcademyTrainer.
CREATE POLICY "Trainers can join an academy they manage"
  ON public.academy_trainers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    trainer_profile_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
    AND academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  );

-- A trainer may join an academy that INVITED them, by accepting. Keyed on trainer_profile_id =
-- auth.uid()'s own profile, so even a manager who FORGED the invitation's acceptance still cannot
-- insert the victim's membership (the victim's profile is not theirs). Backs
-- respondToAcademyTrainerInvitation — which the old manager-only INSERT policy actually blocked for
-- the accepting (non-manager) trainer, so this also repairs that path.
CREATE POLICY "Trainers can accept an academy invitation"
  ON public.academy_trainers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    trainer_profile_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.academy_trainer_invitations i
      WHERE i.academy_profile_id = academy_trainers.academy_profile_id
        AND i.trainer_profile_id = academy_trainers.trainer_profile_id
        AND i.status = 'accepted'
    )
  );
