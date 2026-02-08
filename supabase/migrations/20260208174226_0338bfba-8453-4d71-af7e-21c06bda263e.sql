
-- Allow academy managers to insert trainer_locations for their academy trainers
CREATE POLICY "Academy managers can insert trainer locations"
ON public.trainer_locations
FOR INSERT
WITH CHECK (
  public.is_academy_trainer(auth.uid(), trainer_id)
);

-- Allow academy managers to delete trainer_locations for their academy trainers
CREATE POLICY "Academy managers can delete trainer locations"
ON public.trainer_locations
FOR DELETE
USING (
  public.is_academy_trainer(auth.uid(), trainer_id)
);
