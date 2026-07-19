-- Notification Foundation v2 — schema (PR 2). See docs/NOTIFICATION_ARCHITECTURE.md.
--
-- The central pipeline: feature/payment code enqueues intent → resolver →
-- notification_outbox → channel workers → provider webhooks → delivery events.
-- This migration lays the DATA + the full tenant-visibility/privacy posture; the
-- resolver (PR 3), workers (PR 4), and tenant-read RPCs (PR 7) come later.
--
-- Privacy/tenant model baked in HERE (Codex-reviewed contract):
--   * outbox + contacts hold raw destinations/payloads → service-role-only
--     (RLS on, no anon/authenticated policies; reads go through DEFINER RPCs).
--   * idempotency is PER RECIPIENT: unique(channel, idempotency_key), the key is
--     <event>:<subject>:<recipient_person> (channel is the constraint, not the key).
--   * consent is TENANT-SCOPED: a person-keyed opt-in carries consent_scope +
--     provenance; the resolver intersects it with the notification's tenant ctx
--     (persons/person_links are GLOBAL, so a raw person-keyed consent leaks).
--   * raw destination (email/phone) + contact_id + person_id are NEVER
--     tenant-visible; tenant reads see only destination_redacted + safe row ids.

-- ---------------------------------------------------------------------------
-- 1. notification_event_types — the taxonomy (config table).
CREATE TABLE public.notification_event_types (
  key                       text PRIMARY KEY,
  category                  text NOT NULL CHECK (category IN
                              ('booking','payment','invoice','reminder','rebook','security','marketing','account')),
  audience                  text NOT NULL CHECK (audience IN
                              ('player','trainer','academy_manager','club_manager','admin','guest')),
  priority                  text NOT NULL CHECK (priority IN
                              ('critical','transactional','actionable','engagement','marketing')),
  required_delivery         boolean NOT NULL DEFAULT false,
  supports_email            boolean NOT NULL DEFAULT true,
  supports_whatsapp         boolean NOT NULL DEFAULT false,
  supports_push             boolean NOT NULL DEFAULT false,
  supports_digest           boolean NOT NULL DEFAULT false,
  default_email_frequency   text NOT NULL DEFAULT 'instant' CHECK (default_email_frequency IN ('instant','daily','weekly','off')),
  default_whatsapp_frequency text NOT NULL DEFAULT 'off'   CHECK (default_whatsapp_frequency IN ('instant','daily','weekly','off')),
  default_push_frequency    text NOT NULL DEFAULT 'off'    CHECK (default_push_frequency IN ('instant','daily','weekly','off')),
  collapse_window_minutes   int NOT NULL DEFAULT 0,
  max_per_user_per_hour     int,
  max_per_user_per_day      int,
  quiet_hours_respect       boolean NOT NULL DEFAULT false,
  template_email            text,
  template_whatsapp         text,
  visibility_scope          text NOT NULL DEFAULT 'private_user_only' CHECK (visibility_scope IN
                              ('private_user_only','tenant_visible','tenant_visible_limited','admin_only')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. notification_contacts — person-keyed destinations + TENANT-SCOPED consent.
CREATE TABLE public.notification_contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                 uuid REFERENCES public.persons(id) ON DELETE CASCADE,
  user_id                   uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  guest_player_id           uuid,  -- FK deferred: guest_players is retired in Phase 4 (person-unification)
  channel                   text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  destination_normalized    text NOT NULL,                 -- raw (service-role-only)
  destination_redacted      text NOT NULL,                 -- the only value tenant reads ever see
  verified_at               timestamptz,
  consent_status            text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','opted_in','opted_out')),
  -- consent scope: 'global' = the person's own account-level contact (usable in
  -- any tenant context); 'tenant' = collected by/for one tenant, usable ONLY
  -- when the notification's tenant matches the provenance below.
  consent_scope             text NOT NULL DEFAULT 'global' CHECK (consent_scope IN ('global','tenant')),
  consent_academy_profile_id uuid,
  consent_trainer_id        uuid,
  consent_source            text,
  consent_at                timestamptz,
  revoked_at                timestamptz,
  is_primary                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- no orphan contacts: every contact belongs to a person / user / guest.
  CONSTRAINT chk_notification_contacts_ref
    CHECK (person_id IS NOT NULL OR user_id IS NOT NULL OR guest_player_id IS NOT NULL)
);
CREATE INDEX idx_notification_contacts_person ON public.notification_contacts (person_id);
CREATE INDEX idx_notification_contacts_user   ON public.notification_contacts (user_id);
CREATE INDEX idx_notification_contacts_guest  ON public.notification_contacts (guest_player_id);
CREATE UNIQUE INDEX idx_notification_contacts_dest
  ON public.notification_contacts (channel, destination_normalized, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Consent scope intersection: is this consent usable for a notification whose
-- tenant context is (_ctx_academy, _ctx_trainer)? global → always; tenant → only
-- when the notification's tenant matches the consent provenance. (The full
-- recipient resolver in PR 3 calls this; pinned here so the rule ships now.)
CREATE OR REPLACE FUNCTION public.is_notification_consent_in_scope(
  _consent_scope    text,
  _consent_academy  uuid,
  _consent_trainer  uuid,
  _ctx_academy      uuid,
  _ctx_trainer      uuid
) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN _consent_scope = 'global' THEN true
    -- tenant: EVERY non-null provenance dimension must match the notification's
    -- context, AND at least one provenance must be set. An OR would leak — consent
    -- for (Academy A, Trainer T) must NOT be usable for (Academy B, Trainer T).
    WHEN _consent_scope = 'tenant' THEN
          (_consent_academy IS NULL OR (_ctx_academy IS NOT NULL AND _ctx_academy = _consent_academy))
      AND (_consent_trainer IS NULL OR (_ctx_trainer IS NOT NULL AND _ctx_trainer = _consent_trainer))
      AND (_consent_academy IS NOT NULL OR _consent_trainer IS NOT NULL)
    ELSE false
  END;
$$;

-- ---------------------------------------------------------------------------
-- 3. notification_preferences_v2 — per-user, per-event, per-channel frequency.
CREATE TABLE public.notification_preferences_v2 (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  event_type         text NOT NULL REFERENCES public.notification_event_types(key) ON DELETE CASCADE,
  email_frequency    text NOT NULL DEFAULT 'instant' CHECK (email_frequency IN ('instant','daily','weekly','off')),
  whatsapp_frequency text NOT NULL DEFAULT 'off'     CHECK (whatsapp_frequency IN ('instant','daily','weekly','off')),
  push_frequency     text NOT NULL DEFAULT 'off'     CHECK (push_frequency IN ('instant','daily','weekly','off')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_type)
);

-- ---------------------------------------------------------------------------
-- 4. notification_outbox — one row per recipient × channel.
CREATE TABLE public.notification_outbox (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type                text NOT NULL REFERENCES public.notification_event_types(key),
  channel                   text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  -- recipient (person-keyed; the dual keys carry through the transition)
  recipient_user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_person_id       uuid REFERENCES public.persons(id) ON DELETE CASCADE,
  recipient_guest_player_id uuid,  -- FK deferred: guest_players retired in Phase 4
  -- tenant context (drives tenant-visible reads + consent intersection)
  tenant_academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  tenant_trainer_id         uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  visibility_scope          text NOT NULL DEFAULT 'private_user_only' CHECK (visibility_scope IN
                              ('private_user_only','tenant_visible','tenant_visible_limited','admin_only')),
  -- subject refs (for timelines)
  related_booking_ids       uuid[],
  related_invoice_id        uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  related_payment_id        text,
  -- destinations: raw is service-role-only; redacted is the tenant-visible one.
  destination_normalized    text,
  destination_redacted      text,
  contact_id                uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL, -- service-role-only ref
  template_key              text,
  payload                   jsonb,                         -- service-role-only (may hold tokens/PII)
  public_summary            jsonb,                         -- sanitized; the only body a tenant read sees
  idempotency_key           text NOT NULL,
  collapse_key              text,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN
                              ('pending','processing','sent','delivered','failed','skipped','cancelled')),
  skip_reason               text,
  provider                  text,
  provider_message_id       text,
  attempts                  int NOT NULL DEFAULT 0,
  max_attempts              int NOT NULL DEFAULT 5,
  scheduled_for             timestamptz NOT NULL DEFAULT now(),
  next_attempt_at           timestamptz,
  locked_at                 timestamptz,
  locked_by                 text,
  sent_at                   timestamptz,
  delivered_at              timestamptz,
  failed_at                 timestamptz,
  last_error                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- no orphan: every outbox row targets a recipient.
  CONSTRAINT chk_notification_outbox_recipient
    CHECK (recipient_person_id IS NOT NULL OR recipient_user_id IS NOT NULL OR recipient_guest_player_id IS NOT NULL),
  -- tenant-visible rows must carry tenant context + a sanitized summary, so they
  -- can't become invisible history or force the timeline RPCs to invent fallbacks.
  CONSTRAINT chk_notification_outbox_tenant_visible
    CHECK (visibility_scope NOT IN ('tenant_visible','tenant_visible_limited')
           OR ((tenant_academy_profile_id IS NOT NULL OR tenant_trainer_id IS NOT NULL) AND public_summary IS NOT NULL)),
  -- PER-RECIPIENT idempotency: the paid E-15 claim GATES enqueue; each recipient
  -- row's key is <event>:<subject>:<recipient_person>, channel is the constraint.
  CONSTRAINT uq_notification_outbox_idem UNIQUE (channel, idempotency_key)
);
-- worker scan: the next due, unlocked, pending/retryable rows
CREATE INDEX idx_notification_outbox_due
  ON public.notification_outbox (status, scheduled_for, next_attempt_at)
  WHERE status IN ('pending','processing');
CREATE INDEX idx_notification_outbox_tenant_academy ON public.notification_outbox (tenant_academy_profile_id) WHERE tenant_academy_profile_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_tenant_trainer ON public.notification_outbox (tenant_trainer_id) WHERE tenant_trainer_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_recipient_user ON public.notification_outbox (recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_recipient_person ON public.notification_outbox (recipient_person_id) WHERE recipient_person_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_invoice ON public.notification_outbox (related_invoice_id) WHERE related_invoice_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_provider_msg ON public.notification_outbox (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_notification_outbox_collapse ON public.notification_outbox (collapse_key) WHERE collapse_key IS NOT NULL AND status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. Generalize email_delivery_events into the channel-agnostic delivery log.
--    Reuse (don't fork) so the suppression list + invoice bounce UI keep working.
ALTER TABLE public.email_delivery_events
  ADD COLUMN IF NOT EXISTS channel              text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp','push')),
  ADD COLUMN IF NOT EXISTS outbox_id            uuid REFERENCES public.notification_outbox(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id           uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL, -- service-role-only ref
  ADD COLUMN IF NOT EXISTS destination_redacted text;   -- tenant-visible destination
-- recipient_email was NOT NULL + email-shaped; a WhatsApp phone can't live there.
ALTER TABLE public.email_delivery_events ALTER COLUMN recipient_email DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ede_outbox ON public.email_delivery_events (outbox_id) WHERE outbox_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS + grants.
-- event_types: non-sensitive taxonomy → authenticated may READ (for the settings
-- UI labels); no client write.
ALTER TABLE public.notification_event_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "event types readable by authenticated"
  ON public.notification_event_types FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.notification_event_types FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.notification_event_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_event_types TO service_role;

-- preferences_v2: users CRUD their OWN rows only (mirrors the v1 hardening —
-- WITH CHECK blocks user_id reassignment). The settings UI reads/writes directly.
ALTER TABLE public.notification_preferences_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prefs v2 select own"  ON public.notification_preferences_v2 FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "prefs v2 insert own"  ON public.notification_preferences_v2 FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "prefs v2 update own"  ON public.notification_preferences_v2 FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "prefs v2 delete own"  ON public.notification_preferences_v2 FOR DELETE TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON TABLE public.notification_preferences_v2 FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_preferences_v2 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_preferences_v2 TO service_role;

-- contacts + outbox: raw destinations/payloads → SERVICE-ROLE-ONLY. No
-- anon/authenticated policies (RLS denies them); all tenant/player reads go
-- through the SECURITY DEFINER timeline RPCs (PR 7), which return only
-- public_summary + destination_redacted + safe row ids.
ALTER TABLE public.notification_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_contacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_outbox   FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_outbox   TO service_role;

REVOKE ALL ON FUNCTION public.is_notification_consent_in_scope(text, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_notification_consent_in_scope(text, uuid, uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Seed the initial v2 event-type taxonomy (20 canonical keys).
--
-- RECONCILIATION with the current send-email dispatcher (26 concrete `type`s):
-- these 20 v2 keys cover the notifications that PR 5/6 migrate onto the outbox;
-- the PR-3 resolver owns the LEGACY-type → v2-key mapping (many-to-one, e.g.
-- new_booking_trainer + new_public_booking_admin + booking_request all collapse
-- to booking_confirmed_staff / booking_request_staff). Legacy/system-only types
-- that are NOT yet migrated — club_claim_{approved,rejected},
-- club_trainer_invitation{,_accepted}, partner_inquiry, location_request,
-- intake_registration_confirmation, new_intake_registration_admin,
-- schedule_notification, booking_approved_{payment,invoice}, booking_rejected —
-- deliberately stay on the direct send-email path until PR 10 (retire legacy
-- sends). No enqueue references a v2 key that isn't seeded here, so there are no
-- FK failures; the resolver is the single place the legacy names are translated.
INSERT INTO public.notification_event_types
  (key, category, audience, priority, required_delivery, supports_email, supports_whatsapp, supports_digest,
   default_email_frequency, collapse_window_minutes, quiet_hours_respect, visibility_scope) VALUES
  ('booking_confirmed_player',  'booking', 'player',          'transactional', true,  true, true,  false, 'instant', 0,  false, 'private_user_only'),
  ('booking_confirmed_staff',   'booking', 'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('booking_request_staff',     'booking', 'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('booking_cancelled_player',  'booking', 'player',          'transactional', false, true, true,  false, 'instant', 0,  false, 'private_user_only'),
  ('booking_cancelled_staff',   'booking', 'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('session_reminder_player',   'reminder','player',          'actionable',    false, true, true,  true,  'instant', 0,  true,  'private_user_only'),
  ('payment_receipt_player',    'payment', 'player',          'transactional', true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('payment_received_staff',    'payment', 'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('invoice_created_player',    'invoice', 'player',          'transactional', true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('invoice_paid_player',       'invoice', 'player',          'transactional', true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('invoice_paid_staff',        'invoice', 'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('invoice_payment_failed',    'invoice', 'player',          'critical',      true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('invoice_reminder_player',   'reminder','player',          'actionable',    false, true, true,  false, 'instant', 0,  true,  'private_user_only'),
  ('rebook_invite_player',      'rebook',  'player',          'actionable',    false, true, true,  false, 'instant', 0,  true,  'private_user_only'),
  ('rebook_paid_player',        'rebook',  'player',          'transactional', true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('rebook_paid_staff',         'rebook',  'academy_manager', 'actionable',    false, true, false, true,  'instant', 15, false, 'tenant_visible'),
  ('review_received_trainer',   'booking', 'trainer',         'engagement',    false, true, false, true,  'instant', 0,  false, 'tenant_visible'),
  ('password_reset',            'security','player',          'critical',      true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('account_email_changed',     'account', 'player',          'critical',      true,  true, false, false, 'instant', 0,  false, 'private_user_only'),
  ('marketing_updates',         'marketing','player',         'marketing',     false, true, false, false, 'off',     0,  true,  'admin_only');
