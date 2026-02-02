
# Friendly Trainer Slugs for All Trainers

## Current State

| Stat | Count |
|------|-------|
| Total trainers | 15 |
| With friendly slugs | 2 |
| Without slugs (using UUID) | 13 |

The slug column exists and a `generate_trainer_slug(full_name)` function exists, but:
- No automatic trigger populates slugs
- Most trainers still use their UUID in URLs

Example:
- ❌ `padeltrainer.ai/trainer/c0497580-1e4e-4376-93d1-5b90e9d7ca1d`
- ✅ `padeltrainer.ai/trainer/rene-lindenbergh`

---

## Solution

### 1. Backfill existing trainers
Run a one-time update to give all existing trainers a friendly slug based on their name.

### 2. Auto-generate slugs for new trainers
Create a trigger that fires when:
- A new trainer profile is created
- A trainer's name changes in the `profiles` table

### 3. Handle duplicates gracefully
If two trainers have the same name, append a number suffix:
- `john-smith`
- `john-smith-2`

---

## Database Changes

### Migration SQL

```sql
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
```

---

## Result After Implementation

| Trainer | Before | After |
|---------|--------|-------|
| Rene Lindenbergh | `/trainer/rene-lindenbergh` | `/trainer/rene-lindenbergh` (unchanged) |
| Tygho Schoonus | `/trainer/e59582d7-f07a-...` | `/trainer/tygho-schoonus` |
| Patrick Bernardus | `/trainer/1c5dc2d1-2ba3-...` | `/trainer/patrick-bernardus` |
| New trainer "Jan de Vries" | Would get UUID | `/trainer/jan-de-vries` |
| Second "Jan de Vries" | Would get UUID | `/trainer/jan-de-vries-2` |

The routing already supports both UUID and slug lookups, so existing links will continue to work.
