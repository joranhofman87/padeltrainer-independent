
-- Make academy_profile_id nullable and add trainer_profile_id to player tag/metadata + email campaign tables
-- so a trainer can own these in the same way an academy can.

-- 1. academy_player_tags
ALTER TABLE public.academy_player_tags
  ALTER COLUMN academy_profile_id DROP NOT NULL;
ALTER TABLE public.academy_player_tags
  ADD COLUMN IF NOT EXISTS trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.academy_player_tags
  DROP CONSTRAINT IF EXISTS academy_player_tags_owner_check;
ALTER TABLE public.academy_player_tags
  ADD CONSTRAINT academy_player_tags_owner_check
  CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1);
ALTER TABLE public.academy_player_tags
  DROP CONSTRAINT IF EXISTS academy_player_tags_academy_profile_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS academy_player_tags_academy_name_key
  ON public.academy_player_tags(academy_profile_id, name) WHERE academy_profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_player_tags_trainer_name_key
  ON public.academy_player_tags(trainer_profile_id, name) WHERE trainer_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_academy_player_tags_trainer ON public.academy_player_tags(trainer_profile_id);

DROP POLICY IF EXISTS "Trainers manage their player tags" ON public.academy_player_tags;
CREATE POLICY "Trainers manage their player tags"
  ON public.academy_player_tags
  FOR ALL TO authenticated
  USING (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ))
  WITH CHECK (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ));

-- 2. academy_player_metadata
ALTER TABLE public.academy_player_metadata
  ALTER COLUMN academy_profile_id DROP NOT NULL;
ALTER TABLE public.academy_player_metadata
  ADD COLUMN IF NOT EXISTS trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.academy_player_metadata
  DROP CONSTRAINT IF EXISTS academy_player_metadata_owner_check;
ALTER TABLE public.academy_player_metadata
  ADD CONSTRAINT academy_player_metadata_owner_check
  CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academy_player_metadata_trainer_guest
  ON public.academy_player_metadata(trainer_profile_id, guest_player_id) WHERE trainer_profile_id IS NOT NULL AND guest_player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_academy_player_metadata_trainer_profile
  ON public.academy_player_metadata(trainer_profile_id, profile_id) WHERE trainer_profile_id IS NOT NULL AND profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_academy_player_metadata_trainer ON public.academy_player_metadata(trainer_profile_id);

DROP POLICY IF EXISTS "Trainers manage their player metadata" ON public.academy_player_metadata;
CREATE POLICY "Trainers manage their player metadata"
  ON public.academy_player_metadata
  FOR ALL TO authenticated
  USING (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ))
  WITH CHECK (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ));

-- 3. email_campaign_templates
ALTER TABLE public.email_campaign_templates
  ALTER COLUMN academy_profile_id DROP NOT NULL;
ALTER TABLE public.email_campaign_templates
  ADD COLUMN IF NOT EXISTS trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.email_campaign_templates
  DROP CONSTRAINT IF EXISTS email_campaign_templates_owner_check;
ALTER TABLE public.email_campaign_templates
  ADD CONSTRAINT email_campaign_templates_owner_check
  CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1);
CREATE INDEX IF NOT EXISTS idx_email_campaign_templates_trainer ON public.email_campaign_templates(trainer_profile_id);

DROP POLICY IF EXISTS "Trainers manage their templates" ON public.email_campaign_templates;
CREATE POLICY "Trainers manage their templates"
  ON public.email_campaign_templates
  FOR ALL TO authenticated
  USING (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ))
  WITH CHECK (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ));

-- 4. email_campaigns
ALTER TABLE public.email_campaigns
  ALTER COLUMN academy_profile_id DROP NOT NULL;
ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS trainer_profile_id uuid REFERENCES public.trainer_profiles(id) ON DELETE CASCADE;
ALTER TABLE public.email_campaigns
  DROP CONSTRAINT IF EXISTS email_campaigns_owner_check;
ALTER TABLE public.email_campaigns
  ADD CONSTRAINT email_campaigns_owner_check
  CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_trainer ON public.email_campaigns(trainer_profile_id);

DROP POLICY IF EXISTS "Trainers manage their campaigns" ON public.email_campaigns;
CREATE POLICY "Trainers manage their campaigns"
  ON public.email_campaigns
  FOR ALL TO authenticated
  USING (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ))
  WITH CHECK (trainer_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
  ));
