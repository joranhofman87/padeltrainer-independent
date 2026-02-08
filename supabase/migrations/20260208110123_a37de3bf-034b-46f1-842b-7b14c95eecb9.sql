
-- Create trainer_onboarding table for persisting onboarding progress
CREATE TABLE public.trainer_onboarding (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  current_step integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  goal text,
  goal_other_text text,
  followup_answer text,
  icd_responses jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.trainer_onboarding ENABLE ROW LEVEL SECURITY;

-- Users can only read their own onboarding row
CREATE POLICY "Users can view their own onboarding"
  ON public.trainer_onboarding
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own onboarding row
CREATE POLICY "Users can create their own onboarding"
  ON public.trainer_onboarding
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own onboarding row
CREATE POLICY "Users can update their own onboarding"
  ON public.trainer_onboarding
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Admins can read all
CREATE POLICY "Admins can view all onboarding"
  ON public.trainer_onboarding
  FOR SELECT
  USING (public.is_admin(auth.uid()));

-- Auto-update updated_at
CREATE TRIGGER update_trainer_onboarding_updated_at
  BEFORE UPDATE ON public.trainer_onboarding
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
