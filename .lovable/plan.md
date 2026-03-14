

# Sanity CMS Integration for Blog & Rules

## Scope

Replace the current database-backed blog with Sanity CMS for content management, and add a new Rules section also powered by Sanity. The AI generation pipeline (edge functions) stays in place but becomes optional — content is primarily authored/managed in Sanity Studio.

## Step 1: Connect Sanity MCP

Use `mcp_knowledge--connect` with `connector_id: "sanity"` to connect the Sanity MCP connector. This gives us the project ID, schema discovery, and CORS management tools. No manual project ID needed.

## Step 2: Install Dependencies

- `@sanity/client` — query content from Sanity CDN
- `@sanity/image-url` — build optimized image URLs
- `@portabletext/react` — render Sanity's Portable Text (rich text format, replaces raw HTML)

## Step 3: Create Sanity Client

New file: `src/lib/sanity.ts`
- Configure client with project ID from MCP, dataset `production`, CDN enabled
- Export `urlFor()` helper for images
- Export typed query functions for blog posts and rules pages

## Step 4: Sanity Content Types

These need to be created in Sanity Studio by the user. We document what's needed:

**Blog Post** (`post`):
- title, slug, excerpt, body (Portable Text), mainImage, author, publishedAt, tags, locale, canonicalRef, metaTitle, metaDescription, primaryKeyword

**Rules Page** (`rulesPage`):
- title, slug, body (Portable Text), locale, order (for menu sorting), category, metaTitle, metaDescription

## Step 5: Update Blog Frontend

**`src/lib/blog.ts`** — Replace all Supabase queries with Sanity GROQ queries:
- `getPublishedArticles()` → `*[_type == "post" && locale == $locale] | order(publishedAt desc)`
- `getArticleBySlug()` → `*[_type == "post" && slug.current == $slug && locale == $locale][0]`
- `getRelatedArticles()` → query by overlapping tags
- `getAllTags()` → `*[_type == "post" && locale == $locale].tags[]` with distinct

**`src/pages/marketing/Blog.tsx`** — Update to use new query functions. Replace `body_html` rendering with `<PortableText>` component. Image URLs via `urlFor()`.

**`src/pages/marketing/BlogPost.tsx`** — Same: Portable Text renderer, Sanity image URLs, keep SEO/structured data/hreflang logic intact.

## Step 6: Create Rules Section

- New page: `src/pages/marketing/Rules.tsx` — list of rules categories/pages
- New page: `src/pages/marketing/RulesPage.tsx` — single rules page with Portable Text content
- Add routes in `DomainRouter.tsx`
- Add "Rules" to marketing navigation

## Step 7: Update Admin Blog Pages

The admin blog UI (`AdminBlog.tsx`, `AdminBlogEditor.tsx`, `AdminBlogTopics.tsx`) becomes a dashboard that links to Sanity Studio for editing. Options:
- Keep as read-only overview showing what's published (still queries Sanity)
- Add "Edit in Sanity" buttons that open the Sanity Studio URL
- The AI generation edge functions can remain for generating drafts, but would need a future step to push content to Sanity via its write API

## Step 8: CORS Setup

Use the Sanity MCP `add_cors_origin` tool to allowlist:
- `https://*.lovableproject.com` (preview)
- `https://padeltrainer.lovable.app` (published)
- Production domain when ready

## Files Changed/Created

| File | Action |
|------|--------|
| `src/lib/sanity.ts` | Create — client, image helper, query functions |
| `src/lib/blog.ts` | Rewrite — Sanity queries instead of Supabase |
| `src/pages/marketing/Blog.tsx` | Update — Portable Text, Sanity images |
| `src/pages/marketing/BlogPost.tsx` | Update — Portable Text, Sanity images |
| `src/pages/marketing/Rules.tsx` | Create — rules listing page |
| `src/pages/marketing/RulesPage.tsx` | Create — single rules page |
| `src/components/DomainRouter.tsx` | Update — add rules routes |
| `src/components/marketing/MarketingLayout.tsx` | Update — add Rules nav link |
| `src/pages/admin/AdminBlog.tsx` | Update — read from Sanity, add Studio links |

## What Stays Unchanged

- Database `articles` table — kept for the AI generation pipeline (can sync to Sanity later)
- Edge functions (`generate-blog-article`, `translate-blog-article`, etc.) — untouched for now
- All non-blog/rules pages — no changes
- Clubs/locations — remain fully database-driven as discussed

