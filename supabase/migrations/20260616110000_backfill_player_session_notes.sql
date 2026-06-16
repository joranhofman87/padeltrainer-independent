-- Backfill: preserve existing player attendance notes.
--
-- Until now, a player's free-text reflection on a past session was stored in
-- session_reports.notes (private). The player report UI now writes that note to
-- session_player_notes (the same store the journey uses, which carries the
-- private/shared visibility toggle) and no longer reads session_reports.notes.
-- Without this backfill, the handful of notes already written there would stop
-- being shown. Copy them across as private self-notes so they keep appearing on
-- the journey and the report widget.
--
-- session_reports.reporter_id is a profile id; session_player_notes needs both
-- the author's auth uid (author_id) and the player's profile id
-- (subject_profile_id), so we join profiles to resolve the uid.
--
-- Idempotent: the NOT EXISTS guard means a re-run inserts nothing.

INSERT INTO public.session_player_notes
  (slot_id, author_id, author_role, subject_profile_id, visibility, body, created_at)
SELECT
  sr.slot_id,
  p.user_id,
  'player',
  sr.reporter_id,
  'private',
  sr.notes,
  COALESCE(sr.created_at, now())
FROM public.session_reports sr
JOIN public.profiles p ON p.id = sr.reporter_id
WHERE sr.reporter_role = 'player'
  AND sr.notes IS NOT NULL
  AND btrim(sr.notes) <> ''
  AND p.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.session_player_notes spn
    WHERE spn.slot_id = sr.slot_id
      AND spn.subject_profile_id = sr.reporter_id
      AND spn.author_role = 'player'
      AND spn.body = sr.notes
  );
