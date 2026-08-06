-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- FINAL INTEGRATION AUDIT (P1) — the unsubscribe must bite at SEND time, not only at enqueue.
--
-- 20261101100000 taught the resolver to honour the marketing unsubscribe. The independent
-- whole-foundation review found the half that leaves: enqueue and delivery are separated in time,
-- so a marketing row queued while the recipient was subscribed would still be sent after they
-- unsubscribed. Both delivery paths re-evaluate live authorization immediately before the provider
-- call through notif_digest_member_stop_reason — the instant worker delegates to it explicitly
-- (_shared/instant-send-gate.ts) and the digest state machine calls it at prepare AND at begin —
-- and that function checked deliverability suppression, contact, preference and cap, but never
-- the marketing one.
--
-- The sequence that would have broken the promise:
--   1. a marketing notification is enqueued while the recipient is subscribed;
--   2. the recipient uses the one-click unsubscribe the footer offered them;
--   3. the queued row reaches dispatch;
--   4. the live gate saw nothing wrong;
--   5. the mail went out anyway.
--
-- Recreated whole from 20261015120000 (its newest definition); only the marketing arm is new.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.notif_digest_member_stop_reason(p_member_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; v_required boolean; v_dest text; v_event_stop text;
BEGIN
  SELECT o2.destination_fingerprint, o2.recipient_person_id, o2.recipient_user_id, o2.recipient_guest_player_id,
         o2.tenant_academy_profile_id, o2.tenant_trainer_id, o2.event_type
    INTO o FROM public.notification_outbox o2 WHERE o2.id = p_member_id;
  IF NOT FOUND THEN RETURN 'missing_member'; END IF;
  SELECT coalesce(et.required_delivery, false) INTO v_required
    FROM public.notification_event_types et WHERE et.key = o.event_type;
  v_required := coalesce(v_required, false);

  -- RE-RUN the resolver's LIVE email lookup verbatim (never trust outbox.contact_id — its FK is ON DELETE
  -- SET NULL, so a deleted contact leaves NULL and any frozen fallback would fail OPEN): ownership
  -- (person/user/guest), revocation, opt-out, tenant consent scope, and global-only-for-account-holders.
  SELECT c.destination_normalized INTO v_dest
    FROM public.notification_contacts c
   WHERE c.channel = 'email' AND c.revoked_at IS NULL AND c.consent_status <> 'opted_out'
     AND (c.consent_scope <> 'global' OR o.recipient_user_id IS NOT NULL)
     AND public.is_notification_consent_in_scope(
           c.consent_scope, c.consent_academy_profile_id, c.consent_trainer_id,
           o.tenant_academy_profile_id, o.tenant_trainer_id)
     AND ( (o.recipient_person_id IS NOT NULL AND c.person_id = o.recipient_person_id)
        OR (o.recipient_user_id   IS NOT NULL AND c.user_id   = o.recipient_user_id)
        OR (o.recipient_guest_player_id IS NOT NULL AND c.guest_player_id = o.recipient_guest_player_id) )
   ORDER BY c.is_primary DESC, c.verified_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    IF o.recipient_user_id IS NOT NULL THEN
      -- global fallback ONLY for account holders (their own login email) — resolver semantics.
      SELECT p.email INTO v_dest FROM public.persons p WHERE p.user_id = o.recipient_user_id;
      IF v_dest IS NULL OR length(btrim(v_dest)) = 0 THEN RETURN 'no_destination'; END IF;
    ELSE
      RETURN 'contact_revoked';   -- guest/person-only: no live in-scope owned contact → STOP. Frozen data
    END IF;                       -- is NEVER a live-deliverability substitute.
  END IF;
  IF v_dest IS NULL OR length(btrim(v_dest)) = 0 THEN RETURN 'no_destination'; END IF;

  -- the LIVE destination must still fingerprint to the member's frozen destination_fingerprint —
  -- a changed contact/account email means this frozen digest would go to the WRONG (old) address.
  IF o.destination_fingerprint IS NOT NULL
     AND notif_digest_destination_fingerprint(v_dest) <> o.destination_fingerprint THEN
    RETURN 'destination_changed';
  END IF;
  IF public.is_email_suppressed(v_dest) THEN RETURN 'suppressed'; END IF;   -- required never bypasses this

  -- FINAL AUDIT (send-time half): the MARKETING unsubscribe, re-evaluated HERE and not only at
  -- enqueue. Enqueue and delivery are separated in time — a digest member waits for its boundary,
  -- an instant row waits for its worker — and the whole point of a one-click unsubscribe is that
  -- it takes effect NOW. Checking it only at enqueue would honour the promise for mail not yet
  -- queued and break it for mail already queued, which is the case a recipient is most likely to
  -- notice. Scope-aware, exactly as the resolver's arm: platform silences everything, a tenant
  -- suppression silences that tenant's sends. Required-delivery does NOT bypass it, for the same
  -- reason the event hook does not: an unsubscribe is a consent signal, not a cadence — and no
  -- required event carries a marketing footer.
  IF EXISTS (SELECT 1 FROM public.notification_event_types et
              WHERE et.key = o.event_type AND et.email_footer_policy = 'marketing_unsubscribe')
     AND (
       public.is_marketing_suppressed(v_dest, 'platform', NULL)
       OR (o.tenant_academy_profile_id IS NOT NULL
           AND public.is_marketing_suppressed(v_dest, 'academy', o.tenant_academy_profile_id))
       OR (o.tenant_trainer_id IS NOT NULL
           AND public.is_marketing_suppressed(v_dest, 'trainer', o.tenant_trainer_id))
     ) THEN
    RETURN 'marketing_unsubscribed';
  END IF;

  IF NOT v_required AND o.recipient_user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.notification_preferences_v2 p
        WHERE p.user_id = o.recipient_user_id AND p.event_type = o.event_type AND p.email_frequency = 'off') THEN
    RETURN 'preference_off';                                 -- ONLY this is required_delivery-exempt
  END IF;

  -- N3 (contract finding 3): the ACADEMY CAP, live at prepare AND begin — a manager's 'off'
  -- landing after materialization stops the member before its digest freezes. Optional events
  -- only (required is untouchable), academy-attributed members only. Reported AFTER
  -- preference_off so the player's own signal stays the cause when both apply.
  IF NOT v_required AND o.tenant_academy_profile_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.academy_notification_restrictions r
        WHERE r.academy_profile_id = o.tenant_academy_profile_id
          AND r.event_type = o.event_type AND r.channel = 'email'
          AND r.max_frequency = 'off') THEN
    RETURN 'tenant_restricted';
  END IF;

  -- 10c-b: the per-event policy hook, evaluated LAST so the generic deliverability
  -- reasons stay the reported cause when both apply. Required-delivery does NOT bypass
  -- it: an event-specific opt-out (unfollow/mute) is a consent signal, not a cadence.
  v_event_stop := public.notif_digest_event_stop_reason(p_member_id);
  IF v_event_stop IS NOT NULL THEN RETURN v_event_stop; END IF;

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.notif_digest_member_stop_reason(uuid) IS
  'The LIVE send policy, re-evaluated immediately before provider work by both delivery paths (the instant worker delegates to it; the digest state machine calls it at prepare and at begin). Stops: missing_member, contact_revoked, no_destination, destination_changed, suppressed (bounce/complaint), marketing_unsubscribed (the one-click unsubscribe, scope-aware — enqueue-time is not enough because enqueue and delivery are separated in time), preference_off, tenant_restricted, then the per-event policy hook.';
