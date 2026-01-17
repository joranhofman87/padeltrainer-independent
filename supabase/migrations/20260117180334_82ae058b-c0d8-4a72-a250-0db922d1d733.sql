-- Add foreign key constraint to reviews.trainer_id with CASCADE delete
ALTER TABLE public.reviews
ADD CONSTRAINT reviews_trainer_id_fkey
FOREIGN KEY (trainer_id) REFERENCES public.trainer_profiles(id)
ON DELETE CASCADE;

-- Add foreign key constraint to reviews.player_id with CASCADE delete
ALTER TABLE public.reviews
ADD CONSTRAINT reviews_player_id_fkey
FOREIGN KEY (player_id) REFERENCES public.profiles(id)
ON DELETE CASCADE;

-- Add foreign key constraint to trainer_followers.trainer_id with CASCADE delete
ALTER TABLE public.trainer_followers
ADD CONSTRAINT trainer_followers_trainer_id_fkey
FOREIGN KEY (trainer_id) REFERENCES public.trainer_profiles(id)
ON DELETE CASCADE;

-- Add foreign key constraint to trainer_followers.player_id with CASCADE delete
ALTER TABLE public.trainer_followers
ADD CONSTRAINT trainer_followers_player_id_fkey
FOREIGN KEY (player_id) REFERENCES public.profiles(id)
ON DELETE CASCADE;