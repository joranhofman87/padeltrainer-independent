-- Create enums
CREATE TYPE public.player_level AS ENUM ('beginner', 'intermediate', 'advanced', 'pro');
CREATE TYPE public.play_frequency AS ENUM ('first_time', 'few_times', 'regularly', 'home_club');
CREATE TYPE public.review_status AS ENUM ('pending', 'approved', 'rejected');

-- Create court_reviews table
CREATE TABLE public.court_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating_surface SMALLINT NOT NULL CHECK (rating_surface BETWEEN 1 AND 5),
  rating_glass SMALLINT NOT NULL CHECK (rating_glass BETWEEN 1 AND 5),
  rating_lighting SMALLINT NOT NULL CHECK (rating_lighting BETWEEN 1 AND 5),
  rating_space SMALLINT NOT NULL CHECK (rating_space BETWEEN 1 AND 5),
  rating_changing_rooms SMALLINT NOT NULL CHECK (rating_changing_rooms BETWEEN 1 AND 5),
  rating_booking SMALLINT NOT NULL CHECK (rating_booking BETWEEN 1 AND 5),
  rating_value SMALLINT NOT NULL CHECK (rating_value BETWEEN 1 AND 5),
  rating_atmosphere SMALLINT NOT NULL CHECK (rating_atmosphere BETWEEN 1 AND 5),
  rating_parking SMALLINT NOT NULL CHECK (rating_parking BETWEEN 1 AND 5),
  rating_beginner_friendly SMALLINT NOT NULL CHECK (rating_beginner_friendly BETWEEN 1 AND 5),
  overall_rating NUMERIC(2,1) NOT NULL DEFAULT 0,
  best_thing TEXT CHECK (char_length(best_thing) <= 200),
  improvement TEXT CHECK (char_length(improvement) <= 200),
  player_level public.player_level,
  play_frequency public.play_frequency,
  status public.review_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (location_id, user_id)
);

-- Index for efficient lookups
CREATE INDEX idx_court_reviews_location_status ON public.court_reviews(location_id, status);
CREATE INDEX idx_court_reviews_user ON public.court_reviews(user_id);
CREATE INDEX idx_court_reviews_status ON public.court_reviews(status);

-- Auto-compute overall_rating on insert/update
CREATE OR REPLACE FUNCTION public.compute_court_review_overall()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.overall_rating := ROUND(
    (NEW.rating_surface + NEW.rating_glass + NEW.rating_lighting + NEW.rating_space +
     NEW.rating_changing_rooms + NEW.rating_booking + NEW.rating_value + NEW.rating_atmosphere +
     NEW.rating_parking + NEW.rating_beginner_friendly)::NUMERIC / 10, 1
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_overall_rating
BEFORE INSERT OR UPDATE ON public.court_reviews
FOR EACH ROW EXECUTE FUNCTION public.compute_court_review_overall();

-- Updated_at trigger
CREATE TRIGGER update_court_reviews_updated_at
BEFORE UPDATE ON public.court_reviews
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS
ALTER TABLE public.court_reviews ENABLE ROW LEVEL SECURITY;

-- Anyone can read approved reviews
CREATE POLICY "Anyone can read approved reviews"
ON public.court_reviews FOR SELECT
USING (status = 'approved' OR user_id = auth.uid() OR public.is_admin(auth.uid()));

-- Logged-in users can insert their own review
CREATE POLICY "Users can insert own reviews"
ON public.court_reviews FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Users can update their own pending reviews
CREATE POLICY "Users can update own pending reviews"
ON public.court_reviews FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND status = 'pending');

-- Admins can update any review (for moderation)
CREATE POLICY "Admins can update any review"
ON public.court_reviews FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Users can delete their own pending reviews
CREATE POLICY "Users can delete own pending reviews"
ON public.court_reviews FOR DELETE
TO authenticated
USING (auth.uid() = user_id AND status = 'pending');

-- Stats function
CREATE OR REPLACE FUNCTION public.get_location_review_stats(_location_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_build_object(
      'total_count', COUNT(*)::INT,
      'avg_overall', ROUND(AVG(overall_rating), 1),
      'avg_surface', ROUND(AVG(rating_surface), 1),
      'avg_glass', ROUND(AVG(rating_glass), 1),
      'avg_lighting', ROUND(AVG(rating_lighting), 1),
      'avg_space', ROUND(AVG(rating_space), 1),
      'avg_changing_rooms', ROUND(AVG(rating_changing_rooms), 1),
      'avg_booking', ROUND(AVG(rating_booking), 1),
      'avg_value', ROUND(AVG(rating_value), 1),
      'avg_atmosphere', ROUND(AVG(rating_atmosphere), 1),
      'avg_parking', ROUND(AVG(rating_parking), 1),
      'avg_beginner_friendly', ROUND(AVG(rating_beginner_friendly), 1)
    ),
    '{}'::jsonb
  )
  FROM public.court_reviews
  WHERE location_id = _location_id AND status = 'approved';
$$;