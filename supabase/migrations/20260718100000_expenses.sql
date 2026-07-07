-- ============================================================================
-- Expenses — money-OUT tracking for academy owners + independent trainers
-- ============================================================================
-- The app tracks money IN (invoices / paid bookings) but had no "money spent" data.
-- This table lets an academy owner or an independent trainer log expenses (court
-- rental, trainer payouts, marketing, …) so the dashboard money chart can show
-- money-in vs money-out vs profit. One row is owned by EXACTLY ONE of an academy or a
-- trainer (never both, never neither). Categories are free-ish text validated by a
-- shared TS enum + i18n labels (kept flexible, not a DB enum).
-- ============================================================================

CREATE TABLE public.expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  trainer_id         uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  expense_date       date NOT NULL,
  amount             numeric NOT NULL CHECK (amount > 0),
  category           text NOT NULL,
  description        text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Exactly one owner (academy XOR trainer).
  CONSTRAINT expenses_one_owner CHECK ((academy_profile_id IS NOT NULL) <> (trainer_id IS NOT NULL))
);

CREATE INDEX idx_expenses_academy_date ON public.expenses (academy_profile_id, expense_date);
CREATE INDEX idx_expenses_trainer_date ON public.expenses (trainer_id, expense_date);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- Academy managers manage their own academy's expenses (is_academy_manager gate).
CREATE POLICY "Academy managers select expenses" ON public.expenses FOR SELECT TO authenticated
  USING (academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), academy_profile_id));
CREATE POLICY "Academy managers insert expenses" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), academy_profile_id));
CREATE POLICY "Academy managers update expenses" ON public.expenses FOR UPDATE TO authenticated
  USING (academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), academy_profile_id))
  WITH CHECK (academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), academy_profile_id));
CREATE POLICY "Academy managers delete expenses" ON public.expenses FOR DELETE TO authenticated
  USING (academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), academy_profile_id));

-- Trainers manage their own expenses.
CREATE POLICY "Trainers select own expenses" ON public.expenses FOR SELECT TO authenticated
  USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));
CREATE POLICY "Trainers insert own expenses" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));
CREATE POLICY "Trainers update own expenses" ON public.expenses FOR UPDATE TO authenticated
  USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()))
  WITH CHECK (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));
CREATE POLICY "Trainers delete own expenses" ON public.expenses FOR DELETE TO authenticated
  USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

-- Admins manage all (support / ops).
CREATE POLICY "Admins manage expenses" ON public.expenses FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

CREATE TRIGGER update_expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.expenses IS
  'Money-out entries owned by exactly one of an academy (academy_profile_id) or an independent trainer (trainer_id). Powers the dashboard money chart (revenue vs expenses vs profit).';
