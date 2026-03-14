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
});

type SanityImageSource = Parameters<ReturnType<typeof imageUrlBuilder>['image']>[0];

const builder = imageUrlBuilder(sanityClient);

export function urlFor(source: SanityImageSource) {
  return builder.image(source);
}

// ── GROQ Queries ──

export const BLOG_POSTS_QUERY = `*[_type == "post" && locale == $locale && !(_id in path("drafts.**"))] | order(publishedAt desc) [$start...$end] {
  _id,
  title,
  "slug": slug.current,
  excerpt,
  body,
  mainImage,
  publishedAt,
  tags,
  locale,
  "author": author->{ name, image },
  metaTitle,
  metaDescription,
  primaryKeyword
}`;

export const BLOG_POSTS_COUNT_QUERY = `count(*[_type == "post" && locale == $locale && !(_id in path("drafts.**"))])`;

export const BLOG_POSTS_BY_TAG_QUERY = `*[_type == "post" && locale == $locale && $tag in tags && !(_id in path("drafts.**"))] | order(publishedAt desc) [$start...$end] {
  _id,
  title,
  "slug": slug.current,
  excerpt,
  body,
  mainImage,
  publishedAt,
  tags,
  locale,
  "author": author->{ name, image },
  metaTitle,
  metaDescription,
  primaryKeyword
}`;

export const BLOG_POSTS_BY_TAG_COUNT_QUERY = `count(*[_type == "post" && locale == $locale && $tag in tags && !(_id in path("drafts.**"))])`;

export const BLOG_POST_BY_SLUG_QUERY = `*[_type == "post" && slug.current == $slug && locale == $locale && !(_id in path("drafts.**"))][0] {
  _id,
  title,
  "slug": slug.current,
  excerpt,
  body,
  mainImage,
  publishedAt,
  _updatedAt,
  tags,
  locale,
  canonicalRef,
  "author": author->{ name, image },
  metaTitle,
  metaDescription,
  primaryKeyword,
  "translations": *[_type == "post" && canonicalRef == ^.canonicalRef && _id != ^._id && !(_id in path("drafts.**"))] {
    locale,
    "slug": slug.current
  }
}`;

export const RELATED_POSTS_QUERY = `*[_type == "post" && locale == $locale && _id != $id && count(tags[@ in $tags]) > 0 && !(_id in path("drafts.**"))] | order(publishedAt desc) [0...$limit] {
  _id,
  title,
  "slug": slug.current,
  mainImage,
  publishedAt,
  tags
}`;

export const ALL_TAGS_QUERY = `array::unique(*[_type == "post" && locale == $locale && !(_id in path("drafts.**"))].tags[])`;

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
  }
}`;
