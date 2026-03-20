

# Multilingual CMS Content Support

## Problem
All Sanity GROQ queries currently fetch content without filtering by `language`. Now that Sanity documents have a `language` field and `translationOf` references linking translations together, the frontend needs to:
1. Filter all content queries by the current language
2. Fetch translated document slugs for the language switcher on content pages
3. Generate correct hreflang tags with translated slugs (not same slug per language)
4. Update the sitemap to include language-specific Sanity content URLs

## Changes

### 1. Add `language` filter to all GROQ queries (`src/lib/sanity.ts`)

Every query gets `&& language == $lang` added to its filter. Affected queries:
- `BLOG_POSTS_QUERY`, `BLOG_POSTS_COUNT_QUERY`, `BLOG_POSTS_BY_CATEGORY_QUERY`, `BLOG_POSTS_BY_CATEGORY_COUNT_QUERY`, `BLOG_POST_BY_SLUG_QUERY`
- `RULES_LIST_QUERY`, `RULES_BY_SLUG_QUERY`
- `STROKES_LIST_QUERY`, `STROKE_BY_SLUG_QUERY`
- `COACHES_LIST_QUERY`, `COACH_BY_SLUG_QUERY`
- `VIDEO_TIPS_LIST_QUERY`, `VIDEO_TIP_BY_SLUG_QUERY`, `VIDEO_TIPS_BY_STROKE_QUERY`, `VIDEO_TIPS_BY_TRAINER_QUERY`

Also add `language` and `translationOf` to detail query projections for translation lookups.

### 2. Add `language` filter to learning article queries (`src/lib/learningArticles.ts`)

Same pattern: `LEARNING_ARTICLES_LIST_QUERY`, `LEARNING_ARTICLES_BY_TYPE_QUERY`, `LEARNING_ARTICLE_BY_SLUG_QUERY`.

### 3. Create translation helper (`src/lib/translations.ts`)

```ts
export async function getTranslations(docId, docType, currentLang)
```

Given a document, finds the English root (via `translationOf._ref` or self if English), then fetches all sibling translations returning `{ language, slug }[]`. Used by content pages to power the language switcher and hreflang tags.

### 4. Update all fetch functions to accept `lang` parameter

- `src/lib/blog.ts`: `getPublishedArticles(page, category, lang)`, `getArticleBySlug(slug, lang)`
- `src/lib/learningArticles.ts`: all fetch helpers get a `lang` param
- Direct `sanityClient.fetch` calls in page components pass `lang` from `useCurrentLanguage()`

### 5. Update all content page components to pass `lang`

Every page that fetches Sanity content needs to:
- Get current language via `useCurrentLanguage()` (already exists in `useLocalizedPath.ts`)
- Pass it to the fetch function / query params
- Include `lang` in the `queryKey` so TanStack refetches on language change

Affected pages (9 files):
- `BlogPost.tsx`, `Blog.tsx`
- `RulesPage.tsx`, `Rules.tsx`
- `StrokePage.tsx`, `Strokes.tsx`
- `CoachPage.tsx`, `Coaches.tsx`
- `VideoTipPage.tsx`, `VideoTips.tsx`
- `LearningArticlePage.tsx`

### 6. Update `SEO.tsx` hreflang to use translated slugs

Currently generates hreflang assuming same slug for all languages. Add an optional `translations` prop:

```ts
interface SEOProps {
  // ... existing
  translations?: { language: string; slug: string }[];
  pathPrefix?: string; // e.g. 'blog', 'padel-rules'
}
```

When `translations` is provided, generate hreflang tags using the actual translated slugs instead of the current path.

### 7. Update `LanguageSwitcher.tsx` for content pages

The current switcher just swaps the lang prefix, keeping the same path. For CMS content pages, it needs to link to the translated slug. Add support for a "translations context" — content pages can provide available translations, and the switcher links to the correct slug per language. If no translation exists for a language, that option is hidden or disabled.

This will use a React context (`TranslationsContext`) that content pages populate after fetching translations.

### 8. Update sitemap edge function

Currently the Sanity content section generates one URL per slug across all 5 languages (assuming same slug). Update to:
- Fetch `language` and `slug` from each Sanity doc
- Group by `translationOf` reference to build translation groups
- Generate proper `xhtml:link` alternates pointing to actual translated slugs

### 9. Update banner query in `src/lib/banners.ts`

Add `&& language == $lang` to the banner GROQ query as well (banners already have `targetLanguages` client-side filtering, but if banners themselves have a `language` field this should be added).

## Scope

This is a large change touching ~15 files. Recommended implementation order:
1. **Batch 1**: Query updates + fetch function signatures (sanity.ts, blog.ts, learningArticles.ts, translations.ts)
2. **Batch 2**: Page components wired up with lang param (9 page files)
3. **Batch 3**: SEO hreflang + LanguageSwitcher + TranslationsContext
4. **Batch 4**: Sitemap edge function update

