import { sanityClient } from '@/lib/sanity';
import type { SeoFields } from '@/lib/sanity';

// ── Types ──

export interface TopicSummary {
  _id: string;
  title: string;
  slug: string;
  description: string | null;
  contentType: string | null;
  skillLevel: string | null;
  isIndexable: boolean;
}

export interface TopicDetail extends TopicSummary {
  h1: string;
  intro: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[] | null;
  seo: SeoFields | null;
  parentTopic: { _id: string; title: string; slug: string } | null;
  relatedTopics: { _id: string; title: string; slug: string; description: string | null }[] | null;
  featuredGuides: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    intro: string;
    contentType: string | null;
    skillLevel: string | null;
  }[] | null;
  featuredRules: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    quickAnswer: string | null;
  }[] | null;
  featuredStrokes: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    shortDescription: string | null;
    category: string | null;
    difficulty: string | null;
  }[] | null;
  featuredVideoTips: {
    _id: string;
    title: string;
    slug: string;
    shortSummary: string | null;
    skillLevel: string | null;
    trainer: { _id: string; name: string; slug: string } | null;
  }[] | null;
  featuredTrainers: {
    _id: string;
    name: string;
    slug: string;
    shortTagline: string | null;
    profileImageUrl: string | null;
  }[] | null;
}

// ── Queries ──

export const TOPICS_LIST_QUERY = `*[_type == "topic" && isIndexable != false && !(_id in path("drafts.**"))] | order(title asc) {
  _id,
  title,
  "slug": slug.current,
  description,
  contentType,
  skillLevel,
  "isIndexable": coalesce(isIndexable, true)
}`;

export const ALL_TOPICS_LIST_QUERY = `*[_type == "topic" && !(_id in path("drafts.**"))] | order(title asc) {
  _id,
  title,
  "slug": slug.current,
  description,
  contentType,
  skillLevel,
  "isIndexable": coalesce(isIndexable, true)
}`;

export const TOPIC_BY_SLUG_QUERY = `*[_type == "topic" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  intro,
  description,
  content,
  contentType,
  skillLevel,
  "isIndexable": coalesce(isIndexable, true),
  seo,
  "parentTopic": parentTopic-> { _id, title, "slug": slug.current },
  "relatedTopics": relatedTopics[]-> { _id, title, "slug": slug.current, description },
  "featuredGuides": featuredGuides[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    intro,
    contentType,
    skillLevel
  },
  "featuredRules": featuredRules[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    quickAnswer
  },
  "featuredStrokes": featuredStrokes[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    shortDescription,
    category,
    difficulty
  },
  "featuredVideoTips": featuredVideoTips[]-> {
    _id,
    title,
    "slug": slug.current,
    shortSummary,
    skillLevel,
    "trainer": trainer-> { _id, name, "slug": slug.current }
  },
  "featuredTrainers": featuredTrainers[]-> {
    _id,
    name,
    "slug": slug.current,
    shortTagline,
    "profileImageUrl": profileImage.asset->url
  }
}`;

// ── Fetch helpers ──

export async function getTopicBySlug(slug: string): Promise<TopicDetail | null> {
  return sanityClient.fetch<TopicDetail | null>(TOPIC_BY_SLUG_QUERY, { slug });
}

export async function getTopics(indexableOnly = true): Promise<TopicSummary[]> {
  return sanityClient.fetch<TopicSummary[]>(
    indexableOnly ? TOPICS_LIST_QUERY : ALL_TOPICS_LIST_QUERY
  );
}
