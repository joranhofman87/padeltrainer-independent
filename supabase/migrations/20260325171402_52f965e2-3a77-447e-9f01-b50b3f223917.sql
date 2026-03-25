
CREATE TABLE public.extra_cost_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  description text NOT NULL,
  price numeric NOT NULL DEFAULT 0,
  vat_rate numeric NOT NULL DEFAULT 21,
  type text NOT NULL DEFAULT 'per_session',
  created_at timestamptz DEFAULT now(),
  CONSTRAINT owner_check CHECK (
    (trainer_id IS NOT NULL AND academy_profile_id IS NULL) OR
    (trainer_id IS NULL AND academy_profile_id IS NOT NULL)
  )
);

ALTER TABLE public.extra_cost_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trainers can manage own presets"
ON public.extra_cost_presets
FOR ALL
TO authenticated
USING (
  trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
)
WITH CHECK (
  trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
);

CREATE POLICY "Academy managers can manage presets"
ON public.extra_cost_presets
FOR ALL
TO authenticated
USING (
  academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
)
WITH CHECK (
  academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
);
