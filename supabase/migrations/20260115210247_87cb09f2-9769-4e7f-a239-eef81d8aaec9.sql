-- Create lesson types table
CREATE TABLE public.lessons (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trainer_id UUID NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price NUMERIC NOT NULL,
  max_participants INTEGER NOT NULL DEFAULT 1,
  min_skill_rating NUMERIC,
  max_skill_rating NUMERIC,
  location TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create availability slots table
CREATE TABLE public.availability_slots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trainer_id UUID NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES public.lessons(id) ON DELETE SET NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence_rule TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create bookings table
CREATE TABLE public.bookings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slot_id UUID NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES public.lessons(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- Lessons policies
CREATE POLICY "Anyone can view active lessons"
ON public.lessons FOR SELECT
USING (is_active = true);

CREATE POLICY "Trainers can view their own lessons"
ON public.lessons FOR SELECT
USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can create their own lessons"
ON public.lessons FOR INSERT
WITH CHECK (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can update their own lessons"
ON public.lessons FOR UPDATE
USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can delete their own lessons"
ON public.lessons FOR DELETE
USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

-- Availability slots policies
CREATE POLICY "Anyone can view availability slots"
ON public.availability_slots FOR SELECT
USING (true);

CREATE POLICY "Trainers can create their own slots"
ON public.availability_slots FOR INSERT
WITH CHECK (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can update their own slots"
ON public.availability_slots FOR UPDATE
USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can delete their own slots"
ON public.availability_slots FOR DELETE
USING (trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()));

-- Bookings policies
CREATE POLICY "Players can view their own bookings"
ON public.bookings FOR SELECT
USING (player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can view bookings for their slots"
ON public.bookings FOR SELECT
USING (slot_id IN (
  SELECT id FROM public.availability_slots 
  WHERE trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
));

CREATE POLICY "Players can create bookings"
ON public.bookings FOR INSERT
WITH CHECK (player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can update their own bookings"
ON public.bookings FOR UPDATE
USING (player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

CREATE POLICY "Trainers can update bookings for their slots"
ON public.bookings FOR UPDATE
USING (slot_id IN (
  SELECT id FROM public.availability_slots 
  WHERE trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
));

-- Add triggers for updated_at
CREATE TRIGGER update_lessons_updated_at
BEFORE UPDATE ON public.lessons
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at
BEFORE UPDATE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();