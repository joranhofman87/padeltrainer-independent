
-- Add RLS policies for academy cycles
CREATE POLICY "Academy managers can create academy cycles"
ON public.cycles FOR INSERT
WITH CHECK (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())));

CREATE POLICY "Academy managers can view their academy cycles"
ON public.cycles FOR SELECT
USING (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())));

CREATE POLICY "Academy managers can update academy cycles"
ON public.cycles FOR UPDATE
USING (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())));

CREATE POLICY "Academy managers can delete academy cycles"
ON public.cycles FOR DELETE
USING (owner_type = 'academy' AND owner_id IN (SELECT get_user_academy_ids(auth.uid())));
