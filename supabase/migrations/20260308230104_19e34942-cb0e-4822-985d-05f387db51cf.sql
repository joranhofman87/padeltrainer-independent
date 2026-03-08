
-- Enum types
CREATE TYPE public.banner_event_type AS ENUM ('impression', 'click');
CREATE TYPE public.banner_budget_type AS ENUM ('unlimited', 'impression_cap', 'click_cap');
CREATE TYPE public.banner_format AS ENUM ('image', 'html');

-- Extend partner_banners
ALTER TABLE public.partner_banners
  ADD COLUMN IF NOT EXISTS sponsor_name TEXT,
  ADD COLUMN IF NOT EXISTS sponsor_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS budget_type public.banner_budget_type NOT NULL DEFAULT 'unlimited',
  ADD COLUMN IF NOT EXISTS budget_cap INTEGER,
  ADD COLUMN IF NOT EXISTS format public.banner_format NOT NULL DEFAULT 'image';

-- Banner placements table
CREATE TABLE public.banner_placements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  width INTEGER,
  height INTEGER,
  rotation_interval_seconds INTEGER NOT NULL DEFAULT 15,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.banner_placements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage placements"
  ON public.banner_placements FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "Anyone can read placements"
  ON public.banner_placements FOR SELECT TO anon, authenticated
  USING (true);

-- Banner placement assignments (many-to-many)
CREATE TABLE public.banner_placement_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  banner_id UUID NOT NULL REFERENCES public.partner_banners(id) ON DELETE CASCADE,
  placement_id UUID NOT NULL REFERENCES public.banner_placements(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (banner_id, placement_id)
);

ALTER TABLE public.banner_placement_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage assignments"
  ON public.banner_placement_assignments FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "Anyone can read active assignments"
  ON public.banner_placement_assignments FOR SELECT TO anon, authenticated
  USING (is_active = true);

-- Banner events table (granular tracking)
CREATE TABLE public.banner_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  banner_id UUID NOT NULL REFERENCES public.partner_banners(id) ON DELETE CASCADE,
  placement_id UUID REFERENCES public.banner_placements(id) ON DELETE SET NULL,
  event_type public.banner_event_type NOT NULL,
  user_id UUID,
  session_id TEXT,
  page_url TEXT,
  referrer TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.banner_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read events"
  ON public.banner_events FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "Anyone can insert events"
  ON public.banner_events FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Indexes for fast reporting
CREATE INDEX idx_banner_events_banner_type_created
  ON public.banner_events (banner_id, event_type, created_at);

CREATE INDEX idx_banner_events_placement_created
  ON public.banner_events (placement_id, event_type, created_at);

CREATE INDEX idx_banner_events_session_dedup
  ON public.banner_events (session_id, banner_id, placement_id, event_type, created_at);

-- Insert default placements
INSERT INTO public.banner_placements (slug, label, description, width, height, rotation_interval_seconds) VALUES
  ('location-detail-sidebar', 'Club Page Sidebar', 'Sidebar banner on club detail pages without premium subscription', 300, 250, 15),
  ('trainer-search-results', 'Trainer Search Results', 'Banner between trainer search results', 728, 90, 20),
  ('marketing-homepage', 'Homepage Hero', 'Banner on the public marketing homepage', 970, 250, 10),
  ('app-dashboard', 'App Dashboard', 'Banner in the logged-in user dashboard', 728, 90, 15);
