-- 10c-b D correction — an INSTANT open-slots row must actually be renderable.
--
-- THE BUG THIS FIXES. Slice C's resolver renders content only on the DIGEST branch. An
-- `instant` cadence therefore produced a normal pending outbox row whose payload was just the
-- caller's structured `{subtype, data}` — no `subject`, no `html`. The instant email worker
-- reads `payload.subject` / `payload.html` and treats a row that cannot render as TERMINAL
-- (`missing_subject_or_html`), so every instant open-slots alert would have been reported as
-- enqueued and then silently terminal-failed, with the failed row's idempotency key blocking
-- any retry. This is not hypothetical: slice C's backfill carries a legacy `instant` choice
-- across verbatim, so real users are on that cadence.
--
-- THE FIX. Content stays SERVER-OWNED. The same trusted item builder that feeds the digest now
-- also produces the instant email body, so the two routes cannot drift and the edge function
-- still supplies nothing a recipient can read. The resolver merges `{subject, html}` into the
-- payload for a cutover event on an instant cadence.
--
-- SAFETY. `notif_digest_item_reject_unsafe` already refuses angle brackets, URLs, emails,
-- phone-like numbers and token shapes in every free-text field, so the item text cannot carry
-- markup. The escape below is defence in depth, not the primary control.

CREATE OR REPLACE FUNCTION public.notif_open_slots_escape_html(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT replace(replace(replace(replace(replace(
    coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

/**
 * Build the INSTANT email payload for an open-slots item.
 *
 * Takes the immutable item minted by notif_digest_item_for_event, so the instant mail and a
 * digest entry say exactly the same thing in the same locale. Returns `{subject, html}` — the
 * two fields the instant worker requires.
 */
CREATE OR REPLACE FUNCTION public.notif_open_slots_instant_payload(p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_title text := nullif(btrim(coalesce(p_item->>'title', '')), '');
  v_body  text := nullif(btrim(coalesce(p_item->>'body',  '')), '');
BEGIN
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'notif_open_slots_instant_payload: item has no title';
  END IF;
  RETURN jsonb_build_object(
    'subject', v_title,
    'html',
      '<p>' || public.notif_open_slots_escape_html(v_title) || '</p>'
      || coalesce('<p>' || public.notif_open_slots_escape_html(v_body) || '</p>', '')
  );
END $$;

COMMENT ON FUNCTION public.notif_open_slots_instant_payload(jsonb) IS
  'Server-rendered {subject, html} for an INSTANT open-slots email, built from the same trusted immutable item the digest uses so the two routes cannot drift. The edge function never supplies recipient-visible copy.';

REVOKE ALL ON FUNCTION public.notif_open_slots_escape_html(text)        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_open_slots_instant_payload(jsonb)   FROM PUBLIC, anon, authenticated, service_role;
