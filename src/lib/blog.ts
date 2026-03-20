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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any[] | null;
  audience?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topics?: any[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relatedGuides?: any[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relatedStrokes?: any[] | null;
  authorName: string | null;
  category: string | null;
  isFeatured: boolean | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
  datePublished: string | null;
  dateModified: string | null;
}

const ARTICLES_PER_PAGE = 12;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countWordsInPortableText(blocks: any[]): number {
  let words = 0;
  for (const block of blocks) {
    if (block._type === 'block' && block.children) {
      for (const child of block.children) {
        if (child.text) words += child.text.split(/\s+/).filter(Boolean).length;
      }
    }
  }
  return words;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function calculateReadTime(bodySections: BodySection[] | null, content?: any[] | null): string {
  let words = 0;
  if (content && content.length > 0) {
    words = countWordsInPortableText(content);
  } else if (bodySections && bodySections.length > 0) {
    for (const section of bodySections) {
      if (section.heading) words += section.heading.split(/\s+/).filter(Boolean).length;
      if (section.content) words += section.content.split(/\s+/).filter(Boolean).length;
    }
  }
  if (words === 0) return '1 min read';
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
