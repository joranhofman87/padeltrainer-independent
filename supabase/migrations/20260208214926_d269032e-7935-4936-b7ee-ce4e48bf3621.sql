ALTER TABLE public.availability_slots
  ADD COLUMN price_per_session numeric DEFAULT NULL,
  ADD COLUMN total_price numeric DEFAULT NULL,
  ADD COLUMN allow_single_booking boolean DEFAULT false,
  ADD COLUMN min_participants integer DEFAULT NULL,
  ADD COLUMN max_participants integer DEFAULT NULL;