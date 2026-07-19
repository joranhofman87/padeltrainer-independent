-- Notification Foundation v2 — PR 5: the FIRST real notification on the new spine.
-- See docs/NOTIFICATION_ARCHITECTURE.md §6 item 5. Deliberately a LOW-RISK path
-- (a trainer's "review received" engagement email — NOT the money flow, which is PR 6),
-- to prove enqueue → outbox → worker → Resend → delivery_event end-to-end in prod.
--
-- The legacy review email was client-side and effectively DORMANT (the trainer email
-- was never passed to it), so we move it server-side: an AFTER INSERT trigger on
-- reviews calls the resolver. The trigger is SECURITY DEFINER because enqueue_notification
-- is service-role-only (a client mutation can't call it). Delivery uses the resolver's
-- account-holder fallback — a trainer always has a persons.email — so NO contact backfill
-- is needed for this pilot. The event review_received_trainer is tenant_visible, so we
-- pass tenant context (p_tenant_trainer_id) + a sanitized public_summary.
CREATE OR REPLACE FUNCTION public.notify_review_received()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_html    text;
BEGIN
  -- recipient = the reviewed trainer (trainer_profiles.user_id is NOT NULL → always a login)
  SELECT user_id INTO v_user_id FROM public.trainer_profiles WHERE id = NEW.trainer_id;
  IF v_user_id IS NULL THEN
    RETURN NEW;  -- no resolvable recipient → nothing to enqueue
  END IF;

  -- Minimal, injection-safe email (mirrors the legacy send-email template's spirit):
  -- rating only, NO user-controlled free text (reviewer name / comment). The trainer
  -- sees the full review in-app; richer (escaped) content is a later enhancement.
  v_html :=
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">'
    || '<h1 style="color: #f59e0b;">New Review! &#11088;</h1>'
    || '<p>You have received a new ' || NEW.rating::text || '-star review!</p>'
    || '<div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">'
    || '<p><strong>Rating:</strong> ' || repeat('&#11088;', NEW.rating) || '</p>'
    || '</div>'
    || '<p>Keep up the great work! View the full review in your dashboard.</p>'
    || '<p>Best regards,<br>PadelTrainer.ai Team</p>'
    || '</div>';

  -- Enqueue via the resolver. Never let a notification failure break the review insert.
  BEGIN
    PERFORM public.enqueue_notification(
      p_event_key           => 'review_received_trainer',
      p_recipient_user_id   => v_user_id,
      p_tenant_trainer_id   => NEW.trainer_id,             -- required: event is tenant_visible
      p_idempotency_subject => NEW.id::text,               -- one notification per review
      p_related_booking_ids => ARRAY[NEW.booking_id],
      p_payload             => jsonb_build_object('subject', 'New Review Received! &#11088;', 'html', v_html),
      p_public_summary      => jsonb_build_object('event_type', 'review_received_trainer', 'rating', NEW.rating)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_review_received: enqueue failed for review %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.notify_review_received() IS
  'Notification v2 pilot (PR 5): AFTER INSERT on reviews → enqueue_notification(review_received_trainer) to the reviewed trainer. SECURITY DEFINER (resolver is service-role-only); enqueue failures warn, never break the review insert.';

DROP TRIGGER IF EXISTS trg_notify_review_received ON public.reviews;
CREATE TRIGGER trg_notify_review_received
  AFTER INSERT ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_review_received();
