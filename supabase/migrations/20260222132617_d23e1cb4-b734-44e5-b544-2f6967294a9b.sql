
-- ============================================
-- Blog System: articles, content_topics, sources, internal_links
-- ============================================

-- A) articles
CREATE TABLE public.articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id UUID NOT NULL DEFAULT gen_random_uuid(),
  locale TEXT NOT NULL DEFAULT 'en',
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  excerpt TEXT,
  body_html TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  author_name TEXT NOT NULL DEFAULT 'Padel Trainer',
  cover_image_url TEXT,
  tags TEXT[],
  primary_keyword TEXT,
  meta_title TEXT,
  meta_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_articles_locale_slug ON public.articles (locale, slug);
CREATE INDEX idx_articles_status_published ON public.articles (status, published_at);
CREATE INDEX idx_articles_canonical ON public.articles (canonical_id);

ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

-- Public can read published articles
CREATE POLICY "Anyone can read published articles"
  ON public.articles FOR SELECT
  USING (status = 'published');

-- Admin full CRUD
CREATE POLICY "Admins can do everything with articles"
  ON public.articles FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Auto-update updated_at
CREATE TRIGGER update_articles_updated_at
  BEFORE UPDATE ON public.articles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- B) content_topics
CREATE TABLE public.content_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_keyword TEXT NOT NULL,
  locales TEXT[] NOT NULL DEFAULT '{en}',
  angle TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.content_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage content_topics"
  ON public.content_topics FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

CREATE TRIGGER update_content_topics_updated_at
  BEFORE UPDATE ON public.content_topics
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- C) sources
CREATE TABLE public.sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_title TEXT,
  notes TEXT,
  allowed_to_use BOOLEAN NOT NULL DEFAULT true,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage sources"
  ON public.sources FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- D) internal_links
CREATE TABLE public.internal_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  locale TEXT NOT NULL,
  anchor_text TEXT NOT NULL
);

ALTER TABLE public.internal_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage internal_links"
  ON public.internal_links FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Storage bucket for blog images
INSERT INTO storage.buckets (id, name, public) VALUES ('blog-images', 'blog-images', true);

CREATE POLICY "Anyone can view blog images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'blog-images');

CREATE POLICY "Admins can upload blog images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'blog-images' AND public.is_admin(auth.uid()));

CREATE POLICY "Admins can update blog images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'blog-images' AND public.is_admin(auth.uid()));

CREATE POLICY "Admins can delete blog images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'blog-images' AND public.is_admin(auth.uid()));
