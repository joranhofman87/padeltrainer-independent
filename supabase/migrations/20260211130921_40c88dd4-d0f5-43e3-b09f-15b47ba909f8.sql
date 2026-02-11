
CREATE TABLE public.profile_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  video_url text NOT NULL,
  title text,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT one_profile CHECK (
    (trainer_profile_id IS NOT NULL AND academy_profile_id IS NULL) OR
    (trainer_profile_id IS NULL AND academy_profile_id IS NOT NULL)
  )
);

-- Migrate existing trainer video_url data
INSERT INTO public.profile_videos (trainer_profile_id, video_url, title)
SELECT id, video_url, 'Intro'
FROM public.trainer_profiles
WHERE video_url IS NOT NULL AND video_url != '';

-- Enable RLS
ALTER TABLE public.profile_videos ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can see videos for public profiles
CREATE POLICY "Anyone can view profile videos"
ON public.profile_videos
FOR SELECT
USING (true);

-- Trainers can manage their own videos
CREATE POLICY "Trainers can insert own videos"
ON public.profile_videos
FOR INSERT
TO authenticated
WITH CHECK (
  trainer_profile_id IS NOT NULL AND
  EXISTS (
    SELECT 1 FROM public.trainer_profiles
    WHERE id = trainer_profile_id AND user_id = auth.uid()
  )
);

CREATE POLICY "Trainers can update own videos"
ON public.profile_videos
FOR UPDATE
TO authenticated
USING (
  trainer_profile_id IS NOT NULL AND
  EXISTS (
    SELECT 1 FROM public.trainer_profiles
    WHERE id = trainer_profile_id AND user_id = auth.uid()
  )
);

CREATE POLICY "Trainers can delete own videos"
ON public.profile_videos
FOR DELETE
TO authenticated
USING (
  trainer_profile_id IS NOT NULL AND
  EXISTS (
    SELECT 1 FROM public.trainer_profiles
    WHERE id = trainer_profile_id AND user_id = auth.uid()
  )
);

-- Academy managers can manage academy videos
CREATE POLICY "Academy managers can insert videos"
ON public.profile_videos
FOR INSERT
TO authenticated
WITH CHECK (
  academy_profile_id IS NOT NULL AND
  public.is_academy_manager(auth.uid(), academy_profile_id)
);

CREATE POLICY "Academy managers can update videos"
ON public.profile_videos
FOR UPDATE
TO authenticated
USING (
  academy_profile_id IS NOT NULL AND
  public.is_academy_manager(auth.uid(), academy_profile_id)
);

CREATE POLICY "Academy managers can delete videos"
ON public.profile_videos
FOR DELETE
TO authenticated
USING (
  academy_profile_id IS NOT NULL AND
  public.is_academy_manager(auth.uid(), academy_profile_id)
);

-- Index for fast lookups
CREATE INDEX idx_profile_videos_trainer ON public.profile_videos(trainer_profile_id) WHERE trainer_profile_id IS NOT NULL;
CREATE INDEX idx_profile_videos_academy ON public.profile_videos(academy_profile_id) WHERE academy_profile_id IS NOT NULL;
