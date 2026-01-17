-- Add rating_system column to guest_players table
ALTER TABLE public.guest_players 
ADD COLUMN rating_system text NOT NULL DEFAULT 'knltb';

-- Add check constraint for valid rating systems
ALTER TABLE public.guest_players
ADD CONSTRAINT guest_players_valid_rating_system CHECK (rating_system IN ('knltb', 'playtomic'));