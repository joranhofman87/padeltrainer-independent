
ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS cover_image_alt text,
  ADD COLUMN IF NOT EXISTS cover_image_generated_at timestamptz;
