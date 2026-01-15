-- Add start_date column to lessons table for recurring lessons
ALTER TABLE public.lessons 
ADD COLUMN start_date DATE;