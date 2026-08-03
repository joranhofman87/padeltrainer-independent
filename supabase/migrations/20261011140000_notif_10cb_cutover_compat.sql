-- 10c-b D — CUTOVER COMPATIBILITY for state that already exists, and for cached bundles.
--
-- Two defects this closes, both about the world as it is at deploy time rather than the world
-- the new code creates.

-- ===========================================================================
-- 1. A CACHED settings bundle can still write the v1 preference column.
--
-- Slice C copied notification_preferences.open_slots_digest into
-- notification_preferences_v2 ONCE, and slice D removed the v1 control from the settings page.
-- But the frontend deploys automatically and users hold cached bundles: an old page can keep
-- writing open_slots_digest for a while after cutover, and nothing propagated that write
-- forward. The result was a settings UI that appears to work while delivery ignores it —
-- switching the cached control OFF still mails, switching it ON stays silent. That is worse
-- than an error, because the user is told the opposite of the truth.
--
-- So the legacy column now MIRRORS forward for as long as it exists. This is deliberately a
-- one-way bridge: v1 -> v2 only. v2 is the source of truth, and a v2 write must never be
-- clobbered by a stale v1 page.
CREATE OR REPLACE FUNCTION public.notif_mirror_open_slots_pref_to_v2()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  -- Only the four cadences v2 understands; anything else is ignored rather than coerced into a
  -- sending cadence (same rule as slice C's backfill).
  IF NEW.open_slots_digest IS NULL OR NEW.open_slots_digest NOT IN ('off','instant','daily','weekly') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = NEW.user_id) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only an actual CHANGE to this column is a user action. An unrelated UPDATE must not
    -- resurrect a stale cadence over a newer v2 choice.
    IF NEW.open_slots_digest IS NOT DISTINCT FROM OLD.open_slots_digest THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
    VALUES (NEW.user_id, 'open_slots_player', NEW.open_slots_digest)
    ON CONFLICT (user_id, event_type)
    DO UPDATE SET email_frequency = EXCLUDED.email_frequency, updated_at = now();
    RETURN NEW;
  END IF;

  -- INSERT is DIFFERENT, and getting this wrong re-enables mail after an opt-out.
  --
  -- The settings page upserts a PARTIAL row when the user changes any OTHER legacy control, and
  -- open_slots_digest then takes its column DEFAULT of 'weekly' (20260210090026). That is not a
  -- choice about open slots at all. Mirroring it with DO UPDATE would overwrite an explicit v2
  -- 'off' with 'weekly' and start mailing someone who had opted out — and this affects the
  -- CURRENT bundle, not just cached ones.
  --
  -- So an INSERT may only SEED a v2 row that does not exist yet. It can never overwrite one.
  -- A cached page's genuine opt-out on a user who already has a v2 row arrives as an UPDATE
  -- (the row exists), which is handled above.
  INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
  VALUES (NEW.user_id, 'open_slots_player', NEW.open_slots_digest)
  ON CONFLICT (user_id, event_type) DO NOTHING;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.notif_mirror_open_slots_pref_to_v2() IS
  'Cutover bridge: mirrors a legacy notification_preferences.open_slots_digest write forward into notification_preferences_v2(open_slots_player), so a CACHED settings bundle cannot silently disagree with delivery. One-way (v1 -> v2). Retire with the v1 column in 10c-d.';

DROP TRIGGER IF EXISTS trg_mirror_open_slots_pref_to_v2 ON public.notification_preferences;
CREATE TRIGGER trg_mirror_open_slots_pref_to_v2
  AFTER INSERT OR UPDATE OF open_slots_digest ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.notif_mirror_open_slots_pref_to_v2();

-- ===========================================================================
-- 2. Rows enqueued BEFORE this deploy have no destination_fingerprint.
--
-- The instant worker now refuses to send when the live address no longer matches the frozen
-- fingerprint — but that comparison is written `IF destination_fingerprint IS NOT NULL`, so
-- every row queued before the fingerprint freeze skips it and could still be delivered to a
-- stale address. This affects EVERY event, not just open slots, because the worker applies the
-- policy to all instant email rows.
--
-- Backfilling from the row's own frozen destination is exactly right: it records what the
-- resolver decided at enqueue, which is the value the check needs to compare against. It cannot
-- invent authorisation — a row whose address has since changed now fingerprints differently and
-- is stopped, which is the entire point.
UPDATE public.notification_outbox
   SET destination_fingerprint = public.notif_digest_destination_fingerprint(destination_normalized)
 WHERE channel = 'email'
   AND destination_fingerprint IS NULL
   AND destination_normalized IS NOT NULL
   AND btrim(destination_normalized) <> ''
   AND status IN ('pending','processing');
