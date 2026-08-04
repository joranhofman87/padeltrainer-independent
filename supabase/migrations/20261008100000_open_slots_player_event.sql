-- 10c-b B — the canonical v2 event for open slots: `open_slots_player`.
--
-- NAME. `open_slots_player` follows the catalog's `<subject>_<audience>` convention
-- (booking_confirmed_player, rebook_invite_player, …). No accepted contract requires
-- another spelling: the legacy world has no v2 event here at all — it has the
-- notification_preferences COLUMN `open_slots_digest` (20260210090026) that
-- send-email maps new_availability|slot_reopened onto. That column is a v1
-- preference, not an event key, so there is no deviation to document.
--
-- CATEGORY. 'booking' — the notification is about bookable availability. Not
-- 'rebook' (that category is the priority-rebooking feature, a different product
-- surface) and not 'marketing' (which would place it under marketing-consent rules
-- it must not inherit: this is a followed-trainer alert the player opted into).
--
-- CONTRACT (as accepted): audience player · priority engagement · NOT required
-- delivery · email yes · digest yes · whatsapp no · push no · default email
-- frequency WEEKLY (mirrors the legacy open_slots_digest DEFAULT, which is weekly,
-- not daily) · quiet hours respected · private_user_only visibility.
--
-- STILL INERT. digest_engine_enabled stays FALSE. The catalog CHECK
-- chk_event_types_digest_engine_implies_supports permits supports_digest without
-- the engine flag, which is exactly this state: rows may be classified for digest,
-- but no digest engine consumes them until a separately-approved 10c-b enablement.

INSERT INTO public.notification_event_types
  (key, category, audience, priority, required_delivery,
   supports_email, supports_whatsapp, supports_push, supports_digest,
   default_email_frequency, default_whatsapp_frequency, default_push_frequency,
   collapse_window_minutes, quiet_hours_respect, visibility_scope,
   template_email, digest_engine_enabled)
VALUES
  ('open_slots_player', 'booking', 'player', 'engagement', false,
   true, false, false, true,
   'weekly', 'off', 'off',
   0, true, 'private_user_only',
   'open_slots_player', false)
ON CONFLICT (key) DO UPDATE SET
  category                 = EXCLUDED.category,
  audience                 = EXCLUDED.audience,
  priority                 = EXCLUDED.priority,
  required_delivery        = EXCLUDED.required_delivery,
  supports_email           = EXCLUDED.supports_email,
  supports_whatsapp        = EXCLUDED.supports_whatsapp,
  supports_push            = EXCLUDED.supports_push,
  supports_digest          = EXCLUDED.supports_digest,
  default_email_frequency  = EXCLUDED.default_email_frequency,
  default_whatsapp_frequency = EXCLUDED.default_whatsapp_frequency,
  default_push_frequency   = EXCLUDED.default_push_frequency,
  collapse_window_minutes  = EXCLUDED.collapse_window_minutes,
  quiet_hours_respect      = EXCLUDED.quiet_hours_respect,
  visibility_scope         = EXCLUDED.visibility_scope,
  template_email           = EXCLUDED.template_email,
  -- NEVER carry an enablement forward through a re-run of this migration.
  digest_engine_enabled    = false,
  updated_at               = now();

-- ---------------------------------------------------------------------------
-- The IMMUTABLE v1 digest-item schema for this event.
--
-- Shape (frozen; a change needs `v: 2`, never an edit of v1):
--   {
--     "v": 1,
--     "event": "open_slots_player",
--     "subtype": "new_availability" | "slot_reopened",
--     "locale": "nl" | "en",
--     "title": <rendered, locale-deterministic>,
--     "body":  <rendered, locale-deterministic>,
--     "url":   <safe app path, or absent>,
--     "data":  { trainer_name, date_from?, date_to?, slot_count?, slot_date?, slot_time? }
--   }
--
-- WHY title/body are rendered HERE, server-side, at enqueue time:
--   * _shared/digest-render.ts renders a group defensively from `{title, body?, url?}`
--     and deliberately knows nothing about any specific event. Projecting the item
--     into that contract in SQL keeps the renderer event-agnostic AND makes the copy
--     part of the frozen, hashed snapshot — so it cannot drift between enqueue and a
--     retry inside the 23-hour idempotency window.
--   * determinism: same inputs → byte-identical output, which the request hash needs.
--
-- SAFETY: the function is the only way to mint the item and it REJECTS anything that
-- could leak or inject — an email address, a phone number, a token/secret-looking
-- string, or a URL that is not an app-relative path. It never accepts free-form HTML;
-- the renderer escapes everything anyway, so this is defence in depth.

CREATE OR REPLACE FUNCTION public.notif_digest_item_reject_unsafe(p_text text)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_text IS NULL OR p_text = '' THEN RETURN; END IF;
  -- an email address anywhere in the value
  IF p_text ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' THEN
    RAISE EXCEPTION 'digest item: value contains an email address';
  END IF;
  -- a phone-like number: at least 9 DIGITS in one punctuated run. Counting digits
  -- (rather than run length) is what keeps a legitimate date such as 2026-08-10
  -- — 8 digits — from being mistaken for a phone number. Structured date/time
  -- fields never reach this function anyway: they are ISO-validated instead.
  IF (SELECT count(*) FROM regexp_matches(p_text, '[0-9]', 'g')) >= 9
     AND p_text ~ '(\+|00)?[0-9][0-9 ()./-]{7,}[0-9]' THEN
    RAISE EXCEPTION 'digest item: value contains a phone-like number';
  END IF;
  -- bearer/JWT/api-key shaped material
  IF p_text ~* '(bearer[[:space:]]|eyJ[[:alnum:]_-]{10,}|sb_[[:alnum:]_-]{10,}|sk-[[:alnum:]_-]{10,}|re_[[:alnum:]_-]{10,})' THEN
    RAISE EXCEPTION 'digest item: value looks like a token or secret';
  END IF;
  -- any absolute/protocol-relative URL or dangerous scheme (safe links go through
  -- the url field only, which is separately restricted to app-relative paths)
  IF p_text ~* '([[:alpha:]][[:alnum:]+.-]*:)?//' OR p_text ~* '(javascript|data|vbscript):' THEN
    RAISE EXCEPTION 'digest item: value contains a URL or scheme';
  END IF;
  IF p_text ~ '[<>]' THEN
    RAISE EXCEPTION 'digest item: value contains angle brackets';
  END IF;
  -- NOTE: no NUL check — PostgreSQL text cannot hold U+0000 at all, so a NUL can
  -- never arrive here. The renderer still strips lone surrogates on the way out.
END $$;

COMMENT ON FUNCTION public.notif_digest_item_reject_unsafe(text) IS
  'Fail-closed content guard for digest item text: rejects emails, phone-like numbers, token/secret shapes, URLs/schemes, angle brackets and NUL.';

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
  v_from    text;
  v_to      text;
  v_count   int;
  v_date    text;
  v_time    text;
  v_url     text;
  v_title   text;
  v_body    text;
  v_item    jsonb;
BEGIN
  IF p_subtype IS NULL OR p_subtype NOT IN ('new_availability','slot_reopened') THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: subtype must be new_availability or slot_reopened (got %)', p_subtype;
  END IF;
  -- Locale is BINARY here on purpose: the product ships nl + en copy, and an unknown
  -- locale must fall back deterministically rather than emit a third, untranslated shape.
  v_loc := CASE WHEN lower(coalesce(p_locale,'')) LIKE 'nl%' THEN 'nl' ELSE 'en' END;

  v_trainer := nullif(btrim(coalesce(p_data->>'trainer_name','')), '');
  v_from    := nullif(btrim(coalesce(p_data->>'date_from','')), '');
  v_to      := nullif(btrim(coalesce(p_data->>'date_to','')), '');
  v_date    := nullif(btrim(coalesce(p_data->>'slot_date','')), '');
  v_time    := nullif(btrim(coalesce(p_data->>'slot_time','')), '');
  v_url     := nullif(btrim(coalesce(p_data->>'url','')), '');
  BEGIN
    v_count := nullif(p_data->>'slot_count','')::int;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_count must be an integer';
  END;
  IF v_count IS NOT NULL AND (v_count < 0 OR v_count > 10000) THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: slot_count out of range';
  END IF;
  IF v_trainer IS NULL THEN
    RAISE EXCEPTION 'notif_digest_item_open_slots_v1: trainer_name is required';
  END IF;

  -- content safety on every free-text input we will render
  PERFORM public.notif_digest_item_reject_unsafe(v_trainer);
  PERFORM public.notif_digest_item_reject_unsafe(v_from);
  PERFORM public.notif_digest_item_reject_unsafe(v_to);
  PERFORM public.notif_digest_item_reject_unsafe(v_date);
  PERFORM public.notif_digest_item_reject_unsafe(v_time);

  -- URLs: app-relative paths only. An absolute URL (any scheme, any host, or a
  -- protocol-relative //host) is refused outright rather than sanitized.
  IF v_url IS NOT NULL THEN
    IF v_url !~ '^/[[:alnum:]_~./-]*$' OR v_url LIKE '//%' OR v_url LIKE '%..%' THEN
      RAISE EXCEPTION 'digest item: url must be a safe app-relative path';
    END IF;
  END IF;

  -- Deterministic copy. Bounded truncation keeps one item from dominating the
  -- 90 KB request budget; it is applied identically in both locales.
  v_trainer := left(v_trainer, 80);

  IF v_loc = 'nl' THEN
    IF p_subtype = 'new_availability' THEN
      v_title := 'Nieuwe beschikbaarheid van ' || v_trainer;
      v_body  := CASE
        WHEN v_from IS NOT NULL AND v_to IS NOT NULL AND v_from <> v_to
          THEN coalesce(v_count::text || ' nieuwe momenten', 'Nieuwe momenten') || ' tussen ' || v_from || ' en ' || v_to || '.'
        WHEN v_from IS NOT NULL
          THEN coalesce(v_count::text || ' nieuwe momenten', 'Nieuwe momenten') || ' op ' || v_from || '.'
        ELSE 'Er zijn nieuwe momenten beschikbaar.'
      END;
    ELSE
      v_title := 'Plek vrijgekomen bij ' || v_trainer;
      v_body  := CASE
        WHEN v_date IS NOT NULL AND v_time IS NOT NULL THEN 'Er is een plek vrijgekomen op ' || v_date || ' om ' || v_time || '.'
        WHEN v_date IS NOT NULL                        THEN 'Er is een plek vrijgekomen op ' || v_date || '.'
        ELSE 'Er is een plek vrijgekomen.'
      END;
    END IF;
  ELSE
    IF p_subtype = 'new_availability' THEN
      v_title := 'New availability from ' || v_trainer;
      v_body  := CASE
        WHEN v_from IS NOT NULL AND v_to IS NOT NULL AND v_from <> v_to
          THEN coalesce(v_count::text || ' new slots', 'New slots') || ' between ' || v_from || ' and ' || v_to || '.'
        WHEN v_from IS NOT NULL
          THEN coalesce(v_count::text || ' new slots', 'New slots') || ' on ' || v_from || '.'
        ELSE 'New slots are available.'
      END;
    ELSE
      v_title := 'A spot opened up with ' || v_trainer;
      v_body  := CASE
        WHEN v_date IS NOT NULL AND v_time IS NOT NULL THEN 'A spot opened up on ' || v_date || ' at ' || v_time || '.'
        WHEN v_date IS NOT NULL                        THEN 'A spot opened up on ' || v_date || '.'
        ELSE 'A spot opened up.'
      END;
    END IF;
  END IF;

  -- Key order is fixed by jsonb's own canonical ordering, so the same inputs always
  -- serialize to identical bytes — required by the frozen-request hash.
  v_item := jsonb_strip_nulls(jsonb_build_object(
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

  RETURN v_item;
END $$;

COMMENT ON FUNCTION public.notif_digest_item_open_slots_v1(text,text,jsonb) IS
  'Mint the IMMUTABLE v1 open_slots digest item: validates + renders deterministic nl/en title+body, refuses unsafe content and non-relative URLs. Schema changes require v:2, never an edit of v1.';

REVOKE ALL ON FUNCTION public.notif_digest_item_reject_unsafe(text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notif_digest_item_open_slots_v1(text,text,jsonb)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_digest_item_reject_unsafe(text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.notif_digest_item_open_slots_v1(text,text,jsonb)   TO service_role;
