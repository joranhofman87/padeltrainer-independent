-- Email delivery tracking — the single writer + the suppression check.
--
-- record_email_event() is called by BOTH the resend-webhook edge fn (async events)
-- and send-invoice-email (synchronous sent/send_failed), so the event log and the
-- per-address state transitions behave identically and are PGlite-testable. It is
-- idempotent: a webhook retry sharing resend_event_id is a no-op.
--
-- State machine (email_address_state.state), severity complained > hard > soft > ok:
--   complained        -> always set 'complained' (spam report; sticky — see below)
--   bounced(hard)     -> 'hard_bounced'  unless already 'complained'
--   bounced(soft)     -> 'soft_bounced'  unless already 'complained'/'hard_bounced'
--   delivered         -> 'ok'            unless 'complained' (real inbox delivery clears a bounce)
--   sent              -> 'ok'            only to INITIALIZE a brand-new address (never downgrades a bad state)
--   delivery_delayed/failed/send_failed -> state unchanged (logged for invoice-level visibility only)
-- A corrected address is a different string => a fresh 'ok' row, so flags clear for
-- everyone without an explicit reset. Complaints never auto-clear.

CREATE OR REPLACE FUNCTION public.record_email_event(
  p_event_type        text,
  p_recipient_email   text,
  p_resend_email_id   text        DEFAULT NULL,
  p_resend_event_id   text        DEFAULT NULL,
  p_bounce_type       text        DEFAULT NULL,
  p_reason            text        DEFAULT NULL,
  p_invoice_id        uuid        DEFAULT NULL,
  p_academy_profile_id uuid       DEFAULT NULL,
  p_trainer_id        uuid        DEFAULT NULL,
  p_occurred_at       timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_email   text := lower(btrim(p_recipient_email));
  v_at      timestamptz := coalesce(p_occurred_at, now());
  v_rows    integer;
  v_current text;
  v_target  text;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN;
  END IF;

  -- ---- append the event (idempotent when it carries a webhook id) ----
  INSERT INTO public.email_delivery_events
    (resend_event_id, resend_email_id, event_type, bounce_type, reason,
     recipient_email, invoice_id, academy_profile_id, trainer_id, occurred_at)
  VALUES
    (p_resend_event_id, p_resend_email_id, p_event_type, p_bounce_type, p_reason,
     v_email, p_invoice_id, p_academy_profile_id, p_trainer_id, v_at)
  ON CONFLICT (resend_event_id) WHERE resend_event_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN;  -- duplicate webhook delivery — already processed
  END IF;

  -- ---- roll the event into the per-address state ----
  SELECT state INTO v_current FROM public.email_address_state WHERE email = v_email;
  v_target := v_current;  -- default: unchanged

  IF p_event_type = 'complained' THEN
    v_target := 'complained';
  ELSIF p_event_type = 'bounced' THEN
    IF coalesce(p_bounce_type, 'hard') = 'hard' THEN
      IF coalesce(v_current, 'ok') <> 'complained' THEN v_target := 'hard_bounced'; END IF;
    ELSE
      IF coalesce(v_current, 'ok') NOT IN ('complained', 'hard_bounced') THEN v_target := 'soft_bounced'; END IF;
    END IF;
  ELSIF p_event_type = 'delivered' THEN
    IF coalesce(v_current, 'ok') <> 'complained' THEN v_target := 'ok'; END IF;
  ELSIF p_event_type = 'sent' THEN
    IF v_current IS NULL THEN v_target := 'ok'; END IF;  -- initialize only
  END IF;
  -- delivery_delayed / failed / send_failed: leave v_target = v_current

  IF v_current IS NULL OR v_current IS DISTINCT FROM v_target THEN
    INSERT INTO public.email_address_state (email, state, last_event_type, last_event_at, reason, updated_at)
    VALUES (v_email, coalesce(v_target, 'ok'), p_event_type, v_at, p_reason, now())
    ON CONFLICT (email) DO UPDATE
      SET state           = EXCLUDED.state,
          last_event_type = EXCLUDED.last_event_type,
          last_event_at   = EXCLUDED.last_event_at,
          reason          = EXCLUDED.reason,
          updated_at      = now();
  ELSE
    -- state unchanged; still record that we saw an event
    UPDATE public.email_address_state
      SET last_event_type = p_event_type, last_event_at = v_at, updated_at = now()
      WHERE email = v_email;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz) IS
  'Email delivery tracking: idempotent (on resend_event_id) event writer + address-state transition. Called by resend-webhook and send-invoice-email. service_role only.';
REVOKE ALL ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz)
  TO service_role;

-- Suppression check used by send-invoice-email before sending (block hard bounces /
-- complaints unless explicitly overridden). Soft bounces are NOT suppressed.
CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_address_state
    WHERE email = lower(btrim(p_email))
      AND state IN ('hard_bounced', 'complained')
  );
$$;

COMMENT ON FUNCTION public.is_email_suppressed(text) IS
  'Email delivery tracking: TRUE if the address is hard-bounced or complained (block sending unless overridden). service_role only.';
REVOKE ALL ON FUNCTION public.is_email_suppressed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_email_suppressed(text) TO service_role;
