import { sanityClient } from '@/lib/sanity';
import type { SeoFields, CtaFields } from '@/lib/sanity';

// ── Types ──

export interface LearningArticleSummary {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  pageType: 'hub' | 'child';
  contentType: string;
  intro: string;
  quickAnswer: string;
  skillLevel: string | null;
  seo: SeoFields | null;
  datePublished: string | null;
  dateModified: string | null;
  topics: { _id: string; title: string; slug: string }[] | null;
}

export interface LearningArticleDetail extends LearningArticleSummary {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[]; // Portable Text blocks
  commonMistakes: string[] | null;
  cta: CtaFields | null;
  language?: string;
  translationOf?: { _ref: string } | null;
  relatedGuides: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    intro: string;
    pageType: 'hub' | 'child';
    contentType: string;
    skillLevel: string | null;
  }[] | null;
  relatedRules: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    quickAnswer: string;
    pageType: string;
  }[] | null;
  relatedStrokes: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    shortDescription: string;
    category: string | null;
    difficulty: string | null;
  }[] | null;
  relatedVideoTips: {
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

const LEARNING_ARTICLE_FIELDS = `
  _id,
  title,
  "slug": slug.current,
  h1,
  pageType,
  contentType,
  intro,
  quickAnswer,
  skillLevel,
  seo,
  datePublished,
  dateModified,
  "topics": topics[]-> { _id, title, "slug": slug.current }
`;

export const LEARNING_ARTICLES_LIST_QUERY = `*[_type == "learningArticle" && language == $lang && !(_id in path("drafts.**"))] | order(pageType asc, datePublished desc) {
  ${LEARNING_ARTICLE_FIELDS}
}`;

export const LEARNING_ARTICLES_BY_TYPE_QUERY = `*[_type == "learningArticle" && contentType == $contentType && language == $lang && !(_id in path("drafts.**"))] | order(pageType asc, datePublished desc) {
  ${LEARNING_ARTICLE_FIELDS}
}`;

export const LEARNING_ARTICLE_BY_SLUG_QUERY = `*[_type == "learningArticle" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  ${LEARNING_ARTICLE_FIELDS},
  content,
  commonMistakes,
  cta,
  language,
  translationOf,
  "relatedGuides": relatedGuides[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    intro,
    pageType,
    contentType,
    skillLevel
  },
  "relatedRules": relatedRules[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    quickAnswer,
    pageType
  },
  "relatedStrokes": relatedStrokes[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    shortDescription,
    category,
    difficulty
  },
  "relatedVideoTips": relatedVideoTips[]-> {
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

export async function getLearningArticleBySlug(slug: string, lang: string = 'en'): Promise<LearningArticleDetail | null> {
  return sanityClient.fetch<LearningArticleDetail | null>(LEARNING_ARTICLE_BY_SLUG_QUERY, { slug, lang });
}

export async function getLearningArticles(lang: string = 'en'): Promise<LearningArticleSummary[]> {
  return sanityClient.fetch<LearningArticleSummary[]>(LEARNING_ARTICLES_LIST_QUERY, { lang });
}

export async function getLearningArticlesByType(contentType: string, lang: string = 'en'): Promise<LearningArticleSummary[]> {
  return sanityClient.fetch<LearningArticleSummary[]>(LEARNING_ARTICLES_BY_TYPE_QUERY, { contentType, lang });
}

// ── Content type labels ──

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  'beginner-guide': 'Beginner Guide',
  'tactics': 'Tactics',
  'drills': 'Drills',
  'glossary': 'Glossary',
  'comparison': 'Comparison',
  'improvement': 'Improvement',
  'coach-intent': 'Finding a Coach',
};

export const SKILL_LEVEL_LABELS: Record<string, string> = {
  'beginner': 'Beginner',
  'intermediate': 'Intermediate',
  'advanced': 'Advanced',
};
