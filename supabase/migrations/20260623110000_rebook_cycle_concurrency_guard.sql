-- Concurrency guard for the rebook engine. Two simultaneous runs (e.g. a double
-- submit, or two managers) could both pass the check-then-insert re-run guard and
-- create duplicate rounds + double invites. A partial UNIQUE index serializes the
-- draft-cycle insert so the second run fails with SQLSTATE 23505 — which
-- bulk-rebook-cycle catches and returns as { reason: 'already_exists' }.
--
-- Scoped to REBOOK-generated cycles only (settings.rebook_payment_mode is set) and
-- to draft/open status, so it never constrains registration/event cycles or old
-- closed/archived rounds. Additive (CREATE INDEX, no DROP).
--
-- Guarded so it can never fail the apply: if any pre-existing duplicates would
-- violate it, the index is skipped and the app-level guard remains the fallback.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.cycles
    WHERE (settings->>'rebook_payment_mode') IS NOT NULL
      AND status IN ('draft', 'open')
    GROUP BY owner_type, owner_id, name, start_date
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'uniq_rebook_cycle_key skipped: pre-existing duplicate rebook cycles present';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_rebook_cycle_key
      ON public.cycles (owner_type, owner_id, name, start_date)
      WHERE (settings->>'rebook_payment_mode') IS NOT NULL
        AND status IN ('draft', 'open');
  END IF;
END $$;
