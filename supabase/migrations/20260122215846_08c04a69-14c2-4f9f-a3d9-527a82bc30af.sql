-- Make phone nullable in guest_players
ALTER TABLE public.guest_players ALTER COLUMN phone DROP NOT NULL;