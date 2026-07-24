-- PR 10c-a1 — v2 notification DIGEST materializer: SCHEMA FOUNDATION (ADR 0008, accepted).
-- Durable digest tables + outbox snapshot columns + the per-event kill switch, with FKs, enum/range
-- constraints, indexes, RLS/ACLs, owner-effective lifecycle/immutability guards, and a genuinely
-- controlled, bounded retention path. INERT: no worker, and no live event sets digest_engine_enabled.
--
-- AUTHORIZATION MODEL (Codex round-2 remediation): NOTHING gets service_role DELETE. Rows leave ONLY
-- through purge_notification_digest() (SECURITY DEFINER → runs with the table owner's DELETE) or through
-- FK cascades that it triggers. Owner-effective guards (triggers fire regardless of caller privilege)
-- additionally constrain WHAT may be deleted/mutated even by future SECURITY DEFINER code:
--   * audit rows (attempts, ledger, provider_events) may leave ONLY via a group cascade — never a direct
--     top-level delete. Discriminated by pg_trigger_depth()>1 (a referential side effect runs the child
--     guard nested; a direct DML runs it at depth 1). Verified in PGlite.
--   * a group may be deleted ONLY in a terminal state; a worker_run ONLY once finished.
--   * identity/snapshot columns are write-once. Attempts are born unrecorded; runs are born unfinished.
-- The previous caller-settable GUC (app.digest_purge) is REMOVED — a GUC is not authorization.

-- ===========================================================================
-- 0. Kill switch — a per-event flag SEPARATE from supports_digest (default false everywhere).
ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS digest_engine_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.notification_event_types DROP CONSTRAINT IF EXISTS chk_event_types_digest_engine_implies_supports;
ALTER TABLE public.notification_event_types
  ADD CONSTRAINT chk_event_types_digest_engine_implies_supports CHECK (NOT digest_engine_enabled OR supports_digest);

-- ===========================================================================
-- 1. Outbox snapshot columns (write-once, set by the resolver) + delivery_unknown status.
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
-- 2. notification_worker_runs — immutable run identity; born unfinished; finish is the only update.
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
  parent_group_id           uuid,   -- self FK (ON DELETE SET NULL) added below — 90-day-purge safe
  superseded_by             uuid,   -- self FK (ON DELETE SET NULL) added below
  canonical_group_key       jsonb NOT NULL,   -- IMMUTABLE identity (guard)
  group_key_hash            text  NOT NULL,   -- IMMUTABLE
  chunk_ordinal             int   NOT NULL DEFAULT 0 CHECK (chunk_ordinal >= 0),  -- IMMUTABLE
  channel                   text  NOT NULL,   -- IMMUTABLE
  event_type                text  NOT NULL,   -- IMMUTABLE
  recipient_key             text  NOT NULL,   -- IMMUTABLE
  destination_fingerprint   text  NOT NULL,   -- IMMUTABLE
  tenant_academy_profile_id uuid,             -- IMMUTABLE
  tenant_trainer_id         uuid,             -- IMMUTABLE
  recipient_timezone        text  NOT NULL,   -- IMMUTABLE
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
  provider_message_id       text,   -- WRITE-ONCE (guard)
  provider_status           text NOT NULL DEFAULT 'none' CHECK (provider_status IN
                              ('none','sent','delivery_delayed','delivered','bounced','failed','suppressed','complained')),
  provider_status_rank      int  NOT NULL DEFAULT 0 CHECK (provider_status_rank >= 0),
  terminal_reason           text,
  terminal_at               timestamptz,   -- SCHEMA-OWNED retention clock: guard stamps it on entry into a
                                           -- terminal state, freezes it after, clears it if it leaves. Callers
                                           -- can never set/backdate it (the guard always overwrites).
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id),
  CONSTRAINT uq_digest_group_id_provider UNIQUE (id, provider_message_id),  -- for the provider-event match FK
  -- provider_status is coupled 1:1 to its monotonic rank (ADR §PV rollup ordering)
  CONSTRAINT chk_digest_group_provider_rank CHECK (
    (provider_status='none'             AND provider_status_rank=0) OR
    (provider_status='sent'             AND provider_status_rank=1) OR
    (provider_status='delivery_delayed' AND provider_status_rank=2) OR
    (provider_status='delivered'        AND provider_status_rank=3) OR
    (provider_status IN ('bounced','failed','suppressed') AND provider_status_rank=4) OR
    (provider_status='complained'       AND provider_status_rank=5))
);
ALTER TABLE public.notification_digest_groups
  ADD CONSTRAINT fk_digest_group_parent FOREIGN KEY (parent_group_id)
    REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;
ALTER TABLE public.notification_digest_groups
  ADD CONSTRAINT fk_digest_group_superseded FOREIGN KEY (superseded_by)
    REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;

-- outbox → group FK: ON DELETE SET NULL, so a group purge leaves the member row + timeline intact.
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS digest_group_id uuid REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL;

-- ===========================================================================
-- 4. notification_digest_attempts — one durable row per HTTP dispatch (ADR §ATT). Born unrecorded.
--    worker_run_id NULLABLE (retention SET NULL). UNIQUE(attempt_id,digest_group_id) anchors same-group FKs.
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
ALTER TABLE public.notification_digest_groups
  ADD CONSTRAINT fk_digest_group_current_attempt FOREIGN KEY (current_attempt_id, id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id);

-- ===========================================================================
-- 5. notification_digest_group_attempts — append-only event LEDGER (ADR §LEDGER). Its (attempt_id,
--    digest_group_id) must reference the SAME attempt/group pair (composite FK, not two independent ones).
CREATE TABLE IF NOT EXISTS public.notification_digest_group_attempts (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED BY DEFAULT AS IDENTITY,
  worker_run_id   uuid REFERENCES public.notification_worker_runs(run_id) ON DELETE SET NULL,
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  attempt_id      uuid,   -- composite same-group FK below (NULL for group-only ledger events)
  action          text NOT NULL CHECK (action IN
                    ('materialized','leased','deferred','deferred_cap','prepared','no_work','superseded',
                     'request_ready','attempt','sent','retryable','ambiguous','terminal','global_config',
                     'awaiting_evidence','delivery_unknown','retry_stopped','oversize_failed')),
  item_count      int  NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ledger_attempt FOREIGN KEY (attempt_id, digest_group_id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id)
);

-- ===========================================================================
-- 6. notification_provider_events — append-only Resend callbacks (ADR §PV). A LINKED event's
--    (digest_group_id, provider_message_id) must equal the group's own (id, provider_message_id).
CREATE TABLE IF NOT EXISTS public.notification_provider_events (
  resend_event_id     text PRIMARY KEY,
  provider_message_id text NOT NULL,
  digest_group_id     uuid,   -- NULL = orphan (arrived before correlation); composite FK below
  status              text NOT NULL CHECK (status IN
                        ('sent','delivery_delayed','delivered','bounced','failed','suppressed','complained')),
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_provider_event_group FOREIGN KEY (digest_group_id, provider_message_id)
    REFERENCES public.notification_digest_groups(id, provider_message_id) ON DELETE CASCADE
);

-- ===========================================================================
-- 7. notification_provider_circuit — per-channel breaker; probe identity clears ATOMICALLY on group purge
--    (composite FK ON DELETE SET NULL nulls probe_attempt_id AND probe_group_id together).
CREATE TABLE IF NOT EXISTS public.notification_provider_circuit (
  channel          text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  reason           text,
  tripped_at       timestamptz,
  retry_at         timestamptz,
  probe_group_id   uuid REFERENCES public.notification_digest_groups(id) ON DELETE SET NULL,  -- attempt-less probe
  probe_attempt_id uuid,
  probe_locked_at  timestamptz,
  -- validation only (NO ACTION): the group guard clears BOTH probe fields atomically on delete, so a
  -- lone FK SET NULL (which MATCH SIMPLE would detach the moment probe_group_id nulls) is never relied on.
  CONSTRAINT fk_circuit_probe_attempt FOREIGN KEY (probe_attempt_id, probe_group_id)
    REFERENCES public.notification_digest_attempts(attempt_id, digest_group_id)
);

-- ===========================================================================
-- 8. notification_send_counters — atomic cap authority (ADR §CAPS). UNIQUE(counter_key,bucket_start)
--    anchors the reservation bucket-match FK.
CREATE TABLE IF NOT EXISTS public.notification_send_counters (
  counter_key  text PRIMARY KEY,
  bucket_kind  text NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  used         int NOT NULL DEFAULT 0 CHECK (used >= 0),
  cap          int NOT NULL CHECK (cap >= 0),
  CONSTRAINT uq_send_counter_bucket UNIQUE (counter_key, bucket_start)
);

-- ===========================================================================
-- 9. notification_send_reservations — attempt-aware; NEVER released while uncertain (ADR §CAPS).
--    counter FK is RESTRICT: counter retention can't cascade away a live reservation.
CREATE TABLE IF NOT EXISTS public.notification_send_reservations (
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  counter_key     text NOT NULL,
  attempt_id      uuid,   -- originating attempt (write-once); composite same-group FK below
  bucket_start    timestamptz NOT NULL,   -- IMMUTABLE; must equal the counter's bucket_start
  state           text NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_group_id, counter_key),
  CONSTRAINT fk_reservation_counter FOREIGN KEY (counter_key, bucket_start)
    REFERENCES public.notification_send_counters(counter_key, bucket_start) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_digest_groups_retention ON public.notification_digest_groups (terminal_at)
  WHERE state IN ('sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded');
CREATE INDEX IF NOT EXISTS idx_provider_events_orphan_retention ON public.notification_provider_events (received_at)
  WHERE digest_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_digest_attempts_group ON public.notification_digest_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_digest_ledger_group ON public.notification_digest_group_attempts (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_orphan ON public.notification_provider_events (provider_message_id)
  WHERE digest_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_events_group ON public.notification_provider_events (digest_group_id);
CREATE INDEX IF NOT EXISTS idx_worker_runs_retention ON public.notification_worker_runs (ended_at)
  WHERE ended_at IS NOT NULL;
-- retention scale (100k-row): purge filters/orders counters by bucket_start and anti-joins reservations by counter_key
CREATE INDEX IF NOT EXISTS idx_send_counters_retention ON public.notification_send_counters (bucket_start, counter_key);
CREATE INDEX IF NOT EXISTS idx_send_reservations_counter ON public.notification_send_reservations (counter_key);

-- ===========================================================================
-- 11. Owner-effective guards. Legitimacy of an FK-driven side effect is proven by the FK PRECONDITION, not
--     by pg_trigger_depth() (which any unrelated nested trigger can satisfy): a cascade delete is allowed
--     only when the referenced parent row is already GONE; a SET NULL of a back-reference only when the
--     referenced row is gone. Root rows (groups, outbox) carry NO depth bypass at all — their invariants are
--     enforced for every caller, nested or not. (No caller-settable GUC anywhere; authorization is the
--     absence of a service_role DELETE grant.)

-- attempts: born unrecorded; the ONLY update is the recorded_at NULL→non-NULL transition (valid outcome_class;
-- identity/request/worker_run immutable) OR the worker_run_id→NULL SET NULL of a PURGED run; direct delete
-- forbidden — an attempt leaves only when its group is already gone (cascade).
CREATE OR REPLACE FUNCTION public.notification_digest_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.recorded_at IS NOT NULL OR NEW.outcome_class IS NOT NULL OR NEW.http_status IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL OR NEW.resend_error_name IS NOT NULL THEN
      RAISE EXCEPTION 'attempt must be inserted unrecorded (recorded_at + all outcome fields NULL)';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
      RAISE EXCEPTION 'notification_digest_attempts: direct delete forbidden (leaves only via group cascade)';
    END IF;
    RETURN OLD;   -- parent group already gone → genuine cascade
  END IF;
  -- the FK SET NULL of a purged run's back-reference (worker_run_id → NULL, run gone, nothing else changed)
  IF OLD.worker_run_id IS NOT NULL AND NEW.worker_run_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notification_worker_runs WHERE run_id = OLD.worker_run_id)
     AND ROW(NEW.attempt_id, NEW.digest_group_id, NEW.provider_idempotency_key, NEW.started_at,
             NEW.outcome_class, NEW.recorded_at, NEW.http_status, NEW.resend_error_name, NEW.provider_message_id)
       IS NOT DISTINCT FROM
         ROW(OLD.attempt_id, OLD.digest_group_id, OLD.provider_idempotency_key, OLD.started_at,
             OLD.outcome_class, OLD.recorded_at, OLD.http_status, OLD.resend_error_name, OLD.provider_message_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'attempt % already recorded; outcomes are immutable', OLD.attempt_id;
  END IF;
  IF NEW.recorded_at IS NULL THEN
    RAISE EXCEPTION 'attempt update must set recorded_at (the sole NULL->recorded transition)';
  END IF;
  IF NEW.outcome_class IS NULL THEN
    RAISE EXCEPTION 'recording an attempt requires a non-null outcome_class';
  END IF;
  IF NEW.attempt_id <> OLD.attempt_id OR NEW.digest_group_id <> OLD.digest_group_id
     OR NEW.worker_run_id IS DISTINCT FROM OLD.worker_run_id
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'attempt identity/request/worker_run fields are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_digest_attempts_guard ON public.notification_digest_attempts;
CREATE TRIGGER trg_digest_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_digest_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notification_digest_attempts_guard();

-- worker_runs: born unfinished with a SCHEMA-OWNED started_at (forced now()); finish stamps a schema-owned
-- ended_at (forced now(), never a caller value → the retention clock can't be backdated); identity immutable;
-- deletable only once finished AND >= 90 days old. Nothing cascades into worker_runs, so no depth bypass.
CREATE OR REPLACE FUNCTION public.notification_worker_runs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.status IS NOT NULL THEN
      RAISE EXCEPTION 'worker run must be inserted unfinished (status + ended_at NULL)';
    END IF;
    NEW.started_at := now();   -- schema-owned run-start clock
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.ended_at IS NULL THEN RAISE EXCEPTION 'cannot delete an unfinished worker run %', OLD.run_id; END IF;
    IF OLD.ended_at > now() - interval '90 days' THEN
      RAISE EXCEPTION 'worker run % has not reached the 90-day retention age', OLD.run_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'worker run % already finished', OLD.run_id; END IF;
  IF NEW.status IS NULL OR NEW.status NOT IN ('succeeded','failed','abandoned') THEN
    RAISE EXCEPTION 'worker run finish must set a valid status';
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.worker <> OLD.worker OR NEW.channel <> OLD.channel
     OR NEW.phase <> OLD.phase OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'worker run identity is immutable';
  END IF;
  NEW.ended_at := now();   -- schema-owned run-end clock (always >= the schema-owned started_at)
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_worker_runs_guard ON public.notification_worker_runs;
CREATE TRIGGER trg_worker_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_worker_runs
  FOR EACH ROW EXECUTE FUNCTION public.notification_worker_runs_guard();

-- groups: identity + boundary immutable, provider_message_id write-once; terminal_at is the SCHEMA-OWNED
-- retention clock (stamped on entry into a terminal state, frozen after — callers can never set/backdate it).
-- Terminal groups CANNOT be reopened (terminal→nonterminal rejected); a late terminal→terminal transition
-- keeps the original clock. Deletable only when terminal AND >= 90 days old. NO depth bypass: nothing cascades
-- into a group row, and the only FK-driven updates (parent/superseded/worker_run SET NULL) pass every check
-- below unchanged, so a nested attacker cannot slip past them.
CREATE OR REPLACE FUNCTION public.notification_digest_groups_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
DECLARE terminal_states text[] :=
  ARRAY['sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.terminal_at := CASE WHEN NEW.state = ANY(terminal_states) THEN now() ELSE NULL END;  -- forced, never trusted
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT (OLD.state = ANY(terminal_states)) THEN
      RAISE EXCEPTION 'digest group % is not terminal; only retention-eligible groups may be deleted', OLD.id;
    END IF;
    IF OLD.terminal_at IS NULL OR OLD.terminal_at > now() - interval '90 days' THEN
      RAISE EXCEPTION 'digest group % has not reached the 90-day retention age', OLD.id;
    END IF;
    UPDATE public.notification_provider_circuit
       SET probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL
     WHERE probe_group_id = OLD.id;
    RETURN OLD;
  END IF;
  IF NEW.canonical_group_key IS DISTINCT FROM OLD.canonical_group_key
     OR NEW.group_key_hash IS DISTINCT FROM OLD.group_key_hash
     OR NEW.chunk_ordinal IS DISTINCT FROM OLD.chunk_ordinal
     OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.recipient_key IS DISTINCT FROM OLD.recipient_key
     OR NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint
     OR NEW.tenant_academy_profile_id IS DISTINCT FROM OLD.tenant_academy_profile_id
     OR NEW.tenant_trainer_id IS DISTINCT FROM OLD.tenant_trainer_id
     OR NEW.recipient_timezone IS DISTINCT FROM OLD.recipient_timezone
     OR NEW.digest_boundary_at IS DISTINCT FROM OLD.digest_boundary_at THEN
    RAISE EXCEPTION 'digest group canonical identity/boundary is immutable after insert';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'digest group provider_message_id is write-once';
  END IF;
  IF (OLD.state = ANY(terminal_states)) AND NOT (NEW.state = ANY(terminal_states)) THEN
    RAISE EXCEPTION 'digest group % is terminal (%); cannot reopen to %', OLD.id, OLD.state, NEW.state;
  END IF;
  -- schema-owned retention clock: stamp on entry into terminal, freeze while terminal, clear if it leaves.
  IF (NEW.state = ANY(terminal_states)) AND NOT (OLD.state = ANY(terminal_states)) THEN
    NEW.terminal_at := now();
  ELSIF (NEW.state = ANY(terminal_states)) THEN
    NEW.terminal_at := OLD.terminal_at;   -- late terminal→terminal evidence keeps the original clock
  ELSE
    NEW.terminal_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_digest_groups_guard ON public.notification_digest_groups;
CREATE TRIGGER trg_digest_groups_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_digest_groups
  FOR EACH ROW EXECUTE FUNCTION public.notification_digest_groups_guard();

-- reservations: identity/bucket immutable, originating attempt_id write-once. Delete: a genuine group cascade
-- (group gone) OR a settled (non-'reserved') row via retention; a live 'reserved' row can never be deleted.
-- No FK sets a reservation column, so every UPDATE is a direct app update — no depth bypass.
CREATE OR REPLACE FUNCTION public.notification_send_reservations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
      RETURN OLD;   -- group already gone → genuine cascade
    END IF;
    IF OLD.state = 'reserved' THEN
      RAISE EXCEPTION 'cannot directly delete a live (reserved) reservation for group %', OLD.digest_group_id;
    END IF;
    RETURN OLD;   -- settled retention delete (group still terminal)
  END IF;
  IF NEW.digest_group_id IS DISTINCT FROM OLD.digest_group_id OR NEW.counter_key IS DISTINCT FROM OLD.counter_key
     OR NEW.bucket_start IS DISTINCT FROM OLD.bucket_start THEN
    RAISE EXCEPTION 'reservation identity/bucket is immutable';
  END IF;
  IF OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id THEN
    RAISE EXCEPTION 'reservation originating attempt_id is write-once';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reservations_guard ON public.notification_send_reservations;
CREATE TRIGGER trg_reservations_guard BEFORE UPDATE OR DELETE ON public.notification_send_reservations
  FOR EACH ROW EXECUTE FUNCTION public.notification_send_reservations_guard();

-- ledger: append-only. The only permitted UPDATE is the worker_run_id→NULL SET NULL of a PURGED run; the only
-- permitted DELETE is a genuine group cascade (group gone). Both proven by FK precondition, not depth.
CREATE OR REPLACE FUNCTION public.notification_ledger_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
      RAISE EXCEPTION 'notification_digest_group_attempts: append-only, direct delete forbidden';
    END IF;
    RETURN OLD;   -- parent group gone → cascade
  END IF;
  IF OLD.worker_run_id IS NOT NULL AND NEW.worker_run_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.notification_worker_runs WHERE run_id = OLD.worker_run_id)
     AND ROW(NEW.event_id, NEW.seq, NEW.digest_group_id, NEW.attempt_id, NEW.action, NEW.item_count, NEW.occurred_at)
       IS NOT DISTINCT FROM
         ROW(OLD.event_id, OLD.seq, OLD.digest_group_id, OLD.attempt_id, OLD.action, OLD.item_count, OLD.occurred_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notification_digest_group_attempts: append-only, no direct updates';
END $$;
DROP TRIGGER IF EXISTS trg_ledger_append_only ON public.notification_digest_group_attempts;
DROP TRIGGER IF EXISTS trg_ledger_guard ON public.notification_digest_group_attempts;
CREATE TRIGGER trg_ledger_guard BEFORE UPDATE OR DELETE ON public.notification_digest_group_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notification_ledger_guard();

-- provider events: received_at is a SCHEMA-OWNED receipt clock (forced now() at INSERT; occurred_at stays the
-- provider's own timestamp). Append-only EXCEPT one controlled orphan→group link (NULL→group; callback fields
-- immutable; composite FK enforces the (group,message) match) reachable only via the SECURITY DEFINER RPC.
-- Delete: a genuine group cascade (group gone) OR a STALE unlinked orphan (>= 90-day AUDIT window, ADR §PV).
CREATE OR REPLACE FUNCTION public.notification_provider_events_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.received_at := now();   -- schema-owned receipt clock (no backdating)
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.digest_group_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
        RAISE EXCEPTION 'linked provider event % leaves only via group cascade', OLD.resend_event_id;
      END IF;
      RETURN OLD;   -- group gone → cascade
    END IF;
    IF OLD.received_at > now() - interval '90 days' THEN
      RAISE EXCEPTION 'orphan provider event % is not yet stale (90-day audit retention)', OLD.resend_event_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.digest_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'provider event % already linked; callbacks are append-only', OLD.resend_event_id;
  END IF;
  IF NEW.digest_group_id IS NULL THEN
    RAISE EXCEPTION 'provider event update may only LINK an orphan to a group (NULL->group)';
  END IF;
  IF NEW.resend_event_id <> OLD.resend_event_id OR NEW.provider_message_id <> OLD.provider_message_id
     OR NEW.status <> OLD.status OR NEW.occurred_at <> OLD.occurred_at OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'provider event callback fields are immutable; only NULL->group linking is allowed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_provider_events_append_only ON public.notification_provider_events;
DROP TRIGGER IF EXISTS trg_provider_events_guard ON public.notification_provider_events;
CREATE TRIGGER trg_provider_events_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.notification_provider_events_guard();

-- the one sanctioned orphan→group link (service-role SECURITY DEFINER). RETRY-IDEMPOTENT: re-linking the same
-- event to the SAME group is a successful no-op (at-least-once webhooks); a DIFFERENT group is rejected. The
-- composite FK additionally rejects a group whose provider_message_id ≠ the event's.
CREATE OR REPLACE FUNCTION public.link_notification_provider_event(p_resend_event_id text, p_digest_group_id uuid)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current uuid;
BEGIN
  SELECT digest_group_id INTO v_current
    FROM public.notification_provider_events WHERE resend_event_id = p_resend_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider event % not found', p_resend_event_id;
  END IF;
  IF v_current IS NOT NULL THEN
    IF v_current = p_digest_group_id THEN RETURN true; END IF;   -- idempotent retry
    RAISE EXCEPTION 'provider event % already linked to a different group', p_resend_event_id;
  END IF;
  UPDATE public.notification_provider_events
     SET digest_group_id = p_digest_group_id WHERE resend_event_id = p_resend_event_id;
  RETURN true;
END $$;

-- outbox snapshot columns are write-once (enforced for EVERY caller, nested or not); digest_group_id may
-- attach (NULL→id) at top level and detach (id→NULL) ONLY as the retention FK SET NULL, proven by the group
-- already being gone. No re-point. No blanket depth bypass — a nested trigger cannot mutate a member row.
CREATE OR REPLACE FUNCTION public.notification_outbox_snapshot_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (OLD.delivery_mode           IS NOT NULL AND NEW.delivery_mode           IS DISTINCT FROM OLD.delivery_mode)
   OR (OLD.recipient_key          IS NOT NULL AND NEW.recipient_key          IS DISTINCT FROM OLD.recipient_key)
   OR (OLD.digest_frequency       IS NOT NULL AND NEW.digest_frequency       IS DISTINCT FROM OLD.digest_frequency)
   OR (OLD.group_locale           IS NOT NULL AND NEW.group_locale           IS DISTINCT FROM OLD.group_locale)
   OR (OLD.recipient_timezone     IS NOT NULL AND NEW.recipient_timezone     IS DISTINCT FROM OLD.recipient_timezone)
   OR (OLD.digest_boundary_at     IS NOT NULL AND NEW.digest_boundary_at     IS DISTINCT FROM OLD.digest_boundary_at)
   OR (OLD.template_version       IS NOT NULL AND NEW.template_version       IS DISTINCT FROM OLD.template_version)
   OR (OLD.destination_fingerprint IS NOT NULL AND NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint) THEN
    RAISE EXCEPTION 'notification_outbox digest snapshot fields are write-once';
  END IF;
  IF OLD.digest_group_id IS NOT NULL AND NEW.digest_group_id IS DISTINCT FROM OLD.digest_group_id THEN
    IF NEW.digest_group_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
      NULL;   -- the group is gone → this is the retention FK SET NULL detach
    ELSE
      RAISE EXCEPTION 'notification_outbox.digest_group_id may only detach via retention cascade, never directly';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_outbox_snapshot_guard ON public.notification_outbox;
CREATE TRIGGER trg_outbox_snapshot_guard BEFORE UPDATE ON public.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.notification_outbox_snapshot_guard();

-- ===========================================================================
-- 12. Controlled, bounded, resumable retention (ADR §RET). SECURITY DEFINER → deletes with the table
--     owner's privilege (no role holds service_role DELETE). Enforces the ADR's fixed policy windows
--     (group >= 90 days, counter >= 35 days) and a hard batch cap (1..10000) so no caller can widen the
--     clock or recreate an unbounded transaction. Group retention keys on the SCHEMA-OWNED terminal_at
--     (never the caller-mutable updated_at), reservation retention on the group's terminal_at. Deletes in
--     deterministic, bounded, SKIP LOCKED batches and RETURNS per-table counts so the cron loops until all
--     are 0. Order preserves reservations: settled reservations of terminal groups first → unreferenced old
--     counters → terminal old groups (cascade audit) → finished old runs → stale unlinked provider orphans.
CREATE OR REPLACE FUNCTION public.purge_notification_digest(
    p_group_days int DEFAULT 90, p_counter_days int DEFAULT 35, p_limit int DEFAULT 500)
  RETURNS TABLE (reservations_deleted int, counters_deleted int, groups_deleted int, runs_deleted int, orphan_events_deleted int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res int; v_cnt int; v_grp int; v_run int; v_orph int;
BEGIN
  IF p_group_days < 90 OR p_counter_days < 35 OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'purge_notification_digest: require group_days>=90, counter_days>=35, 1<=limit<=10000 (got group=%, counter=%, limit=%)',
      p_group_days, p_counter_days, p_limit;
  END IF;

  WITH victims AS (
    SELECT r.digest_group_id, r.counter_key
      FROM public.notification_send_reservations r
      JOIN public.notification_digest_groups g ON g.id = r.digest_group_id
     WHERE r.state IN ('committed','released')
       AND g.state IN ('sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded')
       AND g.terminal_at IS NOT NULL AND g.terminal_at < now() - make_interval(days => p_counter_days)
     ORDER BY g.terminal_at, r.digest_group_id, r.counter_key
     LIMIT p_limit FOR UPDATE OF r SKIP LOCKED)
  DELETE FROM public.notification_send_reservations r USING victims v
   WHERE r.digest_group_id = v.digest_group_id AND r.counter_key = v.counter_key;
  GET DIAGNOSTICS v_res = ROW_COUNT;

  WITH victims AS (
    SELECT c.counter_key FROM public.notification_send_counters c
     WHERE c.bucket_start < now() - make_interval(days => p_counter_days)
       AND NOT EXISTS (SELECT 1 FROM public.notification_send_reservations r WHERE r.counter_key = c.counter_key)
     ORDER BY c.bucket_start, c.counter_key
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.notification_send_counters c USING victims v WHERE c.counter_key = v.counter_key;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;

  WITH victims AS (
    SELECT g.id FROM public.notification_digest_groups g
     WHERE g.state IN ('sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded')
       AND g.terminal_at IS NOT NULL AND g.terminal_at < now() - make_interval(days => p_group_days)
     ORDER BY g.terminal_at, g.id
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.notification_digest_groups g USING victims v WHERE g.id = v.id;
  GET DIAGNOSTICS v_grp = ROW_COUNT;

  WITH victims AS (
    SELECT w.run_id FROM public.notification_worker_runs w
     WHERE w.ended_at IS NOT NULL AND w.ended_at < now() - make_interval(days => p_group_days)
     ORDER BY w.ended_at, w.run_id
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.notification_worker_runs w USING victims v WHERE w.run_id = v.run_id;
  GET DIAGNOSTICS v_run = ROW_COUNT;

  WITH victims AS (   -- provider events are AUDIT data: stale unlinked orphans use the 90-day group window
    SELECT e.resend_event_id FROM public.notification_provider_events e
     WHERE e.digest_group_id IS NULL AND e.received_at < now() - make_interval(days => p_group_days)
     ORDER BY e.received_at, e.resend_event_id
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.notification_provider_events e USING victims v WHERE e.resend_event_id = v.resend_event_id;
  GET DIAGNOSTICS v_orph = ROW_COUNT;

  reservations_deleted := v_res; counters_deleted := v_cnt; groups_deleted := v_grp;
  runs_deleted := v_run; orphan_events_deleted := v_orph;
  RETURN NEXT;
END $$;

-- ===========================================================================
-- 13. RLS + ACL. Every new table: RLS on + FORCE, NO policy, REVOKE PUBLIC/anon/authenticated. service_role
--     gets INSERT/SELECT everywhere, UPDATE only where the state machine mutates rows, and DELETE NOWHERE —
--     the sole deletion path is purge_notification_digest() (owner privilege) + its FK cascades.
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

GRANT INSERT, SELECT ON public.notification_digest_group_attempts TO service_role;  -- append-only
GRANT INSERT, SELECT ON public.notification_provider_events        TO service_role;  -- append-only
GRANT INSERT, SELECT, UPDATE ON public.notification_digest_attempts TO service_role; -- record transition
GRANT INSERT, SELECT, UPDATE ON public.notification_worker_runs        TO service_role; -- finish transition
GRANT INSERT, SELECT, UPDATE ON public.notification_digest_groups      TO service_role; -- state machine
GRANT INSERT, SELECT, UPDATE ON public.notification_provider_circuit   TO service_role; -- breaker
GRANT INSERT, SELECT, UPDATE ON public.notification_send_counters      TO service_role; -- caps
GRANT INSERT, SELECT, UPDATE ON public.notification_send_reservations  TO service_role; -- reservations

REVOKE ALL ON FUNCTION public.purge_notification_digest(int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_notification_digest(int, int, int) TO service_role;
REVOKE ALL ON FUNCTION public.link_notification_provider_event(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_notification_provider_event(text, uuid) TO service_role;
