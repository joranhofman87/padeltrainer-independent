-- Fix search path for generate_location_slug function
CREATE OR REPLACE FUNCTION public.generate_location_slug(name TEXT, city TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  RETURN lower(
    regexp_replace(
      regexp_replace(
        unaccent(name || '-' || city),
        '[^a-zA-Z0-9\-]', '-', 'g'
      ),
      '-+', '-', 'g'
    )
  );
END;
$$;