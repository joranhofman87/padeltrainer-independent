import { sanityClient, BLOG_POSTS_QUERY, BLOG_POSTS_COUNT_QUERY, BLOG_POSTS_BY_TAG_QUERY, BLOG_POSTS_BY_TAG_COUNT_QUERY, BLOG_POST_BY_SLUG_QUERY, RELATED_POSTS_QUERY, ALL_TAGS_QUERY, urlFor } from '@/lib/sanity';
import type { PortableTextBlock } from '@portabletext/react';

export interface Article {
  _id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: PortableTextBlock[] | null;
  mainImage: any | null;
  publishedAt: string | null;
  tags: string[] | null;
  locale: string;
  author: { name: string; image?: any } | null;
  metaTitle: string | null;
  metaDescription: string | null;
  primaryKeyword: string | null;
}

export interface ArticleWithTranslations extends Article {
  _updatedAt: string;
  canonicalRef: string | null;
  translations: { locale: string; slug: string }[];
}

const ARTICLES_PER_PAGE = 12;

export function getImageUrl(image: any, width = 800, height?: number): string {
  if (!image) return '/placeholder.svg';
  let builder = urlFor(image).width(width).auto('format').quality(80);
  if (height) builder = builder.height(height);
  return builder.url();
}

function calculateReadTime(body: PortableTextBlock[] | null): string {
  if (!body) return '1 min read';
  // Estimate words from portable text blocks
  let words = 0;
  for (const block of body) {
    if (block._type === 'block' && Array.isArray(block.children)) {
      for (const child of block.children as any[]) {
        if (child.text) {
          words += child.text.split(/\s+/).filter(Boolean).length;
        }
      }
    }
  }
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

export { calculateReadTime };

export async function getPublishedArticles(
  locale: string,
  page: number = 1,
  tag?: string
) {
  const start = (page - 1) * ARTICLES_PER_PAGE;
  const end = start + ARTICLES_PER_PAGE;

  let articles: Article[];
  let totalCount: number;

  if (tag) {
    [articles, totalCount] = await Promise.all([
      sanityClient.fetch(BLOG_POSTS_BY_TAG_QUERY, { locale, tag, start, end }),
      sanityClient.fetch(BLOG_POSTS_BY_TAG_COUNT_QUERY, { locale, tag }),
    ]);
  } else {
    [articles, totalCount] = await Promise.all([
      sanityClient.fetch(BLOG_POSTS_QUERY, { locale, start, end }),
      sanityClient.fetch(BLOG_POSTS_COUNT_QUERY, { locale }),
    ]);
  }

  return {
    articles: articles || [],
    totalCount: totalCount || 0,
    totalPages: Math.ceil((totalCount || 0) / ARTICLES_PER_PAGE),
    currentPage: page,
  };
}

export async function getArticleBySlug(
  slug: string,
  locale: string
): Promise<ArticleWithTranslations | null> {
  const data = await sanityClient.fetch(BLOG_POST_BY_SLUG_QUERY, { slug, locale });
  return data || null;
}

export async function getRelatedArticles(
  articleId: string,
  locale: string,
  tags: string[] | null,
  limit: number = 3
): Promise<Article[]> {
  if (!tags || tags.length === 0) {
    // Fallback: get latest articles
    const data = await sanityClient.fetch(
      `*[_type == "post" && locale == $locale && _id != $id && !(_id in path("drafts.**"))] | order(publishedAt desc) [0...$limit] {
        _id, title, "slug": slug.current, mainImage, publishedAt, tags
      }`,
      { locale, id: articleId, limit }
    );
    return data || [];
  }

  const data = await sanityClient.fetch(RELATED_POSTS_QUERY, {
    locale,
    id: articleId,
    tags,
    limit,
  });
  return data || [];
}

export async function getAllTags(locale: string): Promise<string[]> {
  const tags = await sanityClient.fetch(ALL_TAGS_QUERY, { locale });
  return (tags || []).filter(Boolean).sort();
}
