-- Create trainer working hours table
CREATE TABLE public.trainer_working_hours (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trainer_id UUID NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, day_of_week)
);

-- Add scheduling columns to trainer_profiles
ALTER TABLE public.trainer_profiles 
ADD COLUMN slot_duration_minutes INTEGER NOT NULL DEFAULT 60,
ADD COLUMN slot_gap_minutes INTEGER NOT NULL DEFAULT 0,
ADD COLUMN schedule_weeks_ahead INTEGER NOT NULL DEFAULT 4;

-- Enable RLS
ALTER TABLE public.trainer_working_hours ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Trainers can view their own working hours"
ON public.trainer_working_hours FOR SELECT
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can insert their own working hours"
ON public.trainer_working_hours FOR INSERT
WITH CHECK (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can update their own working hours"
ON public.trainer_working_hours FOR UPDATE
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can delete their own working hours"
ON public.trainer_working_hours FOR DELETE
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));