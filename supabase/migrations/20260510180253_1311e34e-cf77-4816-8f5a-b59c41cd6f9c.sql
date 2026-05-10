
CREATE TABLE IF NOT EXISTS public.slug_redirects (
  old_slug text PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('trainer','academy')),
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.slug_redirects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slug_redirects readable by everyone" ON public.slug_redirects;
CREATE POLICY "slug_redirects readable by everyone"
ON public.slug_redirects FOR SELECT
USING (true);

CREATE OR REPLACE FUNCTION public.is_reserved_handle(_handle text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(_handle) = ANY (ARRAY[
    'app','api','pay','auth','signup','login','onboarding','admin',
    'trainer','trainers','academy','academies','club','clubs',
    'locations','location','book','register','claim',
    'playground','learn','learning','topics','blog',
    'padel','padel-strokes','padel-coaches','video-tips','gear',
    'brand','partner','privacy','terms','founding-trainers',
    'rating','sitemap','robots','llms','assets','static','public',
    'manifest','favicon','sw','service-worker','share','www','mail',
    'home','index','search','about','contact','support','help','docs'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.generate_unique_public_handle(
  _owner_type text,
  _owner_id uuid,
  _name text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  base_slug text;
  final_slug text;
  suffix int := 1;
BEGIN
  base_slug := lower(
    trim(both '-' from
      regexp_replace(
        regexp_replace(COALESCE(_name, ''), '[^a-zA-Z0-9\-]', '-', 'g'),
        '-+', '-', 'g'
      )
    )
  );

  IF base_slug IS NULL OR base_slug = '' OR base_slug ~ '^[0-9-]+$' THEN
    base_slug := CASE WHEN _owner_type = 'academy' THEN 'academy' ELSE 'coach' END;
  END IF;

  final_slug := base_slug;

  WHILE
    public.is_reserved_handle(final_slug)
    OR EXISTS (
      SELECT 1 FROM public.trainer_profiles
      WHERE slug = final_slug
        AND (_owner_type <> 'trainer' OR id <> _owner_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.academy_profiles
      WHERE slug = final_slug
        AND (_owner_type <> 'academy' OR id <> _owner_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.slug_redirects
      WHERE old_slug = final_slug
        AND NOT (owner_type = _owner_type AND owner_id = _owner_id)
    )
  LOOP
    suffix := suffix + 1;
    final_slug := base_slug || '-' || suffix;
  END LOOP;

  RETURN final_slug;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_unique_trainer_slug(_trainer_id uuid, _full_name text)
RETURNS text
LANGUAGE sql
SET search_path = public
AS $$
  SELECT public.generate_unique_public_handle('trainer', _trainer_id, _full_name);
$$;

CREATE OR REPLACE FUNCTION public.set_academy_slug_on_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := public.generate_unique_public_handle('academy', NEW.id, NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS academy_profiles_set_slug ON public.academy_profiles;
CREATE TRIGGER academy_profiles_set_slug
BEFORE INSERT ON public.academy_profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_academy_slug_on_create();

-- Backfill: rename trainer/academy slugs colliding with reserved words.
DO $$
DECLARE
  r record;
  new_slug text;
BEGIN
  FOR r IN
    SELECT tp.id, tp.slug, p.full_name
    FROM public.trainer_profiles tp
    LEFT JOIN public.profiles p ON p.user_id = tp.user_id
    WHERE tp.slug IS NOT NULL AND public.is_reserved_handle(tp.slug)
  LOOP
    new_slug := public.generate_unique_public_handle('trainer', r.id, r.full_name);
    INSERT INTO public.slug_redirects(old_slug, owner_type, owner_id)
    VALUES (r.slug, 'trainer', r.id)
    ON CONFLICT (old_slug) DO NOTHING;
    UPDATE public.trainer_profiles SET slug = new_slug WHERE id = r.id;
  END LOOP;

  FOR r IN
    SELECT id, slug, name AS full_name FROM public.academy_profiles
    WHERE slug IS NOT NULL AND public.is_reserved_handle(slug)
  LOOP
    new_slug := public.generate_unique_public_handle('academy', r.id, r.full_name);
    INSERT INTO public.slug_redirects(old_slug, owner_type, owner_id)
    VALUES (r.slug, 'academy', r.id)
    ON CONFLICT (old_slug) DO NOTHING;
    UPDATE public.academy_profiles SET slug = new_slug WHERE id = r.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_public_handle(_handle text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF _handle IS NULL OR _handle = '' OR public.is_reserved_handle(_handle) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object('owner_type','trainer','slug', slug)
    INTO v_result
    FROM public.trainer_profiles
   WHERE slug = _handle
   LIMIT 1;
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;

  SELECT jsonb_build_object('owner_type','academy','slug', slug)
    INTO v_result
    FROM public.academy_profiles
   WHERE slug = _handle
   LIMIT 1;
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;

  SELECT CASE
    WHEN sr.owner_type = 'trainer' THEN jsonb_build_object('owner_type','trainer','slug', tp.slug)
    WHEN sr.owner_type = 'academy' THEN jsonb_build_object('owner_type','academy','slug', ap.slug)
    ELSE NULL
  END
    INTO v_result
    FROM public.slug_redirects sr
    LEFT JOIN public.trainer_profiles tp ON sr.owner_type = 'trainer' AND tp.id = sr.owner_id
    LEFT JOIN public.academy_profiles ap ON sr.owner_type = 'academy' AND ap.id = sr.owner_id
   WHERE sr.old_slug = _handle
   LIMIT 1;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_public_handle(text) TO anon, authenticated;
