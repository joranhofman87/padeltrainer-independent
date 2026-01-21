-- Add is_anonymous column to reviews table
ALTER TABLE public.reviews 
ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT false;