
# Sanity CMS Integration for Blog & Rules

## Status: ✅ COMPLETED

Implemented on 2026-03-14.

## What Changed

1. **Sanity Client** (`src/lib/sanity.ts`) — Connected to project `ru3aqhjn` with GROQ queries for blog posts and rules articles.
2. **Blog Data Layer** (`src/lib/blog.ts`) — Rewrote all functions to use Sanity GROQ queries instead of Supabase. Types updated (`_id`, `publishedAt`, `mainImage`, Portable Text `body`).
3. **Blog Pages** — `Blog.tsx` and `BlogPost.tsx` now use Sanity images via `@sanity/image-url` and render body content with `@portabletext/react`.
4. **Rules Section** — New `Rules.tsx` (listing) and `RulesPage.tsx` (detail) pages using the `rulesArticle` content type from Sanity.
5. **Routes** — Added `/rules` and `/rules/:slug` routes in `DomainRouter.tsx`.
6. **Navigation** — Added "Rules" link to marketing nav in `MarketingLayout.tsx`.
7. **Admin Blog** — `AdminBlog.tsx` now reads from Sanity and links to Sanity Studio for editing.
8. **CORS** — Added `https://*.lovableproject.com` and `https://padeltrainer.lovable.app` origins.

## Sanity Content Types Needed in Studio

**Blog Post** (`post`): title, slug, excerpt, body (Portable Text), mainImage, author (reference), publishedAt, tags, locale, canonicalRef, metaTitle, metaDescription, primaryKeyword

**Rules Article** (`rulesArticle`): ✅ Already exists with title, slug, pageType, h1, intro, quickAnswer, bodySections, commonMistakes, seo, relatedRules, cta, datePublished, dateModified.

## What Stays Unchanged

- Database `articles` table — kept for the AI generation pipeline
- Edge functions — untouched
- Clubs/locations — remain database-driven
