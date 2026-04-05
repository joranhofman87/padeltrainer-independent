
CREATE TABLE public.dismissed_slot_warnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid REFERENCES public.availability_slots(id) ON DELETE CASCADE NOT NULL,
  warning_type text NOT NULL,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.dismissed_slot_warnings ADD CONSTRAINT dismissed_slot_warnings_slot_type_unique UNIQUE (slot_id, warning_type);

ALTER TABLE public.dismissed_slot_warnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Academy managers can view dismissed warnings"
ON public.dismissed_slot_warnings
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM availability_slots s
    JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
    JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
    WHERE s.id = dismissed_slot_warnings.slot_id
    AND am.user_id = auth.uid()
  )
);

CREATE POLICY "Academy managers can dismiss warnings"
ON public.dismissed_slot_warnings
FOR INSERT
TO authenticated
WITH CHECK (
  dismissed_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM availability_slots s
    JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
    JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
    WHERE s.id = slot_id
    AND am.user_id = auth.uid()
  )
);

CREATE POLICY "Academy managers can un-dismiss warnings"
ON public.dismissed_slot_warnings
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM availability_slots s
    JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
    JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
    WHERE s.id = dismissed_slot_warnings.slot_id
    AND am.user_id = auth.uid()
  )
);
