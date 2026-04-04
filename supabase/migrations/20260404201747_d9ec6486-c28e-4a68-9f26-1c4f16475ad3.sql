
-- Email campaign templates (reusable)
CREATE TABLE public.email_campaign_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  academy_profile_id UUID NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Email campaigns (sent campaigns)
CREATE TABLE public.email_campaigns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  academy_profile_id UUID NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.email_campaign_templates(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  filters JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Campaign recipients (tracking)
CREATE TABLE public.email_campaign_recipients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.email_campaign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_recipients ENABLE ROW LEVEL SECURITY;

-- Templates: academy managers can CRUD
CREATE POLICY "Academy managers can manage templates"
  ON public.email_campaign_templates
  FOR ALL
  TO authenticated
  USING (public.is_academy_manager(auth.uid(), academy_profile_id))
  WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));

-- Campaigns: academy managers can CRUD
CREATE POLICY "Academy managers can manage campaigns"
  ON public.email_campaigns
  FOR ALL
  TO authenticated
  USING (public.is_academy_manager(auth.uid(), academy_profile_id))
  WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));

-- Recipients: academy managers can view via campaign
CREATE POLICY "Academy managers can view campaign recipients"
  ON public.email_campaign_recipients
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.email_campaigns c
      WHERE c.id = campaign_id
        AND public.is_academy_manager(auth.uid(), c.academy_profile_id)
    )
  );

-- Indexes
CREATE INDEX idx_email_campaigns_academy ON public.email_campaigns(academy_profile_id);
CREATE INDEX idx_email_campaign_recipients_campaign ON public.email_campaign_recipients(campaign_id);
CREATE INDEX idx_email_campaign_templates_academy ON public.email_campaign_templates(academy_profile_id);
