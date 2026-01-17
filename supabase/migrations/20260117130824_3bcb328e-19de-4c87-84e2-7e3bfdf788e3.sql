-- Add rating_system column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN rating_system text NOT NULL DEFAULT 'knltb';

-- Add check constraint for valid rating systems
ALTER TABLE public.profiles
ADD CONSTRAINT valid_rating_system CHECK (rating_system IN ('knltb', 'playtomic'));