

# Automated Multilingual Blog System

## Overview

Replace the current Contentful-based blog with a fully self-hosted, automated, multilingual blog system powered by your existing backend. This includes database tables, public blog pages, an admin CMS, and AI-powered content generation with scheduled automation.

---

## Phase 1: Cleanup -- Remove Contentful

**What gets removed:**
- `src/lib/contentful.ts` (Contentful client and data fetchers)
- npm packages: `contentful`, `@contentful/rich-text-react-renderer` (and its types dependency `@contentful/rich-text-types` if unused elsewhere)
- Environment variables: `VITE_CONTENTFUL_SPACE_ID`, `VITE_CONTENTFUL_ACCESS_TOKEN` (currently referenced in code but not in `.env` -- just clean up code references)
- Blog pages (`Blog.tsx`, `BlogPost.tsx`) will be **rewritten** to use the new database, not removed

**What stays:**
- Blog routes in `DomainRouter.tsx` (`/:lang/blog` and `/:lang/blog/:slug`) -- these stay but point to rewritten components
- Marketing translation keys for blog UI (`blog.title`, `blog.subtitle`, etc.)

---

## Phase 2: Database Schema

Four new tables with RLS policies:

### A) `articles`
Core blog content table with multilingual support via `canonical_id` grouping.

Key columns: `id`, `canonical_id`, `locale`, `title`, `slug` (unique per locale), `excerpt`, `body_html`, `body_md`, `status` (draft/review/published), `published_at`, `author_name`, `cover_image_url`, `tags`, `primary_keyword`, `meta_title`, `meta_description`, `created_at`, `updated_at`

Indexes: unique on `(locale, slug)`, index on `(status, published_at)`, index on `canonical_id`

RLS:
- Public: SELECT where `status = 'published'`
- Admin: full CRUD

### B) `content_topics`
Topic queue for the automation pipeline.

Columns: `id`, `primary_keyword`, `locales` (text array), `angle`, `notes`, `status` (queued/in_progress/done/failed), `created_at`, `updated_at`

RLS: Admin only (all operations)

### C) `sources`
Reference URLs used during article generation.

Columns: `id`, `article_id` (FK to articles), `source_url`, `source_title`, `notes`, `allowed_to_use`, `retrieved_at`

RLS: Admin only

### D) `internal_links`
Cross-linking between articles.

Columns: `id`, `from_slug`, `to_slug`, `locale`, `anchor_text`

RLS: Admin only

---

## Phase 3: Public Blog Pages

### Blog Index (`/:lang/blog`)
- Fetches published articles for current locale from the database
- Featured post (latest) + grid of recent posts
- Pagination support
- Tag filtering
- SEO: structured data (Blog schema), hreflang tags, meta tags
- Locale switcher integration (already exists in marketing layout)
- Reuses existing UI patterns (cards, skeletons, motion animations)

### Blog Post (`/:lang/blog/:slug`)
- Fetches article by slug + locale
- Renders `body_html` directly (no rich-text renderer needed -- simpler and better for SEO)
- Related posts section (same locale, shared tags)
- hreflang links to translations (found via `canonical_id`)
- Article structured data (JSON-LD)
- CTA at bottom
- Cover image, author, date, read time (calculated from HTML word count)

### New data layer: `src/lib/blog.ts`
- `getPublishedArticles(locale, page, tag?)` -- paginated list
- `getArticleBySlug(slug, locale)` -- single article + translations
- `getRelatedArticles(articleId, locale, tags)` -- related posts

---

## Phase 4: Admin CMS

### New admin routes (under `/app/admin`)
- `/app/admin/blog` -- Article list with filters (locale, status, tags)
- `/app/admin/blog/new` -- Create article
- `/app/admin/blog/:id` -- Edit article
- `/app/admin/blog/topics` -- Topic queue management
- `/app/admin/blog/:id/sources` -- Sources view per article

### Admin sidebar update
Add a "Content" section to `AdminSidebar.tsx` with links to Blog and Topics.

### Article Editor
- Title, slug (auto-generated from title), locale, excerpt, tags, primary keyword
- Markdown editor (using existing TipTap editor or a simpler textarea) with live HTML preview
- Cover image upload (to existing `avatars` bucket or a new `blog-images` bucket)
- Status transitions: draft -> review -> published (publishing auto-sets `published_at`)
- Translation panel: view all translations by `canonical_id`, button to trigger translation generation

### Topic Queue
- Table view of topics with status, keyword, locales, angle
- Add/edit topics
- Trigger generation manually per topic

---

## Phase 5: Automation Pipeline (Edge Functions)

### A) `generate-blog-article`
- Input: `topic_id`
- Uses AI (Lovable AI / supported models) to generate article content
- Produces: title, slug, excerpt, body in HTML, meta title/description, tags
- Stores in `articles` with `status = 'review'`
- Stores sources in `sources` table
- Updates topic status to `done` or `failed`

### B) `translate-blog-article`
- Input: `article_id`, `target_locale`
- Takes original article as base
- Generates localized translation (title, slug, excerpt, body, meta fields)
- Creates new article row with same `canonical_id`, `status = 'review'`

### C) `process-blog-queue` (scheduled)
- Picks N queued topics (1-3 per run)
- Calls `generate-blog-article` for each
- Optionally triggers translations for configured locales
- Scheduled via pg_cron (daily at a configured time)

### Content guardrails
- Focus on how-to/framework content (no factual claims)
- Padel-only, aligned with platform positioning
- Sources stored but no copy-paste of long text
- AI model: `google/gemini-2.5-flash` for cost-efficient generation

---

## Phase 6: SEO Integration

### Sitemap updates
- Update `supabase/functions/sitemap/index.ts` to include published blog articles for all locales
- Include `lastmod` from `updated_at`/`published_at`
- Include hreflang links between translations

### Render-page updates
- Add blog route handling to `supabase/functions/render-page/index.ts` for bot/crawler pre-rendering
- Render full HTML for `/blog` and `/blog/:slug` routes

### robots.txt
- Already allows `/blog` crawling (no changes needed)

### On-page SEO
- Canonical URLs per locale
- hreflang tags linking translations via `canonical_id`
- OpenGraph + Twitter cards
- Article JSON-LD structured data

---

## Technical Details

### Files to create
- `src/lib/blog.ts` -- Data fetching layer
- `src/pages/marketing/Blog.tsx` -- Rewrite (replace Contentful with database)
- `src/pages/marketing/BlogPost.tsx` -- Rewrite
- `src/pages/admin/AdminBlog.tsx` -- Article list
- `src/pages/admin/AdminBlogEditor.tsx` -- Create/edit article
- `src/pages/admin/AdminBlogTopics.tsx` -- Topic queue
- `src/pages/admin/AdminBlogSources.tsx` -- Sources per article
- `supabase/functions/generate-blog-article/index.ts`
- `supabase/functions/translate-blog-article/index.ts`
- `supabase/functions/process-blog-queue/index.ts`

### Files to modify
- `src/components/DomainRouter.tsx` -- Add admin blog routes
- `src/components/admin/AdminSidebar.tsx` -- Add Content nav section
- `supabase/functions/sitemap/index.ts` -- Add blog articles
- `supabase/functions/render-page/index.ts` -- Add blog rendering
- `package.json` -- Remove `contentful` and `@contentful/rich-text-react-renderer`

### Files to delete
- `src/lib/contentful.ts`

### Database migration
- Create `articles`, `content_topics`, `sources`, `internal_links` tables
- Add RLS policies using existing `is_admin()` function
- Add indexes
- Optionally create a `blog-images` storage bucket

### Scheduling
- pg_cron job calling `process-blog-queue` edge function daily

