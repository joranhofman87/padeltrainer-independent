-- SPICED trainer onboarding responses (Phase 1: schema only)
-- One row per trainer_profile; separate from legacy trainer_onboarding progress table.

CREATE TABLE public.trainer_onboarding_responses (
  trainer_profile_id      UUID PRIMARY KEY REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,

  -- Situation
  trainer_type            TEXT CHECK (trainer_type IN ('independent','club_trainer','academy_owner')),
  lessons_per_week_range  TEXT CHECK (lessons_per_week_range IN ('none','1-5','6-15','16-30','30+')),
  player_count_range      TEXT CHECK (player_count_range IN ('0','1-10','11-30','30+')),
  primary_city            TEXT,

  -- Pain + Impact
  primary_pains           TEXT[],
  admin_hours_per_week    TEXT CHECK (admin_hours_per_week IN ('<1','1-3','3-6','6+')),

  -- Critical Event
  target_live_window      TEXT CHECK (target_live_window IN ('this_week','two_weeks','one_month','exploring')),
  target_live_date        DATE,
  critical_event_note     TEXT,

  -- Decision, captured progressively after onboarding
  decision_makers         TEXT[],
  previous_tools          TEXT[],
  decision_criteria       TEXT[],

  -- Lifecycle
  completed_at            TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trainer_onboarding_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trainer_can_read_own_responses"
  ON public.trainer_onboarding_responses
  FOR SELECT TO authenticated
  USING (
    trainer_profile_id IN (
      SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "trainer_can_insert_own_responses"
  ON public.trainer_onboarding_responses
  FOR INSERT TO authenticated
  WITH CHECK (
    trainer_profile_id IN (
      SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "trainer_can_update_own_responses"
  ON public.trainer_onboarding_responses
  FOR UPDATE TO authenticated
  USING (
    trainer_profile_id IN (
      SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    trainer_profile_id IN (
      SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "admins_read_all_responses"
  ON public.trainer_onboarding_responses
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_onboarding_responses_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_onboarding_responses_updated_at
  BEFORE UPDATE ON public.trainer_onboarding_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_onboarding_responses_updated_at();
