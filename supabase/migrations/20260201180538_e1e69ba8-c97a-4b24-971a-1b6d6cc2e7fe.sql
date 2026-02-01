-- Add reviewer_name column for admin-created reviews with custom names
ALTER TABLE public.reviews 
ADD COLUMN reviewer_name text;