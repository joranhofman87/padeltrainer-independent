-- Phase 1 follow-up (external audit of PR #565, finding P1): person_links guaranteed each SOURCE
-- is absorbed at most once (profile_id UNIQUE, guest_player_id UNIQUE) but nothing prevented one
-- PERSON from absorbing TWO DIFFERENT profiles. That contradicts the model (§4.1: a person has at
-- most ONE login — persons.user_id is a single UNIQUE column — and Phase 2 builds "one row per
-- profile"): a backfill bug or a bad manual merge could link two app accounts to one person, and
-- Phase 3 readers would then conflate the two accounts' bookings, money, and privacy state while
-- persons.user_id can only represent one of them.
--
-- Enforce the intended shape — at most 1 profile + N guests per person:
CREATE UNIQUE INDEX IF NOT EXISTS person_links_one_profile_per_person
  ON public.person_links (person_id)
  WHERE profile_id IS NOT NULL;
