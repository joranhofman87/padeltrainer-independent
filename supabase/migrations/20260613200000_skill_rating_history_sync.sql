-- DIVERGENCE-6 (write side): profiles.skill_rating is the source of truth for a
-- player's current rating, but several paths update it WITHOUT inserting a
-- player_rating_history row (onboarding, cycle application, admin edits, intake).
-- Read surfaces that show "current" from the last history row (rating-og-image,
-- ratingShareCard, the public rating page) then disagree with the profile. The
-- read fix in RatingHistoryChart handled the in-app stat; this keeps the DATA
-- consistent so every surface agrees without per-surface patches.
--
-- Trigger: whenever skill_rating changes, append a history row (deduped against
-- the latest one) using the profile's own rating_system. profiles DOES carry
-- rating_system, so the row is well-formed.

CREATE OR REPLACE FUNCTION public.record_skill_rating_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last numeric;
  v_system text := COALESCE(NEW.rating_system, 'knltb');
BEGIN
  IF NEW.skill_rating IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.skill_rating IS NOT DISTINCT FROM OLD.skill_rating THEN
    RETURN NEW;
  END IF;

  SELECT rating INTO v_last
    FROM public.player_rating_history
   WHERE profile_id = NEW.id AND rating_system = v_system
   ORDER BY scraped_at DESC
   LIMIT 1;

  IF v_last IS NULL OR v_last IS DISTINCT FROM NEW.skill_rating THEN
    INSERT INTO public.player_rating_history (profile_id, rating, rating_system, source, scraped_at)
    VALUES (NEW.id, NEW.skill_rating, v_system, 'profile', now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_skill_rating_history ON public.profiles;
CREATE TRIGGER trg_record_skill_rating_history
  AFTER UPDATE OF skill_rating ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.record_skill_rating_history();

-- Conservative one-time reconcile: only where history EXISTS but its latest row
-- drifted from the profile's current rating. (Players with no history are left
-- alone — we don't invent a tracking history for them.)
INSERT INTO public.player_rating_history (profile_id, rating, rating_system, source, scraped_at)
SELECT p.id, p.skill_rating, COALESCE(p.rating_system, 'knltb'), 'profile_reconcile', now()
FROM public.profiles p
WHERE p.skill_rating IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.player_rating_history h
    WHERE h.profile_id = p.id AND h.rating_system = COALESCE(p.rating_system, 'knltb')
  )
  AND (
    SELECT h.rating FROM public.player_rating_history h
    WHERE h.profile_id = p.id AND h.rating_system = COALESCE(p.rating_system, 'knltb')
    ORDER BY h.scraped_at DESC
    LIMIT 1
  ) IS DISTINCT FROM p.skill_rating;
