-- 10c-b review corrections (findings 2, 3, 4). Forward-only CREATE OR REPLACE;
-- privileges and comments on the replaced functions persist.
--
-- 2. notif_digest_item_open_slots_v1 froze whatever structured values it was
--    handed as long as they were "safe" text. It accepted 2026-02-30, 25:99,
--    a date_to BEFORE date_from, slot_count 0, and slot_reopened rows carrying
--    new_availability fields. Freezing an impossible value is worse than
--    rejecting it: digest_item is IMMUTABLE and hash-covered, so a malformed item
--    survives into the frozen request and renders nonsense that cannot be fixed
--    inside the 23-hour idempotency window. Validation is now subtype-specific
--    and structural, and rejects rather than coerces.
--
-- 3. The content guard's token shapes missed the Supabase PERSONAL ACCESS TOKEN
--    (sbp_…) — the exact credential class this rollout has been handling. Added.
--    Note the honest framing below: this is a bounded allow-list of known-bad
--    shapes, NOT exhaustive secret detection.
--
-- 4. release_cron_lease was not idempotent as documented. It matched on
--    (job_name, owner_token) only, so a second release by the same owner matched
--    the same row again, returned true a second time and incremented
--    release_count twice — corrupting the only release telemetry the lease has.
--    Release now additionally requires the lease to still be LIVE.

-- ---------------------------------------------------------------------------
-- 4. idempotent release
CREATE OR REPLACE FUNCTION public.release_cron_lease(
  p_job_name    text,
  p_owner_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_hit int; v_now timestamptz := now();
BEGIN
  IF p_owner_token IS NULL THEN RETURN false; END IF;
  -- `locked_until > v_now` is what makes this idempotent: the first release moves
  -- locked_until to now(), so a SECOND release by the same owner no longer matches
  -- a live lease -> false, and release_count is not touched again.
  UPDATE public.cron_job_leases
     SET locked_until  = v_now,
         release_count = release_count + 1
   WHERE job_name     = btrim(p_job_name)
     AND owner_token  = p_owner_token
     AND locked_until > v_now;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit = 1;
END $$;

COMMENT ON FUNCTION public.release_cron_lease(text,uuid) IS
  'Release a lease you own, idempotently: the first live-owner release returns true and increments release_count once; any later or wrong-token release returns false and changes nothing.';

-- ---------------------------------------------------------------------------
-- 3. content guard — add the Supabase PAT shape.
--
-- HONEST SCOPE: this is a bounded DENY-LIST of credential shapes we know appear
-- in this system (Supabase PAT + publishable/secret API keys, JWTs, Resend keys,
-- generic bearer prefixes), plus emails, phone-like numbers, URLs and angle
-- brackets. It is NOT exhaustive secret detection and must not be described as
-- such: an unknown vendor's key format would pass. The real containment is that
-- callers may only pass a small set of structured fields, each separately
-- validated, and that the renderer escapes everything.
CREATE OR REPLACE FUNCTION public.notif_digest_item_reject_unsafe(p_text text)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_text IS NULL OR p_text = '' THEN RETURN; END IF;
  IF p_text ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' THEN
    RAISE EXCEPTION 'digest item: value contains an email address';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(p_text, '[0-9]', 'g')) >= 9
     AND p_text ~ '(\+|00)?[0-9][0-9 ()./-]{7,}[0-9]' THEN
    RAISE EXCEPTION 'digest item: value contains a phone-like number';
  END IF;
  -- known credential shapes: Supabase PAT (sbp_), Supabase API keys
  -- (sb_secret_/sb_publishable_ and the legacy sb_ prefix), JWTs (eyJ…),
  -- OpenAI-style sk-, Resend re_, and a bare `Bearer ` prefix.
  IF p_text ~* '(bearer[[:space:]]|eyJ[[:alnum:]_-]{10,}|sbp_[[:alnum:]_-]{10,}|sb_[[:alnum:]_-]{10,}|sk-[[:alnum:]_-]{10,}|re_[[:alnum:]_-]{10,})' THEN
    RAISE EXCEPTION 'digest item: value looks like a token or secret';
  END IF;
  IF p_text ~* '([[:alpha:]][[:alnum:]+.-]*:)?//' OR p_text ~* '(javascript|data|vbscript):' THEN
    RAISE EXCEPTION 'digest item: value contains a URL or scheme';
  END IF;
  IF p_text ~ '[<>]' THEN
    RAISE EXCEPTION 'digest item: value contains angle brackets';
  END IF;
END $$;

COMMENT ON FUNCTION public.notif_digest_item_reject_unsafe(text) IS
  'Bounded content guard for digest item text: rejects emails, phone-like numbers, a KNOWN-SHAPE credential deny-list (sbp_/sb_/eyJ/sk-/re_/Bearer), URLs, schemes and angle brackets. NOT exhaustive secret detection.';

-- ---------------------------------------------------------------------------
-- 2. strict structured validators.

-- A real calendar date, not a date-SHAPED string. '2026-02-30' matches any
-- ^\d{4}-\d{2}-\d{2}$ regex but is not a day that exists; only a cast proves it.
CREATE OR REPLACE FUNCTION public.notif_digest_assert_iso_date(p_label text, p_value text)
RETURNS date
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE v date;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'digest item: % must be an ISO date (YYYY-MM-DD), got %', p_label, p_value;
  END IF;
  BEGIN
    v := p_value::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'digest item: % is not a real calendar date: %', p_label, p_value;
  END;
  -- Reject dates far outside any plausible scheduling window; a value like
  -- 0001-01-01 or 9999-12-31 is data corruption, not a booking.
  IF v < date '2000-01-01' OR v > date '2100-01-01' THEN
    RAISE EXCEPTION 'digest item: % is outside the supported range: %', p_label, p_value;
  END IF;
  RETURN v;
END $$;

-- Strict 24-hour HH:MM. Rejects 25:99, 7:30 (unpadded) and any seconds component.
CREATE OR REPLACE FUNCTION public.notif_digest_assert_hhmm(p_label text, p_value text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'digest item: % must be HH:MM in 24-hour form, got %', p_label, p_value;
  END IF;
  RETURN p_value;
END $$;

REVOKE ALL ON FUNCTION public.notif_digest_assert_iso_date(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notif_digest_assert_hhmm(text,text)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_digest_assert_iso_date(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notif_digest_assert_hhmm(text,text)     TO service_role;

-- The item minter, now subtype-structural.
--
-- PERMITTED FIELD COMBINATIONS (enforced, not merely documented):
--   new_availability : date_from [+ date_to] [+ slot_count]   — slot_date/slot_time FORBIDDEN
--   slot_reopened    : slot_date [+ slot_time]                — date_from/date_to/slot_count FORBIDDEN
-- Cross-subtype fields are rejected rather than ignored: silently dropping them
-- would freeze an item that does not describe what the producer actually meant.
CREATE OR REPLACE FUNCTION public.notif_digest_item_open_slots_v1(
  p_subtype text,
  p_locale  text,
  p_data    jsonb
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_loc     text;
  v_trainer text;
  v_from    text;  v_from_d date;
  v_to      text;  v_to_d   date;
  v_count   int;
  v_date    text;  v_date_d date;
  v_time    text;
  v_url     text;
  v_title   text;
  v_body    text;
  v_key     text;
BEGIN
  IF p_subtype IS NULL OR p_subtype NOT IN ('new_availability','slot_reopened') THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: subtype must be new_availability or slot_reopened (got %)', p_subtype;
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: data must be a json object';
  END IF;

  -- Unknown keys are refused: an unrecognised field means the producer and this
  -- schema disagree, and v1 is immutable, so guessing is not an option.
  FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
    IF v_key NOT IN ('trainer_name','date_from','date_to','slot_count','slot_date','slot_time','url') THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: unknown field % (v1 schema is closed)', v_key;
    END IF;
  END LOOP;

  v_loc := CASE WHEN lower(coalesce(p_locale,'')) LIKE 'nl%' THEN 'nl' ELSE 'en' END;

  v_trainer := nullif(btrim(coalesce(p_data->>'trainer_name','')), '');
  v_from    := nullif(btrim(coalesce(p_data->>'date_from','')), '');
  v_to      := nullif(btrim(coalesce(p_data->>'date_to','')), '');
  v_date    := nullif(btrim(coalesce(p_data->>'slot_date','')), '');
  v_time    := nullif(btrim(coalesce(p_data->>'slot_time','')), '');
  v_url     := nullif(btrim(coalesce(p_data->>'url','')), '');

  IF v_trainer IS NULL THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: trainer_name is required';
  END IF;
  PERFORM public.notif_digest_item_reject_unsafe(v_trainer);

  -- slot_count: must be a clean integer and, when present, must mean something
  -- (>= 1). Zero new slots is not an event worth an item.
  IF p_data ? 'slot_count' AND jsonb_typeof(p_data->'slot_count') <> 'null' THEN
    IF jsonb_typeof(p_data->'slot_count') <> 'number' OR (p_data->>'slot_count') ~ '[.]' THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_count must be an integer';
    END IF;
    v_count := (p_data->>'slot_count')::int;
    IF v_count < 1 OR v_count > 10000 THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_count must be between 1 and 10000 (got %)', v_count;
    END IF;
  END IF;

  IF p_subtype = 'new_availability' THEN
    IF v_date IS NOT NULL OR v_time IS NOT NULL THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_date/slot_time are not permitted for new_availability';
    END IF;
    IF v_from IS NULL THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: new_availability requires date_from';
    END IF;
    v_from_d := public.notif_digest_assert_iso_date('date_from', v_from);
    v_to_d   := public.notif_digest_assert_iso_date('date_to',   v_to);
    IF v_to_d IS NOT NULL AND v_to_d < v_from_d THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: date_to (%) is before date_from (%)', v_to, v_from;
    END IF;
  ELSE
    IF v_from IS NOT NULL OR v_to IS NOT NULL OR v_count IS NOT NULL THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: date_from/date_to/slot_count are not permitted for slot_reopened';
    END IF;
    IF v_date IS NULL THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_reopened requires slot_date';
    END IF;
    v_date_d := public.notif_digest_assert_iso_date('slot_date', v_date);
    v_time   := public.notif_digest_assert_hhmm('slot_time', v_time);
  END IF;

  IF v_url IS NOT NULL THEN
    IF v_url !~ '^/[[:alnum:]_~./-]*$' OR v_url LIKE '//%' OR v_url LIKE '%..%' THEN
      RAISE EXCEPTION 'digest item: url must be a safe app-relative path';
    END IF;
  END IF;

  v_trainer := left(v_trainer, 80);

  IF v_loc = 'nl' THEN
    IF p_subtype = 'new_availability' THEN
      v_title := 'Nieuwe beschikbaarheid van ' || v_trainer;
      v_body  := CASE
        WHEN v_to IS NOT NULL AND v_to <> v_from
          THEN coalesce(v_count::text || ' nieuwe momenten', 'Nieuwe momenten') || ' tussen ' || v_from || ' en ' || v_to || '.'
        ELSE coalesce(v_count::text || ' nieuwe momenten', 'Nieuwe momenten') || ' op ' || v_from || '.'
      END;
    ELSE
      v_title := 'Plek vrijgekomen bij ' || v_trainer;
      v_body  := CASE
        WHEN v_time IS NOT NULL THEN 'Er is een plek vrijgekomen op ' || v_date || ' om ' || v_time || '.'
        ELSE 'Er is een plek vrijgekomen op ' || v_date || '.'
      END;
    END IF;
  ELSE
    IF p_subtype = 'new_availability' THEN
      v_title := 'New availability from ' || v_trainer;
      v_body  := CASE
        WHEN v_to IS NOT NULL AND v_to <> v_from
          THEN coalesce(v_count::text || ' new slots', 'New slots') || ' between ' || v_from || ' and ' || v_to || '.'
        ELSE coalesce(v_count::text || ' new slots', 'New slots') || ' on ' || v_from || '.'
      END;
    ELSE
      v_title := 'A spot opened up with ' || v_trainer;
      v_body  := CASE
        WHEN v_time IS NOT NULL THEN 'A spot opened up on ' || v_date || ' at ' || v_time || '.'
        ELSE 'A spot opened up on ' || v_date || '.'
      END;
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'v',       1,
    'event',   'open_slots_player',
    'subtype', p_subtype,
    'locale',  v_loc,
    'title',   v_title,
    'body',    v_body,
    'url',     v_url,
    'data',    jsonb_strip_nulls(jsonb_build_object(
      'trainer_name', v_trainer,
      'date_from',    v_from,
      'date_to',      v_to,
      'slot_count',   v_count,
      'slot_date',    v_date,
      'slot_time',    v_time
    ))
  ));
END $$;

COMMENT ON FUNCTION public.notif_digest_item_open_slots_v1(text,text,jsonb) IS
  'Mint the IMMUTABLE v1 open_slots digest item. Subtype-structural: closed field set, real calendar dates, strict HH:MM, date ordering, slot_count >= 1, and cross-subtype fields rejected. Deterministic nl/en copy. Schema changes require v:2.';
