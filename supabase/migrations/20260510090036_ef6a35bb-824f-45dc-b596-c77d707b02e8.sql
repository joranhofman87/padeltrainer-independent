
-- Tag definitions per academy
CREATE TABLE public.academy_player_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  academy_profile_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (academy_profile_id, name)
);

CREATE INDEX idx_academy_player_tags_academy ON public.academy_player_tags(academy_profile_id);

ALTER TABLE public.academy_player_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Academy managers manage player tags"
ON public.academy_player_tags
FOR ALL
TO authenticated
USING (public.is_academy_manager(auth.uid(), academy_profile_id))
WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));

CREATE TRIGGER update_academy_player_tags_updated_at
BEFORE UPDATE ON public.academy_player_tags
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-player metadata (notes + tag assignments) scoped to academy
CREATE TABLE public.academy_player_metadata (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  academy_profile_id UUID NOT NULL,
  guest_player_id UUID REFERENCES public.guest_players(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  notes TEXT,
  tag_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (guest_player_id IS NOT NULL AND profile_id IS NULL) OR
    (guest_player_id IS NULL AND profile_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_academy_player_metadata_guest
  ON public.academy_player_metadata(academy_profile_id, guest_player_id)
  WHERE guest_player_id IS NOT NULL;

CREATE UNIQUE INDEX idx_academy_player_metadata_profile
  ON public.academy_player_metadata(academy_profile_id, profile_id)
  WHERE profile_id IS NOT NULL;

CREATE INDEX idx_academy_player_metadata_academy ON public.academy_player_metadata(academy_profile_id);
CREATE INDEX idx_academy_player_metadata_tag_ids ON public.academy_player_metadata USING GIN(tag_ids);

ALTER TABLE public.academy_player_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Academy managers manage player metadata"
ON public.academy_player_metadata
FOR ALL
TO authenticated
USING (public.is_academy_manager(auth.uid(), academy_profile_id))
WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));

CREATE TRIGGER update_academy_player_metadata_updated_at
BEFORE UPDATE ON public.academy_player_metadata
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
