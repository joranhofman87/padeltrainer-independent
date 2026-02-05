-- Create partner_banners table for admin-managed advertisements on non-premium club pages
CREATE TABLE public.partner_banners (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    link_url TEXT,
    club_profile_id UUID REFERENCES public.club_profiles(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    start_date DATE,
    end_date DATE,
    click_count INTEGER NOT NULL DEFAULT 0,
    impression_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add comment for clarity
COMMENT ON TABLE public.partner_banners IS 'Partner banner advertisements displayed on non-premium club pages';
COMMENT ON COLUMN public.partner_banners.club_profile_id IS 'Optional: associate banner with a specific club partner';

-- Enable RLS
ALTER TABLE public.partner_banners ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can view active banners (for display on public pages)
CREATE POLICY "Anyone can view active banners"
ON public.partner_banners
FOR SELECT
USING (is_active = true AND (start_date IS NULL OR start_date <= CURRENT_DATE) AND (end_date IS NULL OR end_date >= CURRENT_DATE));

-- Policy: Admins can manage all banners
CREATE POLICY "Admins can manage banners"
ON public.partner_banners
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Create index for efficient queries
CREATE INDEX idx_partner_banners_active ON public.partner_banners(is_active, display_order) WHERE is_active = true;
CREATE INDEX idx_partner_banners_club ON public.partner_banners(club_profile_id) WHERE club_profile_id IS NOT NULL;

-- Create updated_at trigger
CREATE TRIGGER update_partner_banners_updated_at
BEFORE UPDATE ON public.partner_banners
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create storage bucket for partner banners
INSERT INTO storage.buckets (id, name, public) 
VALUES ('partner-banners', 'partner-banners', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for partner banners bucket
CREATE POLICY "Partner banners are publicly accessible"
ON storage.objects
FOR SELECT
USING (bucket_id = 'partner-banners');

CREATE POLICY "Admins can upload partner banners"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'partner-banners' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update partner banners"
ON storage.objects
FOR UPDATE
USING (bucket_id = 'partner-banners' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete partner banners"
ON storage.objects
FOR DELETE
USING (bucket_id = 'partner-banners' AND public.has_role(auth.uid(), 'admin'));