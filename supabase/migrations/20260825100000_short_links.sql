-- Generic branded short links:  padeltrainer.ai/s/<code>  ->  301/302 to target_path.
--
-- WHY: registration share links are long (/nl/academies/<slug>/register/<uuid>). This adds a
-- reusable code->URL primitive (NOT tied to registrations) so any entity can mint a short link on
-- our own domain — keeping backlink/SEO equity on padeltrainer.ai instead of an external shortener.
--
-- Scalability rests on IMMUTABILITY: a code's target never changes, so the Cloudflare Worker caches
-- the redirect at the edge and resolution on a miss is a single primary-key read. Reads go ONLY
-- through resolve_short_link (STABLE, no writes) so the hot path stays edge-cacheable.
--
-- Access posture mirrors slug_redirects/resolve_public_handle: RLS on, NO policies — the table is
-- unreachable directly; the two SECURITY DEFINER RPCs are the entire surface.

-- ── Table ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.short_links (
  code          text PRIMARY KEY,                        -- base62(7): the /s/<code> handle
  target_path   text NOT NULL,                           -- DENORMALIZED served value; site-root-relative ('/nl/register/<uuid>')
  target_type   text NOT NULL,                           -- polymorphic tag: 'registration' now; 'academy'/'invoice'/… later
  target_id     uuid,                                    -- polymorphic key (nullable for path-only links)
  target_params jsonb NOT NULL DEFAULT '{}'::jsonb,      -- regen/analytics context, e.g. {"owner_type":"academy"}
  permanent     boolean NOT NULL DEFAULT true,           -- true → 301, false → 302 (future repointable links)
  created_by    uuid,                                    -- auth.uid() of the minter (nullable)
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotency key: one canonical code per destination. target_path is IN the key so a repoint mints
  -- a fresh code instead of silently moving where an already-shared code lands.
  CONSTRAINT short_links_target_uniq UNIQUE (target_type, target_id, target_path)
);

COMMENT ON TABLE public.short_links IS
  'Generic branded short links: /s/<code> -> target_path (301/302). Read ONLY via resolve_short_link; mint ONLY via get_or_create_short_link.';

-- Reverse lookup for get-or-create + future rename-regen (the PK covers the forward/hot path).
CREATE INDEX IF NOT EXISTS short_links_target_idx ON public.short_links (target_type, target_id);

ALTER TABLE public.short_links ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: no direct anon/authenticated table access. All access via the RPCs below.

-- ── Code generation ─────────────────────────────────────────────────────────────────────────────
-- base62 over the existing public.gen_random_bytes shim (20260506080530). 62^7 ≈ 3.5e12; collisions
-- are re-rolled by the insert-retry in get_or_create_short_link, so modulo bias is irrelevant.
CREATE OR REPLACE FUNCTION public.gen_short_code(_len int DEFAULT 7)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  out text := '';
  b bytea := public.gen_random_bytes(_len);
  i int;
BEGIN
  FOR i IN 0.._len - 1 LOOP
    out := out || substr(alphabet, (get_byte(b, i) % 62) + 1, 1);
  END LOOP;
  RETURN out;
END;
$$;

-- ── Mint (idempotent, write) ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_or_create_short_link(
  _target_path   text,
  _target_type   text,
  _target_id     uuid    DEFAULT NULL,
  _target_params jsonb   DEFAULT '{}'::jsonb,
  _permanent     boolean DEFAULT true
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_try  int := 0;
BEGIN
  -- Open-redirect guard: only same-site root-relative paths (reject host-absolute + protocol-relative '//evil').
  IF _target_path IS NULL OR left(_target_path, 1) <> '/' OR left(_target_path, 2) = '//' THEN
    RAISE EXCEPTION 'target_path must be a site-root-relative path (got %)', _target_path;
  END IF;

  -- Idempotent hit: same destination → same code.
  SELECT code INTO v_code FROM public.short_links
   WHERE target_type = _target_type
     AND target_id IS NOT DISTINCT FROM _target_id
     AND target_path = _target_path
   LIMIT 1;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      v_code := public.gen_short_code(7);
      INSERT INTO public.short_links (code, target_path, target_type, target_id, target_params, permanent, created_by)
      VALUES (v_code, _target_path, _target_type, _target_id, COALESCE(_target_params, '{}'::jsonb), _permanent, auth.uid());
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- Either a concurrent mint of the SAME target (adopt it) or a code collision (re-roll).
      SELECT code INTO v_code FROM public.short_links
       WHERE target_type = _target_type
         AND target_id IS NOT DISTINCT FROM _target_id
         AND target_path = _target_path
       LIMIT 1;
      IF v_code IS NOT NULL THEN
        RETURN v_code;
      END IF;
      IF v_try >= 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END;
$$;

-- ── Resolve (read, no writes — keeps the 301 edge-cacheable) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_short_link(_code text)
RETURNS TABLE (target_path text, permanent boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT target_path, permanent FROM public.short_links WHERE code = _code LIMIT 1;
$$;

-- Reverse batch lookup (target → code) for admin listings. RLS blocks direct table reads, so this
-- SECURITY DEFINER reader is the seam. Codes are public share URLs (not secret), so authenticated
-- access to codes-by-id is fine — it only ever yields links to already-public pages.
CREATE OR REPLACE FUNCTION public.get_short_codes(_target_type text, _target_ids uuid[])
RETURNS TABLE (target_id uuid, code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT target_id, code FROM public.short_links
   WHERE target_type = _target_type AND target_id = ANY (_target_ids);
$$;

REVOKE ALL ON FUNCTION public.get_or_create_short_link(text, text, uuid, jsonb, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_or_create_short_link(text, text, uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_short_link(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_short_codes(text, uuid[]) TO authenticated;

-- ── Eager mint for registrations (best-effort trigger) ──────────────────────────────────────────
-- Every registration form gets a code at creation → the admin listing joins it and the "Copy link"/
-- QR actions stay synchronous (no runtime RPC, no clipboard-async issue). Mirrors the academy/trainer
-- slug-on-create triggers. MUST swallow errors: a short-link glitch must never block form creation.
CREATE OR REPLACE FUNCTION public.registrations_mint_short_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.get_or_create_short_link(
      '/nl/register/' || NEW.id::text,
      'registration',
      NEW.id,
      jsonb_build_object('owner_type', NEW.owner_type),
      true
    );
  EXCEPTION WHEN OTHERS THEN
    -- best-effort: never fail the registration insert over a short-link hiccup
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS registrations_mint_short_link ON public.registrations;
CREATE TRIGGER registrations_mint_short_link
  AFTER INSERT ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.registrations_mint_short_link();

-- Backfill existing forms (idempotent via the RPC's target-uniqueness). open + draft.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, owner_type FROM public.registrations WHERE status IN ('open', 'draft') LOOP
    BEGIN
      PERFORM public.get_or_create_short_link(
        '/nl/register/' || r.id::text, 'registration', r.id,
        jsonb_build_object('owner_type', r.owner_type), true);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ── Reserve the /s namespace so no profile handle can shadow it ──────────────────────────────────
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
    'home','index','search','about','contact','support','help','docs',
    's'
  ]);
$$;
