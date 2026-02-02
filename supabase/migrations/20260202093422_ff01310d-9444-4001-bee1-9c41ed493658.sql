-- Function to generate unique slug (handles duplicates)
CREATE OR REPLACE FUNCTION public.generate_unique_trainer_slug(
  _trainer_id UUID, 
  _full_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  suffix INT := 1;
BEGIN
  -- Generate base slug from name
  base_slug := lower(
    trim(both '-' from
      regexp_replace(
        regexp_replace(
          COALESCE(_full_name, ''),
          '[^a-zA-Z0-9\-]', '-', 'g'
        ),
        '-+', '-', 'g'
      )
    )
  );
  
  -- Handle empty names
  IF base_slug = '' OR base_slug IS NULL THEN
    base_slug := 'trainer';
  END IF;
  
  final_slug := base_slug;
  
  -- Check for duplicates and append suffix if needed
  WHILE EXISTS (
    SELECT 1 FROM trainer_profiles 
    WHERE slug = final_slug AND id != _trainer_id
  ) LOOP
    suffix := suffix + 1;
    final_slug := base_slug || '-' || suffix;
  END LOOP;
  
  RETURN final_slug;
END;
$$;

-- Trigger function for new trainer profiles
CREATE OR REPLACE FUNCTION public.set_trainer_slug_on_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  trainer_name TEXT;
BEGIN
  -- Get name from profiles table
  SELECT full_name INTO trainer_name
  FROM profiles WHERE user_id = NEW.user_id;
  
  -- Generate unique slug
  NEW.slug := generate_unique_trainer_slug(NEW.id, trainer_name);
  
  RETURN NEW;
END;
$$;

-- Trigger function when profile name changes
CREATE OR REPLACE FUNCTION public.update_trainer_slug_on_name_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only if name actually changed
  IF OLD.full_name IS DISTINCT FROM NEW.full_name THEN
    UPDATE trainer_profiles
    SET slug = generate_unique_trainer_slug(id, NEW.full_name)
    WHERE user_id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create triggers
CREATE TRIGGER set_trainer_slug_trigger
  BEFORE INSERT ON trainer_profiles
  FOR EACH ROW
  WHEN (NEW.slug IS NULL)
  EXECUTE FUNCTION set_trainer_slug_on_create();

CREATE TRIGGER update_trainer_slug_trigger
  AFTER UPDATE OF full_name ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_trainer_slug_on_name_change();

-- Backfill all existing trainers without slugs
UPDATE trainer_profiles tp
SET slug = generate_unique_trainer_slug(
  tp.id,
  (SELECT full_name FROM profiles WHERE user_id = tp.user_id)
)
WHERE slug IS NULL;