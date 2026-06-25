-- Phase 2 Step 1 (ADDITIVE + INERT): the `registrations` table = the intake-FORM half of the
-- registration↔cycle split. It is EMPTY until the Phase 2 backfill; the nullable `registration_id`
-- columns sit ALONGSIDE the existing `cycle_id` (never replacing it). No existing row is touched,
-- so there is zero behaviour change until the dual-read code + backfill land.
--
-- See docs/PHASE2_REGISTRATIONS_SPLIT.md. RLS mirrors `cycles` (20260123104639) exactly.

CREATE TABLE IF NOT EXISTS public.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the cycle this form was split out of = the training cycle that owns the slots/bookings.
  source_cycle_id uuid NOT NULL REFERENCES public.cycles(id) ON DELETE RESTRICT,
  owner_type text NOT NULL CHECK (owner_type IN ('trainer', 'club', 'academy')),
  owner_id uuid NOT NULL,
  format text NOT NULL DEFAULT 'registration' CHECK (format IN ('registration', 'event')),
  name text NOT NULL,
  description text,
  enrollment_deadline timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  total_price numeric(10, 2),
  currency text NOT NULL DEFAULT 'EUR',
  price_table jsonb,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,  -- intake-form config keys only (see the Phase 2 spec)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One registration per source cycle → idempotent backfill + a clean 1:1 mapping.
CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_source_cycle ON public.registrations(source_cycle_id);
CREATE INDEX IF NOT EXISTS idx_registrations_owner ON public.registrations(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON public.registrations(status);

DROP TRIGGER IF EXISTS update_registrations_updated_at ON public.registrations;
CREATE TRIGGER update_registrations_updated_at
  BEFORE UPDATE ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;

-- RLS — same owner model as `cycles`. Clubs are read-only in the UI (no club create/edit surfaces),
-- but the policy stays symmetric with cycles; the UI is what gates "clubs don't create/edit".
CREATE POLICY "Anyone can view open registrations"
  ON public.registrations FOR SELECT
  USING (status = 'open');

CREATE POLICY "Trainers manage their own registrations"
  ON public.registrations FOR ALL
  USING (owner_type = 'trainer' AND owner_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()))
  WITH CHECK (owner_type = 'trainer' AND owner_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Academy managers manage their academy registrations"
  ON public.registrations FOR ALL
  USING (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())))
  WITH CHECK (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())));

CREATE POLICY "Club managers manage their club registrations"
  ON public.registrations FOR ALL
  USING (owner_type = 'club' AND owner_id IN (SELECT get_user_club_ids(auth.uid())))
  WITH CHECK (owner_type = 'club' AND owner_id IN (SELECT get_user_club_ids(auth.uid())));

-- Additive links — NULLABLE, backfilled in Phase 2 Step 3; the existing `cycle_id` stays.
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS registration_id uuid REFERENCES public.registrations(id) ON DELETE SET NULL;
ALTER TABLE public.intake_requests ADD COLUMN IF NOT EXISTS registration_id uuid REFERENCES public.registrations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_registration_id        ON public.invoices(registration_id);
CREATE INDEX IF NOT EXISTS idx_intake_requests_registration_id ON public.intake_requests(registration_id);
