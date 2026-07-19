-- Notification Foundation v2 — PR 6a: the paid-booking PLAYER confirmation → outbox.
-- See docs/NOTIFICATION_ARCHITECTURE.md §6 (PR sequence). This migration ships the
-- guest-delivery infrastructure the cutover needs; the edge wiring (compose → enqueue,
-- drop the direct Resend send) rides in the same PR.
--
-- WHY a guest needs infrastructure at all: the resolver (PR 3) delivers a registered
-- player's email via the persons.email ACCOUNT fallback (keyed on user_id). A GUEST has
-- no account, so the resolver only finds them a destination through a notification_contacts
-- row — and nothing populated one yet. This adds a locked-down, service-role-only helper
-- that upserts a TENANT-SCOPED email contact for a guest at the paid-booking enqueue site,
-- so guest confirmations become deliverable through the same outbox as everyone else (no
-- guest persons.email fallback — that would cross-tenant-leak a shared account address).

-- ---------------------------------------------------------------------------
-- 1. Contacts dedup index rework — make GUEST contacts per-guest, not per-email.
--
-- The PR-2 unique index idx_notification_contacts_dest was
--   (channel, destination_normalized, coalesce(person_id, <zero-uuid>))
-- i.e. it deduped by EMAIL, collapsing person_id IS NULL rows to one row per address.
-- That is wrong for tenant-scoped guests: two DIFFERENT guests who share an email (a
-- family; a person who is a guest in two academies) would collide on the same address and
-- only ONE could ever hold a contact — the other's paid confirmation would silently have
-- no destination. Split the guarantee by identity instead of by address:
--   * person-keyed contacts (registered): one email per person per channel,
--   * guest-only contacts: one row per guest_player per channel (guest_player_id is itself
--     per-academy, so this is naturally per-tenant and gives cross-academy isolation).
-- Prod has 0 contacts and no writer exists yet, so the drop/recreate is data-safe.
DROP INDEX IF EXISTS public.idx_notification_contacts_dest;

CREATE UNIQUE INDEX idx_notification_contacts_person_dest
  ON public.notification_contacts (channel, destination_normalized, person_id)
  WHERE person_id IS NOT NULL;

CREATE UNIQUE INDEX idx_notification_contacts_guest_dest
  ON public.notification_contacts (channel, guest_player_id)
  WHERE guest_player_id IS NOT NULL;
-- (A user-only contact — person_id IS NULL AND guest_player_id IS NULL — is not a shape any
--  writer produces: registered contacts carry person_id, guests carry guest_player_id. So
--  it intentionally has no dedup index here.)

COMMENT ON INDEX public.idx_notification_contacts_guest_dest IS
  'Notification v2: one email/whatsapp/push contact per guest_player per channel. guest_player_id is per-academy, so a same-person guest in another academy is a different guest_player → a separate, separately-scoped contact (no cross-academy reuse).';

-- ---------------------------------------------------------------------------
-- 2. ensure_guest_email_contact — upsert a TENANT-SCOPED email contact for a guest.
--
-- Called ONLY by the service-role paid-booking side-effects, right before it enqueues the
-- guest's confirmation. SECURITY DEFINER (writes notification_contacts, which is service-
-- role-only) + locked to service_role: it is not reachable by anon/authenticated, so it is
-- not an oracle and cannot be used to seed arbitrary contacts.
--
-- Scope decision (deviates from the "stamp BOTH academy+trainer" ask, on purpose): a guest
-- can book MULTIPLE trainers within ONE academy, but there is a SINGLE contact row per guest
-- (index above). Stamping the trainer would make that one row's trainer-scope flip between
-- trainers, so a later booking with trainer B would move the row off trainer A and a retry
-- of A's still-required confirmation would fall OUT of scope → undeliverable. Scoping to the
-- ACADEMY alone (trainer alone only when there is NO academy — an independent trainer) is
-- stable across multi-trainer bookings AND still blocks cross-academy reuse, which is the
-- real isolation goal. The enqueue site still passes the full (academy, trainer) context;
-- an academy-scoped contact (trainer dimension NULL) matches it fine.
CREATE OR REPLACE FUNCTION public.ensure_guest_email_contact(
  p_guest_player_id    uuid,
  p_email              text,
  p_academy_profile_id uuid DEFAULT NULL,
  p_trainer_id         uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_email          text := lower(btrim(coalesce(p_email, '')));
  v_scope_academy  uuid;
  v_scope_trainer  uuid;
  v_id             uuid;
BEGIN
  -- No usable email / no guest → no contact. The caller's required-delivery path then
  -- resolves to a VISIBLE 'skipped' + 'no_email_contact' outbox row (not a silent drop).
  IF p_guest_player_id IS NULL OR v_email = '' OR position('@' IN v_email) < 2 THEN
    RETURN NULL;
  END IF;

  -- academy-when-present, else trainer (independent). A 'tenant'-scoped contact MUST name
  -- exactly its owning tenant (chk_notification_contacts_consent_scope coherence CHECK).
  IF p_academy_profile_id IS NOT NULL THEN
    v_scope_academy := p_academy_profile_id;
    v_scope_trainer := NULL;
  ELSIF p_trainer_id IS NOT NULL THEN
    v_scope_academy := NULL;
    v_scope_trainer := p_trainer_id;
  ELSE
    RETURN NULL;  -- no tenant provenance → cannot form a coherent tenant-scoped contact
  END IF;

  INSERT INTO public.notification_contacts (
    guest_player_id, person_id, channel,
    destination_normalized, destination_redacted,
    consent_status, consent_scope,
    consent_academy_profile_id, consent_trainer_id,
    consent_source, consent_at
  ) VALUES (
    p_guest_player_id, NULL, 'email',
    v_email, public.notification_redact_destination(v_email, 'email'),
    -- 'unknown' = a transactional address captured at booking, NOT a marketing opt-in.
    -- The resolver's EMAIL path delivers to any non-opted_out contact (transactional), so
    -- this is deliverable; whatsapp/push (which REQUIRE opted_in) correctly are not.
    'unknown', 'tenant',
    v_scope_academy, v_scope_trainer,
    'paid_booking', now()
  )
  -- idempotent: repeated webhook / paid-claim runs for the same guest are a no-op upsert,
  -- never a duplicate contact. Refresh the address + scope in case either changed.
  ON CONFLICT (channel, guest_player_id) WHERE guest_player_id IS NOT NULL
  DO UPDATE SET
    destination_normalized     = excluded.destination_normalized,
    destination_redacted       = excluded.destination_redacted,
    consent_academy_profile_id = excluded.consent_academy_profile_id,
    consent_trainer_id         = excluded.consent_trainer_id,
    updated_at                 = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid) IS
  'Notification v2 (PR 6a): upsert a tenant-scoped (academy-when-present, else trainer) email contact for a guest, so guest paid-booking confirmations are deliverable via the outbox. consent_scope=tenant, consent_source=paid_booking, consent_status=unknown (transactional, not a marketing opt-in). Idempotent per guest_player. service_role only.';
REVOKE ALL ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid) TO service_role;
