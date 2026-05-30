-- Repair: public.session_reports was never committed before 20260406093735
-- Idempotent schema-only fix. No data changes.
-- Omits public_notes (added by 20260406093735).
-- Skips entirely when public.session_reports already exists.

CREATE TABLE IF NOT EXISTS public.session_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL,
  reporter_role text NOT NULL,
  session_happened boolean NOT NULL DEFAULT true,
  attendees text[],
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (slot_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_session_reports_slot_id
  ON public.session_reports (slot_id);

DO $$
BEGIN
  IF to_regclass('public.session_reports') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'session_reports'
         AND t.tgname = 'update_session_reports_updated_at'
     )
  THEN
    CREATE TRIGGER update_session_reports_updated_at
      BEFORE UPDATE ON public.session_reports
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;
