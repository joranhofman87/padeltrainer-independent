-- Create certifications table (country-aware)
CREATE TABLE public.certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'INT',
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, country)
);

-- Create specializations table (universal)
CREATE TABLE public.specializations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.specializations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for certifications
CREATE POLICY "Anyone can view active certifications"
ON public.certifications FOR SELECT
USING (is_active = true);

CREATE POLICY "Admins can view all certifications"
ON public.certifications FOR SELECT
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can insert certifications"
ON public.certifications FOR INSERT
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update certifications"
ON public.certifications FOR UPDATE
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can delete certifications"
ON public.certifications FOR DELETE
USING (is_admin(auth.uid()));

-- RLS Policies for specializations
CREATE POLICY "Anyone can view active specializations"
ON public.specializations FOR SELECT
USING (is_active = true);

CREATE POLICY "Admins can view all specializations"
ON public.specializations FOR SELECT
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can insert specializations"
ON public.specializations FOR INSERT
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update specializations"
ON public.specializations FOR UPDATE
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can delete specializations"
ON public.specializations FOR DELETE
USING (is_admin(auth.uid()));

-- Seed certifications data
INSERT INTO public.certifications (name, country, display_order) VALUES
-- Netherlands
('KNLTB Level 1', 'NL', 1),
('KNLTB Level 2', 'NL', 2),
('KNLTB Level 3', 'NL', 3),
('KNLTB Level 4', 'NL', 4),
('KNLTB Level 5', 'NL', 5),
-- Spain
('FEP Nivel 1', 'ES', 1),
('FEP Nivel 2', 'ES', 2),
('FEP Nivel 3', 'ES', 3),
-- Belgium
('Tennis Vlaanderen Coach Level 1', 'BE', 1),
('Tennis Vlaanderen Coach Level 2', 'BE', 2),
('Tennis Vlaanderen Coach Level 3', 'BE', 3),
-- International
('PTR Certified', 'INT', 1),
('WPT Coach Certificate', 'INT', 2),
('Padel Experience Coach', 'INT', 3),
('LTA Padel Coach', 'INT', 4);

-- Seed specializations data
INSERT INTO public.specializations (name, display_order) VALUES
('Beginners', 1),
('Advanced Technique', 2),
('Competition Preparation', 3),
('Junior Coaching', 4),
('Senior/Adults', 5),
('Group Lessons', 6),
('Private Lessons', 7),
('Tactical Training', 8),
('Fitness & Conditioning', 9);

-- Migrate existing trainer certifications and specializations to the master tables
INSERT INTO public.certifications (name, country, display_order)
SELECT DISTINCT unnest(certifications), 'NL', 100
FROM trainer_profiles
WHERE certifications IS NOT NULL
ON CONFLICT (name, country) DO NOTHING;

INSERT INTO public.specializations (name, display_order)
SELECT DISTINCT unnest(specializations), 100
FROM trainer_profiles
WHERE specializations IS NOT NULL
ON CONFLICT (name) DO NOTHING;