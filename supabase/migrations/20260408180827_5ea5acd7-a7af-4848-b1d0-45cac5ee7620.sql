
CREATE TABLE public.challenge_suggestions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'both',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  skill_benefit TEXT,
  submitter_name TEXT,
  submitter_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.challenge_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit challenge suggestions"
  ON public.challenge_suggestions
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Admins can view challenge suggestions"
  ON public.challenge_suggestions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can update challenge suggestions"
  ON public.challenge_suggestions
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()));
