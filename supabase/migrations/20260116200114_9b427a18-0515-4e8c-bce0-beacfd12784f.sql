-- Create guest_players table for trainer-managed players
CREATE TABLE public.guest_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  skill_rating numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  linked_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Enable RLS
ALTER TABLE public.guest_players ENABLE ROW LEVEL SECURITY;

-- RLS policies for guest_players
CREATE POLICY "Trainers can view their own guest players"
ON public.guest_players FOR SELECT
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can create their own guest players"
ON public.guest_players FOR INSERT
WITH CHECK (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can update their own guest players"
ON public.guest_players FOR UPDATE
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can delete their own guest players"
ON public.guest_players FOR DELETE
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

-- Add guest_player_id to bookings table
ALTER TABLE public.bookings ADD COLUMN guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL;

-- Make player_id nullable (was NOT NULL)
ALTER TABLE public.bookings ALTER COLUMN player_id DROP NOT NULL;

-- Add constraint: either player_id or guest_player_id must be set
ALTER TABLE public.bookings ADD CONSTRAINT booking_has_player 
CHECK (player_id IS NOT NULL OR guest_player_id IS NOT NULL);

-- Add RLS policy for trainers to create bookings for guest players
CREATE POLICY "Trainers can create bookings for their guest players"
ON public.bookings FOR INSERT
WITH CHECK (
  guest_player_id IS NOT NULL AND
  guest_player_id IN (
    SELECT gp.id FROM public.guest_players gp
    JOIN public.trainer_profiles tp ON gp.trainer_id = tp.id
    WHERE tp.user_id = auth.uid()
  )
);

-- Add RLS policy for trainers to view bookings with their guest players
CREATE POLICY "Trainers can view bookings for their guest players"
ON public.bookings FOR SELECT
USING (
  guest_player_id IS NOT NULL AND
  guest_player_id IN (
    SELECT gp.id FROM public.guest_players gp
    JOIN public.trainer_profiles tp ON gp.trainer_id = tp.id
    WHERE tp.user_id = auth.uid()
  )
);

-- Add RLS policy for trainers to update bookings with their guest players
CREATE POLICY "Trainers can update bookings for their guest players"
ON public.bookings FOR UPDATE
USING (
  guest_player_id IS NOT NULL AND
  guest_player_id IN (
    SELECT gp.id FROM public.guest_players gp
    JOIN public.trainer_profiles tp ON gp.trainer_id = tp.id
    WHERE tp.user_id = auth.uid()
  )
);

-- Trigger to update updated_at on guest_players
CREATE TRIGGER update_guest_players_updated_at
BEFORE UPDATE ON public.guest_players
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();