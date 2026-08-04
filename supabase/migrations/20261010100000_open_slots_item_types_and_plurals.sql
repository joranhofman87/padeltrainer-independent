-- 10c-b review round 2 (findings 2 and 3). Forward-only CREATE OR REPLACE.
--
-- 2. THE CLOSED SCHEMA WAS NOT ACTUALLY CLOSED. Key membership was checked, but
--    every textual field was read with `->>`, which STRINGIFIES whatever it finds:
--      {"trainer_name": ["a","b"]}  -> '["a", "b"]'
--      {"trainer_name": {"x": 1}}   -> '{"x": 1}'
--      {"trainer_name": 42}         -> '42'
--      {"trainer_name": true}       -> 'true'
--    Each of those then sailed through the content guard and was FROZEN into an
--    immutable, hash-covered digest_item — rendering `New availability from
--    ["a", "b"]` with no way to correct it inside the 23-hour idempotency window.
--    Every textual field is now type-asserted as a JSON string BEFORE extraction.
--
-- 3. SINGULAR/PLURAL WAS WRONG, AND IT WAS FROZEN. The copy said "1 new slots" /
--    "1 nieuwe momenten". Because the rendered strings live inside the immutable
--    item, bad grammar could not be fixed by a later deploy for anything already
--    enqueued. Corrected to EN `1 new slot` / `N new slots` and NL `1 nieuw
--    moment` / `N nieuwe momenten`, preserving the existing no-count fallback
--    ("New slots" / "Nieuwe momenten").

-- Assert a field is a JSON *string* (or absent/null), then return its text.
-- Returning through one helper keeps extraction and type-checking inseparable:
-- there is no path that reads a field without first proving its type.
CREATE OR REPLACE FUNCTION public.notif_digest_json_text(p_data jsonb, p_field text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE v_type text;
BEGIN
  IF p_data IS NULL OR NOT (p_data ? p_field) THEN RETURN NULL; END IF;
  v_type := jsonb_typeof(p_data->p_field);
  IF v_type = 'null' THEN RETURN NULL; END IF;
  IF v_type <> 'string' THEN
    RAISE EXCEPTION 'digest item: % must be a JSON string, got %', p_field, v_type;
  END IF;
  RETURN nullif(btrim(p_data->>p_field), '');
END $$;

COMMENT ON FUNCTION public.notif_digest_json_text(jsonb,text) IS
  'Type-safe text extraction for digest items: rejects array/object/number/boolean rather than letting ->> stringify them into a frozen item.';

REVOKE ALL ON FUNCTION public.notif_digest_json_text(jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_digest_json_text(jsonb,text) TO service_role;

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
  v_phrase  text;
  v_key     text;
BEGIN
  IF p_subtype IS NULL OR p_subtype NOT IN ('new_availability','slot_reopened') THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: subtype must be new_availability or slot_reopened (got %)', p_subtype;
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: data must be a json object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
    IF v_key NOT IN ('trainer_name','date_from','date_to','slot_count','slot_date','slot_time','url') THEN
      RAISE EXCEPTION 'notif_digest_item_open_slots_v1: unknown field % (v1 schema is closed)', v_key;
    END IF;
  END LOOP;

  v_loc := CASE WHEN lower(coalesce(p_locale,'')) LIKE 'nl%' THEN 'nl' ELSE 'en' END;

  -- Type-asserted extraction: an array/object/number/boolean RAISEs here instead
  -- of being stringified into the frozen item.
  v_trainer := public.notif_digest_json_text(p_data, 'trainer_name');
  v_from    := public.notif_digest_json_text(p_data, 'date_from');
  v_to      := public.notif_digest_json_text(p_data, 'date_to');
  v_date    := public.notif_digest_json_text(p_data, 'slot_date');
  v_time    := public.notif_digest_json_text(p_data, 'slot_time');
  v_url     := public.notif_digest_json_text(p_data, 'url');

  IF v_trainer IS NULL THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: trainer_name is required';
  END IF;
  PERFORM public.notif_digest_item_reject_unsafe(v_trainer);

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

  -- Count phrase, correctly inflected. The no-count fallback is preserved.
  IF v_loc = 'nl' THEN
    v_phrase := CASE
      WHEN v_count IS NULL THEN 'Nieuwe momenten'
      WHEN v_count = 1     THEN '1 nieuw moment'
      ELSE v_count::text || ' nieuwe momenten'
    END;
  ELSE
    v_phrase := CASE
      WHEN v_count IS NULL THEN 'New slots'
      WHEN v_count = 1     THEN '1 new slot'
      ELSE v_count::text || ' new slots'
    END;
  END IF;

  IF v_loc = 'nl' THEN
    IF p_subtype = 'new_availability' THEN
      v_title := 'Nieuwe beschikbaarheid van ' || v_trainer;
      v_body  := CASE
        WHEN v_to IS NOT NULL AND v_to <> v_from
          THEN v_phrase || ' tussen ' || v_from || ' en ' || v_to || '.'
        ELSE v_phrase || ' op ' || v_from || '.'
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
          THEN v_phrase || ' between ' || v_from || ' and ' || v_to || '.'
        ELSE v_phrase || ' on ' || v_from || '.'
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
