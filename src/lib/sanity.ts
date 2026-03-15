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

export const BLOG_POSTS_QUERY = `*[_type == "blogPost" && !(_id in path("drafts.**"))] | order(datePublished desc) [$start...$end] {
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
  bodySections
}`;

export const BLOG_POSTS_COUNT_QUERY = `count(*[_type == "blogPost" && !(_id in path("drafts.**"))])`;

export const BLOG_POSTS_BY_CATEGORY_QUERY = `*[_type == "blogPost" && category == $category && !(_id in path("drafts.**"))] | order(datePublished desc) [$start...$end] {
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
  bodySections
}`;

export const BLOG_POSTS_BY_CATEGORY_COUNT_QUERY = `count(*[_type == "blogPost" && category == $category && !(_id in path("drafts.**"))])`;

export const BLOG_POST_BY_SLUG_QUERY = `*[_type == "blogPost" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  excerpt,
  bodySections,
  authorName,
  category,
  isFeatured,
  seo,
  cta,
  datePublished,
  dateModified
}`;

export const ALL_CATEGORIES_QUERY = `array::unique(*[_type == "blogPost" && !(_id in path("drafts.**"))].category)`;

// ── Rules Queries ──

export const RULES_LIST_QUERY = `*[_type == "rulesArticle" && !(_id in path("drafts.**"))] | order(datePublished desc) {
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

export const RULES_BY_SLUG_QUERY = `*[_type == "rulesArticle" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  h1,
  intro,
  quickAnswer,
  pageType,
  bodySections,
  commonMistakes,
  seo,
  cta,
  datePublished,
  dateModified,
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

export const STROKES_LIST_QUERY = `*[_type == "stroke" && !(_id in path("drafts.**"))] | order(title asc) {
  _id,
  title,
  "slug": slug.current,
  h1,
  shortDescription,
  category,
  difficulty,
  seo
}`;

export const STROKE_BY_SLUG_QUERY = `*[_type == "stroke" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
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

export const COACHES_LIST_QUERY = `*[_type == "trainer" && !(_id in path("drafts.**"))] | order(name asc) {
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

export const COACH_BY_SLUG_QUERY = `*[_type == "trainer" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
  _id,
  name,
  "slug": slug.current,
  bio,
  specialties,
  "profileImageUrl": profileImage.asset->url,
  shortTagline,
  location,
  languages,
  bestFor,
  isFeatured,
  instagramUrl,
  youtubeUrl,
  tiktokUrl,
  websiteUrl,
  platformProfileUrl,
  seo,
  cta
}`;

// ── Video Tip Queries ──

export const VIDEO_TIPS_BY_STROKE_QUERY = `*[_type == "videoTip" && references($strokeId) && !(_id in path("drafts.**"))] | order(datePublished desc) {
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

export const VIDEO_TIPS_BY_TRAINER_QUERY = `*[_type == "videoTip" && trainer._ref == $trainerId && !(_id in path("drafts.**"))] | order(datePublished desc) {
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

export const VIDEO_TIPS_LIST_QUERY = `*[_type == "videoTip" && !(_id in path("drafts.**"))] | order(isFeatured desc, datePublished desc) {
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

export const VIDEO_TIP_BY_SLUG_QUERY = `*[_type == "videoTip" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
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
