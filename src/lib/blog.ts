import {
  sanityClient,
  BLOG_POSTS_QUERY,
  BLOG_POSTS_COUNT_QUERY,
  BLOG_POSTS_BY_CATEGORY_QUERY,
  BLOG_POSTS_BY_CATEGORY_COUNT_QUERY,
  BLOG_POST_BY_SLUG_QUERY,
  ALL_CATEGORIES_QUERY,
} from '@/lib/sanity';
import type { SeoFields, CtaFields, BodySection } from '@/lib/sanity';

export interface Article {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  excerpt: string | null;
  bodySections: BodySection[] | null;
  authorName: string | null;
  category: string | null;
  isFeatured: boolean | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
  datePublished: string | null;
  dateModified: string | null;
}

const ARTICLES_PER_PAGE = 12;

export function calculateReadTime(bodySections: BodySection[] | null): string {
  if (!bodySections || bodySections.length === 0) return '1 min read';
  let words = 0;
  for (const section of bodySections) {
    if (section.heading) words += section.heading.split(/\s+/).filter(Boolean).length;
    if (section.content) words += section.content.split(/\s+/).filter(Boolean).length;
  }
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

export async function getPublishedArticles(page: number = 1, category?: string) {
  const start = (page - 1) * ARTICLES_PER_PAGE;
  const end = start + ARTICLES_PER_PAGE;

  let articles: Article[];
  let totalCount: number;

  if (category) {
    [articles, totalCount] = await Promise.all([
      sanityClient.fetch<Article[]>(BLOG_POSTS_BY_CATEGORY_QUERY, { category, start, end }),
      sanityClient.fetch<number>(BLOG_POSTS_BY_CATEGORY_COUNT_QUERY, { category }),
    ]);
  } else {
    [articles, totalCount] = await Promise.all([
      sanityClient.fetch<Article[]>(BLOG_POSTS_QUERY, { start, end }),
      sanityClient.fetch<number>(BLOG_POSTS_COUNT_QUERY),
    ]);
  }

  return {
    articles: articles || [],
    totalCount: totalCount || 0,
    totalPages: Math.ceil((totalCount || 0) / ARTICLES_PER_PAGE),
    currentPage: page,
  };
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const data = await sanityClient.fetch(BLOG_POST_BY_SLUG_QUERY, { slug });
  return data || null;
}

export async function getAllCategories(): Promise<string[]> {
  const categories = await sanityClient.fetch(ALL_CATEGORIES_QUERY);
  return (categories || []).filter(Boolean).sort();
}
