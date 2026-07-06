-- FIX: changing any profile's skill_rating has been failing app-wide with
--   new row for relation "player_rating_history" violates check constraint
--   "player_rating_history_source_check"
-- (hit by the owner 2026-07-06 editing a trainer's KNLTB rating from both the
-- trainer dashboard and the academy editor).
--
-- Root cause: the DIVERGENCE-6 sync trigger (20260613200000,
-- record_skill_rating_history) appends a history row with source 'profile'
-- (its one-time reconcile uses 'profile_reconcile'), but the table's CHECK
-- (20260117133442) only allows ('manual', 'knltb_scrape'). The trigger
-- migration applied cleanly because its reconcile INSERT matched ZERO rows at
-- the time — the violation stayed latent until the first real rating change,
-- after which EVERY skill_rating update (trainer self-edit, academy editor via
-- update-user, player edit, admin, onboarding) aborts on the trigger.
--
-- Fix: widen the CHECK to the values the system actually writes. `source` is
-- display-only downstream (RatingHistoryChart label, admin table), so no
-- consumer change is needed.

ALTER TABLE public.player_rating_history
  DROP CONSTRAINT IF EXISTS player_rating_history_source_check;

ALTER TABLE public.player_rating_history
  ADD CONSTRAINT player_rating_history_source_check
  CHECK (source IN ('manual', 'knltb_scrape', 'profile', 'profile_reconcile'));
