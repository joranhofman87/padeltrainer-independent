
-- Create location_translations table for multi-language content
CREATE TABLE public.location_translations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(location_id, locale)
);

-- Index for fast lookups
CREATE INDEX idx_location_translations_location_locale ON public.location_translations(location_id, locale);

-- Enable RLS
ALTER TABLE public.location_translations ENABLE ROW LEVEL SECURITY;

-- Public read access (location info is public)
CREATE POLICY "Location translations are publicly readable"
  ON public.location_translations FOR SELECT
  USING (true);

-- Admins can manage translations
CREATE POLICY "Admins can manage location translations"
  ON public.location_translations FOR ALL
  USING (public.is_admin(auth.uid()));

-- Club managers can update translations for their locations
CREATE POLICY "Club managers can manage their location translations"
  ON public.location_translations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.club_profiles cp
      JOIN public.club_managers cm ON cm.club_profile_id = cp.id
      WHERE cp.location_id = location_translations.location_id
        AND cm.user_id = auth.uid()
    )
  );

-- Auto-update updated_at
CREATE TRIGGER update_location_translations_updated_at
  BEFORE UPDATE ON public.location_translations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
