-- Create rating_systems table for admin-managed rating configurations
CREATE TABLE public.rating_systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'INT',
  min_rating NUMERIC NOT NULL,
  max_rating NUMERIC NOT NULL,
  step NUMERIC NOT NULL DEFAULT 0.1,
  lower_is_better BOOLEAN NOT NULL DEFAULT false,
  member_id_label TEXT,
  member_id_placeholder TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.rating_systems ENABLE ROW LEVEL SECURITY;

-- Anyone can view active rating systems
CREATE POLICY "Anyone can view active rating systems"
ON public.rating_systems
FOR SELECT
USING (is_active = true);

-- Admins can view all rating systems
CREATE POLICY "Admins can view all rating systems"
ON public.rating_systems
FOR SELECT
USING (is_admin(auth.uid()));

-- Admins can insert rating systems
CREATE POLICY "Admins can insert rating systems"
ON public.rating_systems
FOR INSERT
WITH CHECK (is_admin(auth.uid()));

-- Admins can update rating systems
CREATE POLICY "Admins can update rating systems"
ON public.rating_systems
FOR UPDATE
USING (is_admin(auth.uid()));

-- Admins can delete rating systems
CREATE POLICY "Admins can delete rating systems"
ON public.rating_systems
FOR DELETE
USING (is_admin(auth.uid()));

-- Seed initial rating systems
INSERT INTO public.rating_systems (code, name, country, min_rating, max_rating, step, lower_is_better, member_id_label, member_id_placeholder, display_order) VALUES
('knltb', 'KNLTB', 'NL', 0.1, 9.9, 0.1, true, 'KNLTB Number', '12345678', 1),
('playtomic', 'Playtomic', 'INT', 0.1, 6.0, 0.1, false, NULL, NULL, 10),
('fep', 'FEP', 'ES', 1.0, 7.0, 0.1, false, 'FEP Número', '12345678', 2),
('lta', 'LTA', 'GB', 1.0, 4.25, 0.01, false, 'LTA Number', '12345678', 3),
('tennis_vl', 'Tennis Vlaanderen', 'BE', 50, 1000, 1, false, 'TV Nummer', '12345678', 4);

-- Rename knltb_number to rating_member_id for system-agnostic naming
ALTER TABLE public.profiles RENAME COLUMN knltb_number TO rating_member_id;