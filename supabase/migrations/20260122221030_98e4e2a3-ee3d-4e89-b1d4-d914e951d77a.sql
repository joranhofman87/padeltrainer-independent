-- Update KNLTB rating system to allow 4 decimal places
UPDATE public.rating_systems 
SET step = 0.0001 
WHERE code = 'knltb';