-- Notification Foundation v2 — PR 7: the tenant-visible notification TIMELINES (read only).
-- See docs/NOTIFICATION_ARCHITECTURE.md §6.7. The schema, RLS and cross-tenant denial posture
-- landed in PR 2; this adds ONLY the read RPCs on top.
--
-- notification_outbox + email_delivery_events are service-role-only (no authenticated policy),
-- so these MUST be SECURITY DEFINER — which makes the auth-binding the whole security story:
--   1. every RPC first AUTHORIZES THE SUBJECT (may the caller see this booking / invoice /
--      player at all?) using the SAME gates the existing app already uses, else RAISE 42501;
--   2. every returned row is then filtered by ONE shared visibility predicate
--      (notification_row_visible_to_caller) so the rule cannot drift between the three RPCs.
--
-- PROJECTION IS THE OTHER HALF: the RETURNS TABLE below is deliberately narrow —
-- outbox_id / delivery_event_id / event_type / channel / status / skip_reason /
-- destination_redacted / public_summary / timestamps. It NEVER exposes
-- destination_normalized (raw address), payload, contact_id, recipient_person_id,
-- recipient_user_id, recipient_guest_player_id or idempotency_key: a stable per-person /
-- per-contact id would let one tenant correlate the same human across academies (the I-22
-- ref-leak doctrine), and the raw destination is service-role-only by design.

-- ---------------------------------------------------------------------------
-- 1. The ONE visibility rule, shared by all three timelines.
--
-- Takes only the row's non-sensitive scope fields (never a destination/payload) and answers
-- "may the CALLER see a row like this?". Auth-bound to auth.uid() throughout, so it reports
-- on the caller's OWN access only — it is not an oracle over other people's data.
--   * admin              → everything;
--   * admin_only rows    → nobody else, ever;
--   * the RECIPIENT      → their own history, whatever its scope (this is the player's
--                          private_user_only confirmation trail);
--   * tenant staff       → ONLY rows explicitly marked tenant-visible AND carrying THEIR
--                          academy / trainer as the tenant ref (never cross-tenant).
CREATE OR REPLACE FUNCTION public.notification_row_visible_to_caller(
  p_visibility_scope          text,
  p_tenant_academy_profile_id uuid,
  p_tenant_trainer_id         uuid,
  p_recipient_person_id       uuid,
  p_recipient_user_id         uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE
    WHEN public.is_admin(auth.uid()) THEN true
    WHEN p_visibility_scope = 'admin_only' THEN false
    -- the recipient's OWN PRIVATE history. Deliberately gated on private_user_only: a
    -- tenant_visible row must ALWAYS clear the tenant-scope check below, even when it is
    -- addressed to the caller. Otherwise a malformed / mis-routed row carrying a FOREIGN
    -- tenant ref would surface purely because the caller's id sits in a recipient column
    -- (tenant-visible rows belong to their TENANT, not to whoever happens to receive them).
    -- Staff still see their own staff mail — those rows carry their own academy/trainer and
    -- pass the tenant arm below.
    WHEN p_visibility_scope = 'private_user_only'
      AND ((p_recipient_user_id IS NOT NULL AND p_recipient_user_id = auth.uid())
        OR (p_recipient_person_id IS NOT NULL AND p_recipient_person_id = public.get_my_person_id()))
      THEN true
    -- tenant staff: tenant-visible rows, and only inside their own tenant scope
    WHEN p_visibility_scope IN ('tenant_visible', 'tenant_visible_limited')
      AND (
        (p_tenant_academy_profile_id IS NOT NULL
          AND public.is_academy_manager(auth.uid(), p_tenant_academy_profile_id))
        OR (p_tenant_trainer_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.trainer_profiles tp
                      WHERE tp.id = p_tenant_trainer_id AND tp.user_id = auth.uid()))
      )
      THEN true
    ELSE false
  END;
$$;
COMMENT ON FUNCTION public.notification_row_visible_to_caller(text, uuid, uuid, uuid, uuid) IS
  'Notification v2 (PR 7): the single visibility rule shared by every notification timeline RPC — admin sees all, admin_only is never tenant-visible, the recipient sees their own history, and tenant staff see ONLY tenant_visible rows carrying their own academy/trainer. Auth-bound to auth.uid().';
REVOKE ALL ON FUNCTION public.notification_row_visible_to_caller(text, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notification_row_visible_to_caller(text, uuid, uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. get_booking_notification_timeline — everything sent ABOUT one booking.
--
-- Subject gate mirrors the live bookings SELECT policies: the booking's own player, a
-- trainer/academy manager who can manage its slot (can_manage_slot covers admin + slot
-- trainer + academy manager + club manager), or a trainer whose own guest holds the seat.
CREATE OR REPLACE FUNCTION public.get_booking_notification_timeline(
  p_booking_id uuid,
  p_limit      int DEFAULT 50
) RETURNS TABLE (
  outbox_id            uuid,
  delivery_event_id    uuid,
  event_type           text,
  channel              text,
  status               text,
  skip_reason          text,
  destination_redacted text,
  public_summary       jsonb,
  created_at           timestamptz,
  scheduled_for        timestamptz,
  sent_at              timestamptz,
  failed_at            timestamptz,
  occurred_at          timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_slot_id uuid;
  v_player  uuid;
  v_guest   uuid;
BEGIN
  SELECT b.slot_id, b.player_id, b.guest_player_id INTO v_slot_id, v_player, v_guest
  FROM public.bookings b WHERE b.id = p_booking_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- FAIL CLOSED: `IS NOT TRUE`, never `NOT (...)`. A NULL anywhere in the predicate (e.g.
  -- get_profile_id_for_user() is NULL for a staff account, making `v_player = NULL` NULL)
  -- would make `NOT (...)` NULL, the IF not fire, and the RAISE be SKIPPED — silently
  -- GRANTING a foreign tenant access. `IS NOT TRUE` denies on both false and NULL.
  IF (
    public.can_manage_slot(auth.uid(), v_slot_id)
    OR (v_guest IS NULL AND v_player IS NOT NULL AND v_player = public.get_profile_id_for_user(auth.uid()))
    OR (v_guest IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.guest_players gp
          JOIN public.trainer_profiles tp ON gp.trainer_id = tp.id
          WHERE gp.id = v_guest AND tp.user_id = auth.uid()))
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized for booking %', p_booking_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT o.id, de.id, o.event_type, o.channel, o.status, o.skip_reason,
         o.destination_redacted, o.public_summary,
         o.created_at, o.scheduled_for, o.sent_at, o.failed_at, de.occurred_at
  FROM public.notification_outbox o
  LEFT JOIN LATERAL (
    SELECT e.id, e.occurred_at FROM public.email_delivery_events e
    WHERE e.outbox_id = o.id ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1
  ) de ON true
  WHERE o.related_booking_ids @> ARRAY[p_booking_id]::uuid[]   -- GIN idx_notification_outbox_booking_ids
    AND public.notification_row_visible_to_caller(
          o.visibility_scope, o.tenant_academy_profile_id, o.tenant_trainer_id,
          o.recipient_person_id, o.recipient_user_id)
  ORDER BY o.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.get_booking_notification_timeline(uuid, int) IS
  'Notification v2 (PR 7): tenant-safe notification timeline for one booking. Subject-gated like the bookings SELECT policies; rows filtered by notification_row_visible_to_caller. Never returns a raw destination, contact_id, person/user/guest recipient ids or the idempotency key.';
REVOKE ALL ON FUNCTION public.get_booking_notification_timeline(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_booking_notification_timeline(uuid, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_invoice_notification_timeline — everything sent ABOUT one invoice.
--
-- Subject gate is the canonical invoice-staff predicate already used by
-- get_invoice_status_history / get_invoices_delivery_status (academy manager | owning
-- trainer | admin). This is a STAFF surface: a player's OWN invoice-related rows reach them
-- through get_player_notification_timeline (self mode), and the per-row visibility filter
-- below keeps a player's private_user_only confirmation OUT of the staff view even though
-- staff may read the invoice itself.
CREATE OR REPLACE FUNCTION public.get_invoice_notification_timeline(
  p_invoice_id uuid,
  p_limit      int DEFAULT 50
) RETURNS TABLE (
  outbox_id            uuid,
  delivery_event_id    uuid,
  event_type           text,
  channel              text,
  status               text,
  skip_reason          text,
  destination_redacted text,
  public_summary       jsonb,
  created_at           timestamptz,
  scheduled_for        timestamptz,
  sent_at              timestamptz,
  failed_at            timestamptz,
  occurred_at          timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_acad    uuid;
  v_trainer uuid;
BEGIN
  SELECT i.academy_profile_id, i.trainer_id INTO v_acad, v_trainer
  FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- FAIL CLOSED (see the booking gate): `IS NOT TRUE` denies on NULL as well as false.
  IF (
    (v_acad IS NOT NULL AND public.is_academy_manager(auth.uid(), v_acad))
    OR (v_trainer IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = v_trainer AND tp.user_id = auth.uid()))
    OR public.is_admin(auth.uid())
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized for invoice %', p_invoice_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT o.id, de.id, o.event_type, o.channel, o.status, o.skip_reason,
         o.destination_redacted, o.public_summary,
         o.created_at, o.scheduled_for, o.sent_at, o.failed_at, de.occurred_at
  FROM public.notification_outbox o
  LEFT JOIN LATERAL (
    SELECT e.id, e.occurred_at FROM public.email_delivery_events e
    WHERE e.outbox_id = o.id ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1
  ) de ON true
  WHERE o.related_invoice_id = p_invoice_id                    -- idx_notification_outbox_invoice
    AND public.notification_row_visible_to_caller(
          o.visibility_scope, o.tenant_academy_profile_id, o.tenant_trainer_id,
          o.recipient_person_id, o.recipient_user_id)
  ORDER BY o.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.get_invoice_notification_timeline(uuid, int) IS
  'Notification v2 (PR 7): tenant-safe notification timeline for one invoice. Subject-gated by the canonical invoice staff predicate (academy manager | owning trainer | admin); rows filtered by notification_row_visible_to_caller, so a player''s private confirmation stays hidden from staff. Never returns a raw destination, contact_id, recipient ids or the idempotency key.';
REVOKE ALL ON FUNCTION public.get_invoice_notification_timeline(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_notification_timeline(uuid, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_player_notification_timeline — one person's notification history.
--
-- TWO modes, because the two legitimate readers differ:
--   * SELF  (p_scope IS NULL): the signed-in player's own history — every row addressed to
--     them, including the private_user_only booking confirmations. No refs needed.
--   * TENANT (p_scope = 'academy' | 'trainer'): a manager/trainer looking at ONE player from
--     their own player list. Authorization + ref expansion is delegated wholesale to the
--     existing get_person_refs_for_scope (it enforces the scope pin, the IDOR guard and the
--     guest split-freeze, and is what the player DETAIL pages already call), and the per-row
--     filter then keeps only tenant_visible rows in the caller's scope. With today's taxonomy
--     every player-recipient event is private_user_only, so this mode is legitimately EMPTY
--     for staff — by design, not a bug (widening it is a visibility_scope policy decision).
CREATE OR REPLACE FUNCTION public.get_player_notification_timeline(
  p_scope      text DEFAULT NULL,
  p_scope_id   uuid DEFAULT NULL,
  p_guest_id   uuid DEFAULT NULL,
  p_profile_id uuid DEFAULT NULL,
  p_limit      int  DEFAULT 50
) RETURNS TABLE (
  outbox_id            uuid,
  delivery_event_id    uuid,
  event_type           text,
  channel              text,
  status               text,
  skip_reason          text,
  destination_redacted text,
  public_summary       jsonb,
  created_at           timestamptz,
  scheduled_for        timestamptz,
  sent_at              timestamptz,
  failed_at            timestamptz,
  occurred_at          timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_guest_ids  uuid[] := '{}';
  v_profile_id uuid;
  v_person_id  uuid;
  v_self       boolean := (p_scope IS NULL);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_self THEN
    v_person_id := public.get_my_person_id();
    -- a signed-in user with no person link still has user-keyed rows; both arms are matched below
  ELSE
    -- delegates the scope pin + IDOR guard + split-freeze to the existing person-scope reader
    SELECT r.guest_ids, r.profile_id INTO v_guest_ids, v_profile_id
    FROM public.get_person_refs_for_scope(p_scope, p_scope_id, p_guest_id, p_profile_id) r;
    v_guest_ids := coalesce(v_guest_ids, '{}');
    IF v_profile_id IS NOT NULL THEN
      SELECT pl.person_id INTO v_person_id FROM public.person_links pl WHERE pl.profile_id = v_profile_id;
    END IF;
    IF v_person_id IS NULL AND array_length(v_guest_ids, 1) IS NOT NULL THEN
      SELECT pl.person_id INTO v_person_id FROM public.person_links pl
      WHERE pl.guest_player_id = ANY(v_guest_ids) LIMIT 1;
    END IF;
  END IF;

  RETURN QUERY
  SELECT o.id, de.id, o.event_type, o.channel, o.status, o.skip_reason,
         o.destination_redacted, o.public_summary,
         o.created_at, o.scheduled_for, o.sent_at, o.failed_at, de.occurred_at
  FROM public.notification_outbox o
  LEFT JOIN LATERAL (
    SELECT e.id, e.occurred_at FROM public.email_delivery_events e
    WHERE e.outbox_id = o.id ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1
  ) de ON true
  WHERE (
      CASE WHEN v_self
        THEN o.recipient_user_id = auth.uid()
             OR (v_person_id IS NOT NULL AND o.recipient_person_id = v_person_id)
        ELSE (v_person_id IS NOT NULL AND o.recipient_person_id = v_person_id)
             OR (array_length(v_guest_ids, 1) IS NOT NULL AND o.recipient_guest_player_id = ANY(v_guest_ids))
      END
    )
    AND public.notification_row_visible_to_caller(
          o.visibility_scope, o.tenant_academy_profile_id, o.tenant_trainer_id,
          o.recipient_person_id, o.recipient_user_id)
  ORDER BY o.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.get_player_notification_timeline(text, uuid, uuid, uuid, int) IS
  'Notification v2 (PR 7): one person''s notification history. p_scope NULL = the signed-in player''s OWN history (incl. their private confirmations); p_scope academy/trainer = a staff view of one player, authorized + ref-expanded by get_person_refs_for_scope and then filtered to tenant_visible rows in the caller''s scope (legitimately empty while all player events are private_user_only). Never returns a raw destination, contact_id, recipient ids or the idempotency key.';
REVOKE ALL ON FUNCTION public.get_player_notification_timeline(text, uuid, uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_notification_timeline(text, uuid, uuid, uuid, int) TO authenticated;
