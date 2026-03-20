import { createClient } from '@sanity/client';
import imageUrlBuilder from '@sanity/image-url';

export const SANITY_PROJECT_ID = 'ru3aqhjn';
export const SANITY_DATASET = 'production';
export const SANITY_STUDIO_URL = 'https://padeltrainer.sanity.studio';

export const sanityClient = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  apiVersion: '2024-01-01',
  useCdn: true,
  perspective: 'published',
});

type SanityImageSource = Parameters<ReturnType<typeof imageUrlBuilder>['image']>[0];

const builder = imageUrlBuilder(sanityClient);

export function urlFor(source: SanityImageSource) {
  return builder.image(source);
}

// ── Shared Types ──

export interface SeoFields {
  titleTag?: string;
  metaDescription?: string;
  indexable?: boolean;
  breadcrumbLabel?: string;
}

export interface CtaFields {
  label?: string;
  url?: string;
}

export interface BodySection {
  heading: string;
  content: string;
}

// ── Blog Queries ──

export const BLOG_POSTS_QUERY = `*[_type == "blogPost" && language == $lang && !(_id in path("drafts.**"))] | order(datePublished desc) [$start...$end] {
  _id,
  title,
  "slug": slug.current,
  h1,
  excerpt,
  authorName,
  category,
  isFeatured,
  seo,
  cta,
  datePublished,
  dateModified,
  bodySections,
  content,
  audience,
  language,
  "topics": topics[]->{ _id, title, "slug": slug.current },
  "relatedGuides": relatedGuides[]->{ _id, title, "slug": slug.current, h1 },
  "relatedStrokes": relatedStrokes[]->{ _id, title, "slug": slug.current, h1, category, difficulty }
}`;

export const BLOG_POSTS_COUNT_QUERY = `count(*[_type == "blogPost" && language == $lang && !(_id in path("drafts.**"))])`;

export const BLOG_POSTS_BY_CATEGORY_QUERY = `*[_type == "blogPost" && category == $category && language == $lang && !(_id in path("drafts.**"))] | order(datePublished desc) [$start...$end] {
  _id,
  title,
  "slug": slug.current,
  h1,
  excerpt,
  authorName,
  category,
  isFeatured,
  seo,
  cta,
  datePublished,
  dateModified,
  bodySections,
  content,
  audience,
  language,
  "topics": topics[]->{ _id, title, "slug": slug.current },
  "relatedGuides": relatedGuides[]->{ _id, title, "slug": slug.current, h1 },
  "relatedStrokes": relatedStrokes[]->{ _id, title, "slug": slug.current, h1, category, difficulty }
}`;

export const BLOG_POSTS_BY_CATEGORY_COUNT_QUERY = `count(*[_type == "blogPost" && category == $category && language == $lang && !(_id in path("drafts.**"))])`;

export const BLOG_POST_BY_SLUG_QUERY = `*[_type == "blogPost" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  excerpt,
  bodySections,
  content,
  audience,
  authorName,
  category,
  isFeatured,
  seo,
  cta,
  datePublished,
  dateModified,
  language,
  translationOf,
  "topics": topics[]->{ _id, title, "slug": slug.current },
  "relatedGuides": relatedGuides[]->{ _id, title, "slug": slug.current, h1 },
  "relatedStrokes": relatedStrokes[]->{ _id, title, "slug": slug.current, h1, category, difficulty }
}`;

export const ALL_CATEGORIES_QUERY = `array::unique(*[_type == "blogPost" && language == $lang && !(_id in path("drafts.**"))].category)`;

// ── Rules Queries ──

export const RULES_LIST_QUERY = `*[_type == "rulesArticle" && language == $lang && !(_id in path("drafts.**"))] | order(datePublished desc) {
  _id,
  title,
  "slug": slug.current,
  h1,
  intro,
  quickAnswer,
  pageType,
  seo,
  datePublished,
  dateModified
}`;

export const RULES_BY_SLUG_QUERY = `*[_type == "rulesArticle" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  intro,
  quickAnswer,
  pageType,
  content,
  bodySections,
  commonMistakes,
  seo,
  cta,
  datePublished,
  dateModified,
  language,
  translationOf,
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
  }
}`;

// ── Stroke Queries ──

export const STROKES_LIST_QUERY = `*[_type == "stroke" && language == $lang && !(_id in path("drafts.**"))] | order(title asc) {
  _id,
  title,
  "slug": slug.current,
  h1,
  shortDescription,
  category,
  difficulty,
  seo
}`;

export const STROKE_BY_SLUG_QUERY = `*[_type == "stroke" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  shortDescription,
  category,
  difficulty,
  keyTips,
  bodySections,
  commonMistakes,
  seo,
  cta,
  language,
  translationOf,
  "relatedStrokes": relatedStrokes[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    shortDescription,
    category,
    difficulty
  },
  "relatedRules": relatedRules[]-> {
    _id,
    title,
    "slug": slug.current,
    h1,
    quickAnswer,
    pageType
  }
}`;

// ── Coach (CMS Trainer) Queries ──

export const COACHES_LIST_QUERY = `*[_type == "trainer" && language == $lang && !(_id in path("drafts.**"))] | order(name asc) {
  _id,
  name,
  "slug": slug.current,
  bio,
  specialties,
  "profileImageUrl": profileImage.asset->url,
  shortTagline,
  location,
  seo
}`;

export const COACH_BY_SLUG_QUERY = `*[_type == "trainer" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  _id,
  name,
  "slug": slug.current,
  bio,
  "specialties": specialties[]->title,
  "profileImageUrl": profileImage.asset->url,
  shortTagline,
  location,
  languages,
  "bestFor": bestFor[]->title,
  isFeatured,
  instagramUrl,
  youtubeUrl,
  tiktokUrl,
  websiteUrl,
  platformProfileUrl,
  seo,
  cta,
  language,
  translationOf
}`;

// ── Video Tip Queries ──

export const VIDEO_TIPS_BY_STROKE_QUERY = `*[_type == "videoTip" && references($strokeId) && language == $lang && !(_id in path("drafts.**"))] | order(datePublished desc) {
  _id,
  title,
  "slug": slug.current,
  videoUrl,
  platform,
  shortSummary,
  thumbnailUrl,
  isFeatured,
  skillLevel,
  tags,
  seo,
  cta,
  datePublished,
  "trainer": trainer-> {
    _id,
    name,
    "slug": slug.current
  }
}`;

export const VIDEO_TIPS_BY_TRAINER_QUERY = `*[_type == "videoTip" && trainer._ref == $trainerId && language == $lang && !(_id in path("drafts.**"))] | order(datePublished desc) {
  _id,
  title,
  "slug": slug.current,
  videoUrl,
  platform,
  shortSummary,
  thumbnailUrl,
  isFeatured,
  skillLevel,
  tags,
  seo,
  cta,
  datePublished,
  "strokes": strokes[]-> {
    _id,
    title,
    "slug": slug.current
  }
}`;

export const VIDEO_TIPS_LIST_QUERY = `*[_type == "videoTip" && language == $lang && !(_id in path("drafts.**"))] | order(isFeatured desc, datePublished desc) {
  _id,
  title,
  "slug": slug.current,
  videoUrl,
  platform,
  shortSummary,
  thumbnailUrl,
  isFeatured,
  skillLevel,
  tags,
  datePublished,
  "trainer": trainer-> {
    _id,
    name,
    "slug": slug.current
  },
  "strokes": strokes[]-> {
    _id,
    title,
    "slug": slug.current
  }
}`;

export const VIDEO_TIP_BY_SLUG_QUERY = `*[_type == "videoTip" && slug.current == $slug && language == $lang && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  videoUrl,
  platform,
  shortSummary,
  thumbnailUrl,
  isFeatured,
  skillLevel,
  tags,
  seo,
  cta,
  datePublished,
  dateModified,
  language,
  translationOf,
  "trainer": trainer-> {
    _id,
    name,
    "slug": slug.current,
    profileImageUrl
  },
  "strokes": strokes[]-> {
    _id,
    title,
    "slug": slug.current
  }
}`;
