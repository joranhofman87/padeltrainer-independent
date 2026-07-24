-- PR 10c-a1 — v2 notification DIGEST materializer: SCHEMA FOUNDATION (ADR 0008, accepted).
-- Durable digest tables + outbox snapshot columns + the per-event kill switch, with FKs, enum/range
-- constraints, indexes, RLS/ACLs, owner-effective append-only/finish/immutability triggers, and a
-- controlled retention path. INERT: no worker, and no live event sets digest_engine_enabled.
-- Everything is service-role-only (the default-privileges footgun: a bare REVOKE FROM PUBLIC does NOT undo
-- the project's ALTER DEFAULT PRIVILEGES grant to anon/authenticated — every grant is explicit).

-- ===========================================================================
-- 0. Kill switch — a per-event flag SEPARATE from supports_digest (default false everywhere).
ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS digest_engine_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.notification_event_types DROP CONSTRAINT IF EXISTS chk_event_types_digest_engine_implies_supports;
ALTER TABLE public.notification_event_types
  ADD CONSTRAINT chk_event_types_digest_engine_implies_supports CHECK (NOT digest_engine_enabled OR supports_digest);

-- ===========================================================================
-- 1. Outbox snapshot columns (immutable, set by the resolver in a later slice) + delivery_unknown status.
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS delivery_mode           text CHECK (delivery_mode IN ('instant','digest')),
  ADD COLUMN IF NOT EXISTS recipient_key           text,
  ADD COLUMN IF NOT EXISTS digest_frequency        text CHECK (digest_frequency IN ('instant','daily','weekly')),
  ADD COLUMN IF NOT EXISTS group_locale            text,
  ADD COLUMN IF NOT EXISTS recipient_timezone      text,
  ADD COLUMN IF NOT EXISTS digest_boundary_at      timestamptz,
  ADD COLUMN IF NOT EXISTS template_version        int,
  ADD COLUMN IF NOT EXISTS destination_fingerprint text,
  ADD COLUMN IF NOT EXISTS digest_item             jsonb,
  ADD COLUMN IF NOT EXISTS digest_item_bytes       int CHECK (digest_item_bytes IS NULL OR digest_item_bytes >= 0);
ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_status_check CHECK (status IN
  ('pending','processing','sent','delivered','failed','skipped','cancelled','delivery_unknown'));

-- ===========================================================================
-- 2. notification_worker_runs — immutable run identity; finish is the only allowed update.
CREATE TABLE IF NOT EXISTS public.notification_worker_runs (
  run_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker     text NOT NULL,
  channel    text NOT NULL,
  phase      text NOT NULL CHECK (phase IN ('materialize','dispatch')),
  status     text CHECK (status IN ('succeeded','failed','abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);

-- ===========================================================================
-- 3. notification_digest_groups — the durable first-class group row (ADR §M2).
CREATE TABLE IF NOT EXISTS public.notification_digest_groups (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_group_id           uuid,   -- FK (self, ON DELETE SET NULL) added below — 90-day-purge safe
  canonical_group_key       jsonb NOT NULL,
  group_key_hash            text  NOT NULL,
  chunk_ordinal             int   NOT NULL DEFAULT 0 CHECK (chunk_ordinal >= 0),
  channel                   text  NOT NULL,
  event_type                text  NOT NULL,
  recipient_key             text  NOT NULL,
  destination_fingerprint   text  NOT NULL,
  tenant_academy_profile_id uuid,
  tenant_trainer_id         uuid,
  recipient_timezone        text  NOT NULL,
  digest_boundary_at        timestamptz NOT NULL,   -- IMMUTABLE (part of canonical_group_key)
  available_at              timestamptz NOT NULL,   -- MUTABLE scheduling
  state                     text NOT NULL DEFAULT 'pending' CHECK (state IN
                              ('pending','leased','prepared','request_ready','sending','awaiting_evidence',
                               'sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped',
                               'no_work','superseded')),
  item_count                int NOT NULL DEFAULT 0 CHECK (item_count >= 0 AND item_count <= 50),  -- 50-item max
  total_item_bytes          int NOT NULL DEFAULT 0 CHECK (total_item_bytes >= 0),
  provider_attempts_started int NOT NULL DEFAULT 0 CHECK (provider_attempts_started >= 0),  -- monotonic audit
  delivery_budget_used      int NOT NULL DEFAULT 0 CHECK (delivery_budget_used >= 0),        -- refundable
  max_delivery_budget       int NOT NULL DEFAULT 5 CHECK (max_delivery_budget > 0),
  locked_by                 text,
  locked_at                 timestamptz,
  worker_run_id             uuid REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  current_attempt_id        uuid,   -- composite FK (same-group) added below
  frozen_request            jsonb,
  request_hash              text,
  provider_idempotency_key  text,
  first_send_at             timestamptz,
  uncertain_since           timestamptz,
  uncertain_deadline_at     timestamptz,
  provider_message_id       text,
  provider_status           text NOT NULL DEFAULT 'none' CHECK (provider_status IN
                              ('none','sent','delivery_delayed','delivered','bounced','failed','suppressed','complained')),
  provider_status_rank      int  NOT NULL DEFAULT 0 CHECK (provider_status_rank >= 0),
  superseded_by             uuid,
  terminal_reason           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id)
);
ALTER TABLE public.notification_digest_groups
  ADD CONSTRAINT fk_digest_group_parent FOREIGN KEY (parent_group_id)
    REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;  -- lineage survives parent purge

-- outbox → group FK: ON DELETE SET NULL, so a group purge leaves the member row + timeline intact.
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS digest_group_id uuid REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;

-- ===========================================================================
-- 4. notification_digest_attempts — one durable row per HTTP dispatch (ADR §ATT). worker_run_id is
--    NULLABLE (resolves the NOT NULL/ON DELETE SET NULL contradiction). UNIQUE(attempt_id, digest_group_id)
--    lets the group/breaker/reservation bind an attempt that must belong to a specific group.
CREATE TABLE IF NOT EXISTS public.notification_digest_attempts (
  attempt_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_group_id          uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  worker_run_id            uuid REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  provider_idempotency_key text NOT NULL,
  started_at               timestamptz NOT NULL DEFAULT now(),
  outcome_class            text CHECK (outcome_class IS NULL OR outcome_class IN
                             ('accepted','retryable_definite','ambiguous','terminal','global_config')),
  resend_error_name        text,
  http_status              int,
  provider_message_id      text,
  recorded_at              timestamptz,
  CONSTRAINT uq_digest_attempt_group UNIQUE (attempt_id, digest_group_id)
);

-- same-group composite FKs (default NO ACTION — attempts die only via group-cascade, when the referencing
-- rows are being deleted too): a group/breaker/reservation cannot point at a wrong-group or missing attempt.
ALTER TABLE public.notification_digest_groups
  ADD CONSTRAINT fk_digest_group_current_attempt FOREIGN KEY (current_attempt_id, id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id);

-- ===========================================================================
-- 5. notification_digest_group_attempts — append-only event LEDGER (ADR §LEDGER). worker_run_id NULLABLE.
CREATE TABLE IF NOT EXISTS public.notification_digest_group_attempts (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED BY DEFAULT AS IDENTITY,
  worker_run_id   uuid REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  attempt_id      uuid REFERENCES public.notification_digest_attempts(attempt_id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN
                    ('materialized','leased','deferred','deferred_cap','prepared','no_work','superseded',
                     'request_ready','attempt','sent','retryable','ambiguous','terminal','global_config',
                     'awaiting_evidence','delivery_unknown','retry_stopped','oversize_failed')),
  item_count      int  NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 6. notification_provider_events — append-only Resend callbacks; orphan-then-link (ADR §PV).
CREATE TABLE IF NOT EXISTS public.notification_provider_events (
  resend_event_id     text PRIMARY KEY,
  provider_message_id text NOT NULL,
  digest_group_id     uuid REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,  -- NULL = orphan
  status              text NOT NULL CHECK (status IN
                        ('sent','delivery_delayed','delivered','bounced','failed','suppressed','complained')),
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 7. notification_provider_circuit — per-channel breaker with durable probe identity (ADR §CB).
CREATE TABLE IF NOT EXISTS public.notification_provider_circuit (
  channel          text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  reason           text,
  tripped_at       timestamptz,
  retry_at         timestamptz,
  probe_group_id   uuid REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL,
  probe_attempt_id uuid,
  probe_locked_at  timestamptz,
  CONSTRAINT fk_circuit_probe_attempt FOREIGN KEY (probe_attempt_id, probe_group_id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id)
);

-- ===========================================================================
-- 8. notification_send_counters — atomic cap authority (ADR §CAPS), keyed by DESTINATION fingerprint.
CREATE TABLE IF NOT EXISTS public.notification_send_counters (
  counter_key  text PRIMARY KEY,
  bucket_kind  text NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  used         int NOT NULL DEFAULT 0 CHECK (used >= 0),
  cap          int NOT NULL CHECK (cap >= 0)
);

-- ===========================================================================
-- 9. notification_send_reservations — attempt-aware; never released while uncertain (ADR §CAPS).
CREATE TABLE IF NOT EXISTS public.notification_send_reservations (
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  counter_key     text NOT NULL REFERENCES public.notification_send_counters(counter_key) ON DELETE CASCADE,
  attempt_id      uuid,   -- originating attempt (immutable on reuse); composite same-group FK below
  bucket_start    timestamptz NOT NULL,
  state           text NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_group_id, counter_key),
  CONSTRAINT fk_reservation_attempt FOREIGN KEY (attempt_id, digest_group_id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id)
);

-- ===========================================================================
-- 10. Indexes (ADR §IX) — due-work leads with the schedule column; forming keys on immutable delivery_mode.
CREATE INDEX IF NOT EXISTS idx_outbox_digest_forming ON public.notification_outbox (channel, digest_boundary_at)
  WHERE delivery_mode = 'digest' AND digest_group_id IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_digest_group ON public.notification_outbox (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_digest_groups_due ON public.notification_digest_groups (channel, available_at)
  WHERE state IN ('pending','request_ready') AND locked_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_digest_groups_awaiting ON public.notification_digest_groups (available_at)
  WHERE state = 'awaiting_evidence';
CREATE INDEX IF NOT EXISTS idx_digest_groups_stale ON public.notification_digest_groups (channel, locked_at)
  WHERE state IN ('leased','prepared','request_ready','sending');
CREATE INDEX IF NOT EXISTS idx_digest_groups_key_hash ON public.notification_digest_groups (group_key_hash);
CREATE INDEX IF NOT EXISTS idx_digest_attempts_group ON public.notification_digest_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_digest_ledger_group ON public.notification_digest_group_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_orphan ON public.notification_provider_events (provider_message_id)
  WHERE digest_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_events_group ON public.notification_provider_events (digest_group_id);

-- ===========================================================================
-- 11. Owner-effective guards. Triggers fire regardless of caller privilege — they protect the audit trail
--     against future SECURITY DEFINER code, not only against missing grants. The load-bearing signal is
--     pg_trigger_depth(): a DIRECT (top-level) DML runs the guard at depth 1, whereas an FK-driven
--     referential side effect — a group-cascade DELETE or a worker_run SET NULL — runs the child guard at
--     depth > 1. So we ALLOW referential side effects (legitimate: purging a group must cascade its audit
--     rows; deleting a run must null its back-references) while BLOCKING direct mutation/deletion of audit
--     rows. Verified in PGlite (probe): cascade child-delete + SET NULL run at depth 2; direct ops at depth 1.
--     The one controlled delete that is NOT a cascade — pruning finished worker_runs — is gated by the
--     transaction-local app.digest_purge flag that only purge_notification_digest() sets.
CREATE OR REPLACE FUNCTION public.notif_digest_purge_active() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.digest_purge', true), '') = 'on' $$;

-- attempts: at depth 1 (direct), exactly one recorded_at NULL→non-NULL and only the 5 outcome cols may
-- change (identity + request + worker_run_id immutable), and direct delete is forbidden. At depth > 1 the
-- op is a group-cascade delete or a worker_run SET NULL — always allowed.
CREATE OR REPLACE FUNCTION public.notification_digest_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN                         -- FK cascade delete / worker_run SET NULL
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification_digest_attempts: direct delete forbidden (leaves only via group cascade)';
  END IF;
  IF OLD.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'attempt % already recorded; outcomes are immutable', OLD.attempt_id;
  END IF;
  IF NEW.recorded_at IS NULL THEN
    RAISE EXCEPTION 'attempt update must set recorded_at (the sole NULL->recorded transition)';
  END IF;
  IF NEW.attempt_id <> OLD.attempt_id OR NEW.digest_group_id <> OLD.digest_group_id
     OR NEW.worker_run_id IS DISTINCT FROM OLD.worker_run_id
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'attempt identity/request/worker_run fields are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_digest_attempts_guard ON public.notification_digest_attempts;
CREATE TRIGGER trg_digest_attempts_guard BEFORE UPDATE OR DELETE ON public.notification_digest_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notification_digest_attempts_guard();

-- worker_runs: exactly one unfinished→finished (valid status AND ended_at together); identity immutable;
-- direct delete forbidden EXCEPT the controlled retention prune (flag) — this is a top-level delete, not a
-- cascade, so pg_trigger_depth() cannot authorize it.
CREATE OR REPLACE FUNCTION public.notification_worker_runs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR public.notif_digest_purge_active() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'notification_worker_runs: uncontrolled delete forbidden (retention prune only)';
  END IF;
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;     -- defensive: no FK nulls worker_runs, but never block one
  IF OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'worker run % already finished', OLD.run_id; END IF;
  IF NEW.ended_at IS NULL OR NEW.status IS NULL OR NEW.status NOT IN ('succeeded','failed','abandoned') THEN
    RAISE EXCEPTION 'worker run finish must set a valid status AND ended_at together';
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.worker <> OLD.worker OR NEW.channel <> OLD.channel
     OR NEW.phase <> OLD.phase OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'worker run identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_worker_runs_guard ON public.notification_worker_runs;
CREATE TRIGGER trg_worker_runs_guard BEFORE UPDATE OR DELETE ON public.notification_worker_runs
  FOR EACH ROW EXECUTE FUNCTION public.notification_worker_runs_guard();

-- append-only ledger + provider events: NO direct update or delete ever. At depth > 1 the op is a
-- group-cascade delete (retention) or a worker_run SET NULL on ledger.worker_run_id — always allowed.
CREATE OR REPLACE FUNCTION public.notification_append_only_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN                         -- FK cascade delete / worker_run SET NULL
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION '%: append-only, no direct updates', TG_TABLE_NAME; END IF;
  RAISE EXCEPTION '%: direct delete forbidden (leaves only via group cascade)', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS trg_ledger_append_only ON public.notification_digest_group_attempts;
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON public.notification_digest_group_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notification_append_only_guard();
DROP TRIGGER IF EXISTS trg_provider_events_append_only ON public.notification_provider_events;
CREATE TRIGGER trg_provider_events_append_only BEFORE UPDATE OR DELETE ON public.notification_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.notification_append_only_guard();

-- ===========================================================================
-- 12. Controlled retention path (ADR §RET). Groups/counters/reservations are mutable tables and prune with
--     a plain DELETE (their audit-child cascades run at depth > 1 and are allowed by the guards above).
--     Pruning finished worker_runs is the ONLY guarded top-level delete, so the function sets the
--     transaction-local flag the worker_runs guard checks. Order: groups (cascade attempts/ledger/events/
--     reservations) → finished worker_runs (SET NULL on surviving attempt/ledger back-refs) → counters →
--     terminal reservations.
CREATE OR REPLACE FUNCTION public.purge_notification_digest(p_group_days int DEFAULT 90, p_counter_days int DEFAULT 35)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.digest_purge', 'on', true);   -- transaction-local; authorizes the worker_runs prune
  DELETE FROM public.notification_digest_groups
    WHERE state IN ('sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded')
      AND updated_at < now() - make_interval(days => p_group_days);
  DELETE FROM public.notification_worker_runs
    WHERE ended_at IS NOT NULL AND ended_at < now() - make_interval(days => p_group_days);
  DELETE FROM public.notification_send_counters WHERE bucket_start < now() - make_interval(days => p_counter_days);
  DELETE FROM public.notification_send_reservations
    WHERE state IN ('committed','released') AND updated_at < now() - make_interval(days => p_counter_days);
END $$;

-- ===========================================================================
-- 13. RLS + ACL. Every new table: RLS on + FORCE, NO policy, REVOKE PUBLIC/anon/authenticated, service_role
--     only. Append-only tables (ledger, provider_events) get INSERT/SELECT only. attempts +UPDATE. mutable
--     tables full DML. (Deletes on guarded tables happen via retention's SECURITY DEFINER owner privilege.)
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

GRANT INSERT, SELECT ON public.notification_digest_group_attempts TO service_role;
GRANT INSERT, SELECT ON public.notification_provider_events        TO service_role;
GRANT INSERT, SELECT, UPDATE ON public.notification_digest_attempts TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_worker_runs        TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_digest_groups      TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_provider_circuit   TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_send_counters      TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.notification_send_reservations  TO service_role;

REVOKE ALL ON FUNCTION public.purge_notification_digest(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_notification_digest(int, int) TO service_role;
-- notif_digest_purge_active is a read-only helper the guards call; lock it down too.
REVOKE ALL ON FUNCTION public.notif_digest_purge_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_digest_purge_active() TO service_role;
