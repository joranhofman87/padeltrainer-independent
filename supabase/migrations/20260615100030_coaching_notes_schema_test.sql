-- Coaching & Progress v1 — schema sanity (runs on every db reset / CI migrations job).
-- Mirrors 20260611160002_get_players_overview_test.sql: fail loudly if a prior
-- migration silently didn't create an object the feature depends on.

DO $$
BEGIN
  IF to_regclass('public.session_player_notes') IS NULL THEN
    RAISE EXCEPTION 'session_player_notes table missing';
  END IF;
  IF to_regclass('public.coaching_note_views') IS NULL THEN
    RAISE EXCEPTION 'coaching_note_views table missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_player_notes' AND relrowsecurity) THEN
    RAISE EXCEPTION 'RLS not enabled on session_player_notes';
  END IF;
  IF to_regprocedure('public.get_player_journey(uuid, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'get_player_journey RPC missing';
  END IF;
  IF to_regprocedure('public.get_unseen_shared_feedback_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'get_unseen_shared_feedback_count RPC missing';
  END IF;
  -- the four SELECT policies + three INSERT policies that enforce the visibility matrix
  IF (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'session_player_notes') < 9 THEN
    RAISE EXCEPTION 'session_player_notes is missing RLS policies (expected >= 9)';
  END IF;
  RAISE NOTICE 'coaching & progress schema OK';
END $$;
