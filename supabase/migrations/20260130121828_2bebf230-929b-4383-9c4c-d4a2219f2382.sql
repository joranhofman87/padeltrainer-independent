-- Create review_tags table for storing available tags
CREATE TABLE public.review_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_nl text NOT NULL,
  category text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create review_tag_selections table for linking reviews to tags
CREATE TABLE public.review_tag_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.review_tags(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(review_id, tag_id)
);

-- Enable RLS
ALTER TABLE public.review_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_tag_selections ENABLE ROW LEVEL SECURITY;

-- RLS Policies for review_tags
CREATE POLICY "Anyone can view active review tags"
ON public.review_tags
FOR SELECT
USING (is_active = true);

CREATE POLICY "Admins can view all review tags"
ON public.review_tags
FOR SELECT
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can insert review tags"
ON public.review_tags
FOR INSERT
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update review tags"
ON public.review_tags
FOR UPDATE
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can delete review tags"
ON public.review_tags
FOR DELETE
USING (is_admin(auth.uid()));

-- RLS Policies for review_tag_selections
CREATE POLICY "Anyone can view review tag selections"
ON public.review_tag_selections
FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can insert tag selections"
ON public.review_tag_selections
FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Admins can delete review tag selections"
ON public.review_tag_selections
FOR DELETE
USING (is_admin(auth.uid()));

-- Seed initial tags
INSERT INTO public.review_tags (name, name_nl, category, display_order) VALUES
-- Teaching Style
('Patient', 'Geduldig', 'teaching_style', 1),
('Challenging', 'Uitdagend', 'teaching_style', 2),
('Structured', 'Gestructureerd', 'teaching_style', 3),
('Flexible', 'Flexibel', 'teaching_style', 4),
('Motivating', 'Motiverend', 'teaching_style', 5),
-- Skill Focus
('Technical', 'Technisch', 'skill_focus', 10),
('Tactical', 'Tactisch', 'skill_focus', 11),
('Physical', 'Fysiek', 'skill_focus', 12),
('Mental game', 'Mentaal spel', 'skill_focus', 13),
-- Specialties
('Great with beginners', 'Goed met beginners', 'specialties', 20),
('Competition-focused', 'Wedstrijdgericht', 'specialties', 21),
('Kids specialist', 'Kinderspecialist', 'specialties', 22),
('Advanced tactics', 'Gevorderde tactiek', 'specialties', 23);