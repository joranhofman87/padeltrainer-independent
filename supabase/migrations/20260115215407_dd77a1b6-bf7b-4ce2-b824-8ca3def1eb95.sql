-- Create reviews table for player ratings of trainers
CREATE TABLE public.reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id UUID NOT NULL UNIQUE,
  player_id UUID NOT NULL,
  trainer_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  is_public BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- Players can view all public reviews
CREATE POLICY "Anyone can view public reviews"
ON public.reviews
FOR SELECT
USING (is_public = true);

-- Players can view their own reviews (even private)
CREATE POLICY "Players can view their own reviews"
ON public.reviews
FOR SELECT
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- Players can create reviews for their completed bookings
CREATE POLICY "Players can create reviews for their bookings"
ON public.reviews
FOR INSERT
WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- Players can update their own reviews
CREATE POLICY "Players can update their own reviews"
ON public.reviews
FOR UPDATE
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

-- Trainers can view reviews about them
CREATE POLICY "Trainers can view reviews about them"
ON public.reviews
FOR SELECT
USING (trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid()));

-- Create trigger for updated_at
CREATE TRIGGER update_reviews_updated_at
BEFORE UPDATE ON public.reviews
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();