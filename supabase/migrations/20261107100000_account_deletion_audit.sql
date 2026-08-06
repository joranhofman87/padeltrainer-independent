-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- A1-A7 REVIEW ROUND 2 (P2) — deletion evidence that survives the deletion.
--
-- Self-service account deletion was audited into `admin_impersonation_logs`, whose `admin_user_id`
-- and `target_user_id` both reference `auth.users` ON DELETE CASCADE. For a self-deletion both are
-- the same person, so the audit row is destroyed by the very act it records. Moving the insert to
-- BEFORE the deletion (the previous correction) did not help: it made the row exist only when the
-- deletion FAILED — evidence that is present exactly when nothing happened and absent exactly when
-- something did.
--
-- So the evidence gets its own table, and the ids are plain columns with NO foreign key. That is
-- deliberate, not an oversight: the whole point is to outlive the row they refer to. A deletion
-- audit that cascades is not an audit.
--
-- Two-phase, so the record is honest about outcome: `started` is written before any data is
-- touched, and `completed` only after the auth account is actually gone. A row left at `started`
-- is a deletion that began and did not finish — precisely the state an operator needs to find.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.account_deletion_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NO FK, on purpose: this row must outlive the user it names.
  subject_user_id  uuid NOT NULL,
  actor_user_id    uuid NOT NULL,
  self_service     boolean NOT NULL,
  subject_email    text,
  subject_name     text,
  status        text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  failure_reason text,
  ip_address    text,
  user_agent    text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT chk_account_deletion_audit_coherent CHECK (
    (status = 'started'   AND finished_at IS NULL AND failure_reason IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND failure_reason IS NULL)
    OR (status = 'failed'    AND finished_at IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

COMMENT ON TABLE public.account_deletion_audit IS
  'Durable evidence of account deletions. The user ids are deliberately FK-free so a row outlives the account it records — an audit that cascades with its subject is not an audit. Two-phase: started before anything is touched, completed only after the auth account is gone, failed with a reason otherwise. A row stuck at started is a deletion that began and did not finish.';

-- APPEND-ONLY and OWNER-EFFECTIVE: a definer function or a later migration runs as the owner, so
-- the immutability has to be a trigger rather than the discipline of whoever writes the next one.
CREATE OR REPLACE FUNCTION public.account_deletion_audit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'account_deletion_audit is append-only: erasing the record of an erasure is the one thing it exists to prevent';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- exactly one transition, once: started -> completed | failed
    IF OLD.status <> 'started' THEN
      RAISE EXCEPTION 'account_deletion_audit %: already %', OLD.id, OLD.status;
    END IF;
    IF NEW.status NOT IN ('completed', 'failed') THEN
      RAISE EXCEPTION 'account_deletion_audit: the only transitions are started -> completed | failed';
    END IF;
    IF NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.self_service  IS DISTINCT FROM OLD.self_service
       OR NEW.started_at    IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'account_deletion_audit: the identity and start of a deletion are immutable';
    END IF;
    NEW.finished_at := now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_account_deletion_audit_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_deletion_audit
  FOR EACH ROW EXECUTE FUNCTION public.account_deletion_audit_guard();
CREATE TRIGGER trg_account_deletion_audit_no_truncate
  BEFORE TRUNCATE ON public.account_deletion_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.account_deletion_audit_guard();

ALTER TABLE public.account_deletion_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.account_deletion_audit TO service_role;

CREATE POLICY "admins read account deletion audit" ON public.account_deletion_audit
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_account_deletion_audit_unfinished
  ON public.account_deletion_audit (started_at) WHERE status = 'started';
