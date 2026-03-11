import { supabase } from '@/lib/supabaseClient';

export interface Article {
  id: string;
  canonical_id: string;
  locale: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body_html: string | null;
  status: string;
  published_at: string | null;
  author_name: string;
  cover_image_url: string | null;
  cover_image_alt: string | null;
  cover_image_generated_at: string | null;
  tags: string[] | null;
  primary_keyword: string | null;
  meta_title: string | null;
  meta_description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArticleWithTranslations extends Article {
  translations: { locale: string; slug: string }[];
}

const ARTICLES_PER_PAGE = 12;

function calculateReadTime(html: string | null): string {
  if (!html) return '1 min read';
  const text = html.replace(/<[^>]*>/g, '');
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

export { calculateReadTime };

export async function getPublishedArticles(
  locale: string,
  page: number = 1,
  tag?: string
) {
  let query = (supabase as any)
    .from('articles')
    .select('*', { count: 'exact' })
    .eq('locale', locale)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .range((page - 1) * ARTICLES_PER_PAGE, page * ARTICLES_PER_PAGE - 1);

  if (tag) {
    query = query.contains('tags', [tag]);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    articles: (data || []) as Article[],
    totalCount: count || 0,
    totalPages: Math.ceil((count || 0) / ARTICLES_PER_PAGE),
    currentPage: page,
  };
}

export async function getArticleBySlug(
  slug: string,
  locale: string
): Promise<ArticleWithTranslations | null> {
  const { data, error } = await (supabase as any)
    .from('articles')
    .select('*')
    .eq('slug', slug)
    .eq('locale', locale)
    .eq('status', 'published')
    .maybeSingle();

  if (error || !data) return null;

  // Fetch translations via canonical_id
  const { data: translations } = await (supabase as any)
    .from('articles')
    .select('locale, slug')
    .eq('canonical_id', data.canonical_id)
    .eq('status', 'published')
    .neq('id', data.id);

  return {
    ...data,
    translations: translations || [],
  } as ArticleWithTranslations;
}

export async function getRelatedArticles(
  articleId: string,
  locale: string,
  tags: string[] | null,
  limit: number = 3
): Promise<Article[]> {
  let query = (supabase as any)
    .from('articles')
    .select('*')
    .eq('locale', locale)
    .eq('status', 'published')
    .neq('id', articleId)
    .order('published_at', { ascending: false })
    .limit(limit);

  if (tags && tags.length > 0) {
    query = query.overlaps('tags', tags);
  }

  const { data, error } = await query;
  if (error) return [];
  return (data || []) as Article[];
}

export async function getAllTags(locale: string): Promise<string[]> {
  const { data } = await (supabase as any)
    .from('articles')
    .select('tags')
    .eq('locale', locale)
    .eq('status', 'published');

  if (!data) return [];
  const tagSet = new Set<string>();
  data.forEach((a: any) => a.tags?.forEach((t: string) => tagSet.add(t)));
  return Array.from(tagSet).sort();
}
