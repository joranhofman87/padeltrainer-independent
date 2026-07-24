-- PR 10c-a1 — v2 notification DIGEST materializer: SCHEMA FOUNDATION (ADR 0008, accepted).
-- Adds the durable digest tables + the outbox snapshot columns + the per-event kill switch, with FKs,
-- constraints, indexes, RLS/ACLs and append-only/finish triggers. INERT: no RPC, no worker, and no live
-- event sets digest_engine_enabled — the engine ships dormant until PR 10c-b enables the first event.
-- Everything here is service-role-only (the default-privileges footgun: a bare REVOKE FROM PUBLIC does NOT
-- undo the project's ALTER DEFAULT PRIVILEGES grant to anon/authenticated, so every grant is explicit).

-- ===========================================================================
-- 0. Kill switch — a per-event flag SEPARATE from supports_digest, so a pre-existing
--    supports_digest=true event cannot accidentally activate the engine. Default false everywhere.
ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS digest_engine_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.notification_event_types
  DROP CONSTRAINT IF EXISTS chk_event_types_digest_engine_implies_supports;
ALTER TABLE public.notification_event_types
  ADD CONSTRAINT chk_event_types_digest_engine_implies_supports
    CHECK (NOT digest_engine_enabled OR supports_digest);

-- ===========================================================================
-- 1. Outbox snapshot columns (immutable, set by the resolver at enqueue in a later slice) + the
--    delivery_unknown member status. delivery_mode is the strict-boolean path selector: legacy NULL rows
--    stay instant-path (digest_eligible := coalesce(delivery_mode='digest', false)).
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS delivery_mode           text CHECK (delivery_mode IN ('instant','digest')),
  ADD COLUMN IF NOT EXISTS recipient_key           text,
  ADD COLUMN IF NOT EXISTS digest_frequency        text CHECK (digest_frequency IN ('instant','daily','weekly')),
  ADD COLUMN IF NOT EXISTS group_locale            text,
  ADD COLUMN IF NOT EXISTS recipient_timezone      text,
  ADD COLUMN IF NOT EXISTS digest_boundary_at      timestamptz,
  ADD COLUMN IF NOT EXISTS template_version        int,
  ADD COLUMN IF NOT EXISTS destination_fingerprint text,
  ADD COLUMN IF NOT EXISTS digest_item             jsonb,   -- service-role-only (tokenized deep_link)
  ADD COLUMN IF NOT EXISTS digest_item_bytes       int;     -- server-computed octet_length at enqueue
-- status CHECK gains 'delivery_unknown' (a digest group's un-provable send resolves its member rows here).
ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_status_check CHECK (status IN
    ('pending','processing','sent','delivered','failed','skipped','cancelled','delivery_unknown'));

-- ===========================================================================
-- 2. notification_worker_runs — immutable run identity (finish is the only allowed update).
CREATE TABLE IF NOT EXISTS public.notification_worker_runs (
  run_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker     text NOT NULL,
  channel    text NOT NULL,
  phase      text NOT NULL,                         -- materialize | dispatch
  status     text CHECK (status IN ('succeeded','failed','abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);

-- ===========================================================================
-- 3. notification_digest_groups — the DURABLE first-class group row (ADR §M2, Rev 12).
CREATE TABLE IF NOT EXISTS public.notification_digest_groups (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_group_id           uuid REFERENCES public.notification_digest_groups(id),  -- set on split children
  canonical_group_key       jsonb NOT NULL,
  group_key_hash            text  NOT NULL,
  chunk_ordinal             int   NOT NULL DEFAULT 0,
  channel                   text  NOT NULL,
  event_type                text  NOT NULL,
  recipient_key             text  NOT NULL,
  destination_fingerprint   text  NOT NULL,
  tenant_academy_profile_id uuid,
  tenant_trainer_id         uuid,
  recipient_timezone        text  NOT NULL,
  digest_boundary_at        timestamptz NOT NULL,   -- IMMUTABLE (part of canonical_group_key)
  available_at              timestamptz NOT NULL,   -- MUTABLE scheduling (quiet-hours/cap/backoff)
  state                     text NOT NULL DEFAULT 'pending' CHECK (state IN
                              ('pending','leased','prepared','request_ready','sending','awaiting_evidence',
                               'sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped',
                               'no_work','superseded')),
  item_count                int NOT NULL DEFAULT 0,
  total_item_bytes          int NOT NULL DEFAULT 0,
  provider_attempts_started int NOT NULL DEFAULT 0,  -- MONOTONIC audit (never decremented)
  delivery_budget_used      int NOT NULL DEFAULT 0,  -- refundable; bounds retries
  max_delivery_budget       int NOT NULL DEFAULT 5,
  locked_by                 text,
  locked_at                 timestamptz,
  worker_run_id             uuid REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  current_attempt_id        uuid,                    -- pointer (no FK: circular with attempts)
  frozen_request            jsonb,                   -- service-role-only; nulled on terminal (scrub)
  request_hash              text,
  provider_idempotency_key  text,
  first_send_at             timestamptz,
  uncertain_since           timestamptz,             -- sticky; cleared only by positive evidence
  uncertain_deadline_at     timestamptz,             -- uncertain_since + 23h
  provider_message_id       text,
  provider_status           text NOT NULL DEFAULT 'none' CHECK (provider_status IN
                              ('none','sent','delivery_delayed','delivered','bounced','failed','suppressed','complained')),
  provider_status_rank      int  NOT NULL DEFAULT 0,
  superseded_by             uuid,
  terminal_reason           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id)
);

-- outbox → group FK: ON DELETE SET NULL, so a 90-day group purge leaves the member row + timeline intact.
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS digest_group_id uuid REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;

-- ===========================================================================
-- 4. notification_digest_attempts — one durable row per HTTP dispatch (ADR §ATT). Fresh attempt_id per
--    dispatch; the group's frozen provider key is reused. Record is idempotent (recorded_at NULL→set).
CREATE TABLE IF NOT EXISTS public.notification_digest_attempts (
  attempt_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_group_id         uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  worker_run_id           uuid NOT NULL REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  provider_idempotency_key text NOT NULL,
  started_at              timestamptz NOT NULL DEFAULT now(),
  outcome_class           text,
  resend_error_name       text,
  http_status             int,
  provider_message_id     text,
  recorded_at             timestamptz            -- NULL until record(); the sole permitted update
);

-- ===========================================================================
-- 5. notification_digest_group_attempts — the append-only event LEDGER (ADR §LEDGER).
CREATE TABLE IF NOT EXISTS public.notification_digest_group_attempts (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED BY DEFAULT AS IDENTITY,
  worker_run_id   uuid NOT NULL REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  attempt_id      uuid REFERENCES public.notification_digest_attempts(attempt_id) ON DELETE SET NULL,
  action          text NOT NULL,
  item_count      int  NOT NULL DEFAULT 0,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 6. notification_provider_events — append-only Resend callbacks; orphan-then-link (ADR §PV).
CREATE TABLE IF NOT EXISTS public.notification_provider_events (
  resend_event_id     text PRIMARY KEY,
  provider_message_id text NOT NULL,
  digest_group_id     uuid REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,  -- NULL = orphan
  status              text NOT NULL,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 7. notification_provider_circuit — the per-channel breaker with durable probe identity (ADR §CB).
CREATE TABLE IF NOT EXISTS public.notification_provider_circuit (
  channel          text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  reason           text,
  tripped_at       timestamptz,
  retry_at         timestamptz,                     -- NULL = manual hold (monthly quota / invariant breach)
  probe_group_id   uuid,
  probe_attempt_id uuid,
  probe_locked_at  timestamptz
);

-- ===========================================================================
-- 8. notification_send_counters — the atomic cap authority (ADR §CAPS), keyed by DESTINATION fingerprint.
CREATE TABLE IF NOT EXISTS public.notification_send_counters (
  counter_key  text PRIMARY KEY,                    -- channel:event_type:destination_fingerprint:bucket_kind:bucket_start
  bucket_kind  text NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  used         int NOT NULL DEFAULT 0 CHECK (used >= 0),
  cap          int NOT NULL
);

-- ===========================================================================
-- 9. notification_send_reservations — attempt-aware, never-released-while-uncertain (ADR §CAPS, Rev 12).
CREATE TABLE IF NOT EXISTS public.notification_send_reservations (
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  counter_key     text NOT NULL,
  attempt_id      uuid,                              -- originating attempt (immutable on reuse)
  bucket_start    timestamptz NOT NULL,
  state           text NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_group_id, counter_key)
);

-- ===========================================================================
-- 10. Indexes (ADR §IX) — due-work leads with the schedule column; forming keys on immutable delivery_mode.
CREATE INDEX IF NOT EXISTS idx_outbox_digest_forming
  ON public.notification_outbox (channel, digest_boundary_at)
  WHERE delivery_mode = 'digest' AND digest_group_id IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_digest_group ON public.notification_outbox (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_digest_groups_due
  ON public.notification_digest_groups (channel, available_at)
  WHERE state IN ('pending','request_ready') AND locked_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_digest_groups_awaiting
  ON public.notification_digest_groups (available_at) WHERE state = 'awaiting_evidence';
CREATE INDEX IF NOT EXISTS idx_digest_groups_stale
  ON public.notification_digest_groups (channel, locked_at)
  WHERE state IN ('leased','prepared','request_ready','sending');
CREATE INDEX IF NOT EXISTS idx_digest_groups_key_hash ON public.notification_digest_groups (group_key_hash);
CREATE INDEX IF NOT EXISTS idx_digest_attempts_group ON public.notification_digest_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_digest_ledger_group ON public.notification_digest_group_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_orphan
  ON public.notification_provider_events (provider_message_id) WHERE digest_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_events_group ON public.notification_provider_events (digest_group_id);

-- ===========================================================================
-- 11. Constrained-update triggers. attempts: only recorded_at NULL→set + outcome cols; identity/request
--     immutable; no direct delete. worker_runs: only ended_at NULL→set. (Append-only ledger/provider_events
--     are protected by grants — no UPDATE/DELETE grant — while ON DELETE CASCADE still runs as owner.)
CREATE OR REPLACE FUNCTION public.notification_digest_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification_digest_attempts is append-only (rows leave only via group-cascade)';
  END IF;
  IF OLD.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'attempt % already recorded; outcomes are immutable', OLD.attempt_id;
  END IF;
  IF NEW.attempt_id <> OLD.attempt_id OR NEW.digest_group_id <> OLD.digest_group_id
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'attempt identity/request fields are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_digest_attempts_guard ON public.notification_digest_attempts;
CREATE TRIGGER trg_digest_attempts_guard BEFORE UPDATE OR DELETE ON public.notification_digest_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notification_digest_attempts_guard();

CREATE OR REPLACE FUNCTION public.notification_worker_runs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;   -- retention may delete finished runs
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'worker run % already finished', OLD.run_id;
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.worker <> OLD.worker OR NEW.channel <> OLD.channel
     OR NEW.phase <> OLD.phase OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'worker run identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_worker_runs_guard ON public.notification_worker_runs;
CREATE TRIGGER trg_worker_runs_guard BEFORE UPDATE ON public.notification_worker_runs
  FOR EACH ROW EXECUTE FUNCTION public.notification_worker_runs_guard();

-- ===========================================================================
-- 12. RLS + ACL. Every new table: RLS on, NO policy (no anon/authenticated reach), REVOKE PUBLIC/anon/
--     authenticated, service_role only. Append-only tables (ledger, provider_events) get INSERT/SELECT
--     only. attempts/worker_runs get UPDATE (trigger-constrained). Mutable tables get full DML.
DO $acl$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notification_worker_runs','notification_digest_groups','notification_digest_attempts',
    'notification_digest_group_attempts','notification_provider_events','notification_provider_circuit',
    'notification_send_counters','notification_send_reservations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $acl$;

-- append-only: INSERT + SELECT only (no UPDATE/DELETE grant; ON DELETE CASCADE still runs as owner).
GRANT INSERT, SELECT ON public.notification_digest_group_attempts TO service_role;
GRANT INSERT, SELECT ON public.notification_provider_events        TO service_role;
-- constrained-update: INSERT + SELECT + UPDATE (trigger enforces the allowed transition), no DELETE.
GRANT INSERT, SELECT, UPDATE ON public.notification_digest_attempts TO service_role;
-- worker_runs: + DELETE for retention of finished runs.
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_worker_runs TO service_role;
-- mutable + retention:
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_digest_groups       TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_provider_circuit    TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_send_counters       TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_send_reservations   TO service_role;
