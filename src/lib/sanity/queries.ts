import { sanityClient, isSanityConfigured } from './client';
import type { SanityPost } from './types';

// Query for all published blog posts
const POSTS_QUERY = `*[_type == "post" && defined(slug.current)] | order(publishedAt desc) {
  _id,
  title,
  "slug": slug.current,
  excerpt,
  category,
  publishedAt,
  readTime,
  mainImage
}`;

// Query for a single post by slug
const POST_BY_SLUG_QUERY = `*[_type == "post" && slug.current == $slug][0] {
  _id,
  title,
  "slug": slug.current,
  excerpt,
  content,
  category,
  publishedAt,
  readTime,
  mainImage
}`;

export async function getAllPosts(): Promise<SanityPost[]> {
  if (!isSanityConfigured() || !sanityClient) {
    return [];
  }
  return sanityClient.fetch(POSTS_QUERY);
}

export async function getPostBySlug(slug: string): Promise<SanityPost | null> {
  if (!isSanityConfigured() || !sanityClient) {
    return null;
  }
  return sanityClient.fetch(POST_BY_SLUG_QUERY, { slug });
}
