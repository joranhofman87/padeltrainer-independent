

## Add Topic Pages (`/topics/[slug]` and `/topics`)

### What we're building
Dedicated topic cluster pages fetched from the Sanity `topic` document type. These act as supporting SEO cluster pages — narrower than hubs, linking out to related content across the site. Topic pages that overlap with existing hubs (e.g., "strokes", "tactics", "drills", "rules", "beginner") respect `isIndexable` so they can be kept noindex.

### Files to create

**1. `src/lib/topics.ts`** — Types, GROQ queries, fetch helpers
- `TopicSummary` type (title, slug, description, contentType, skillLevel, isIndexable)
- `TopicDetail` type (extends with h1, intro, content, featuredGuides, featuredRules, featuredStrokes, featuredVideoTips, featuredTrainers, relatedTopics, parentTopic, seo)
- `TOPICS_LIST_QUERY` — fetch all topics where `isIndexable != false`
- `TOPIC_BY_SLUG_QUERY` — fetch single topic with all dereferenced featured/related arrays
- `getTopicBySlug(slug)` and `getTopics()` helpers

**2. `src/pages/marketing/TopicPage.tsx`** — Dynamic `/topics/:slug` page
- Fetch topic by slug via TanStack Query (staleTime 10min)
- SEO: title from `seo.titleTag`, description from `seo.metaDescription`, noIndex from `isIndexable`, canonical URL, OG/Twitter via existing `<SEO>` component
- Breadcrumbs: Home → Topics → Topic Name (using existing `<Breadcrumbs>` component)
- Page structure:
  - H1 from `h1`
  - Intro paragraph
  - Portable Text content (using existing `PortableTextRenderer`)
  - Featured Guides section (cards linking to `/learn/:slug`)
  - Featured Rules section (cards linking to `/padel-rules/:slug`)
  - Featured Strokes section (cards linking to `/padel-strokes/:slug`)
  - Featured Video Tips section (cards linking to `/video-tips/:slug`)
  - Featured Trainers section (cards linking to `/trainer/:slug`)
  - Related Topics section (chips/links to `/topics/:slug`)
- Structured data: `CollectionPage` + `WebPage` + `BreadcrumbList`
- Null-safe: all featured arrays render only when non-empty
- Skeleton loader while loading

**3. `src/pages/marketing/TopicsIndex.tsx`** — `/topics` overview page
- Fetch all indexable topics
- Grid of topic cards linking to `/topics/:slug`
- SEO with CollectionPage + ItemList structured data
- Simple, clean layout

### Files to modify

**4. `src/components/DomainRouter.tsx`**
- Add lazy imports for `TopicPage` and `TopicsIndex`
- Add routes under `/:lang`:
  - `topics` → `TopicsIndex`
  - `topics/:slug` → `TopicPage`

**5. `src/pages/marketing/LearningArticlePage.tsx`**
- Update topic chip links from `/learn?topic=${slug}` to `/topics/${slug}` (now that topic pages exist)

**6. `supabase/functions/sitemap/index.ts`**
- Add Sanity query for topics: fetch all topics, include only those with `isIndexable != false`
- Generate URL entries at `/topics/:slug` with priority 0.6
- Add `/topics` to static pages list

**7. `supabase/functions/render-page/index.ts`**
- Add `/topics` and `/topics/:slug` to pre-rendering paths (if not already covered by the exclusion-based logic)

### Overlapping topics strategy
Topics like "beginner", "strokes", "tactics", "drills", "rules" overlap with existing hub pages. The implementation respects `isIndexable` from Sanity — if set to `false`, the page renders with `noindex, nofollow` and is excluded from the sitemap. This gives full CMS control over which topics compete for rankings.

### Summary of potential hub overlaps
- `beginner` → overlaps with beginner-guide hub articles
- `strokes` → overlaps with `/padel-strokes`
- `tactics` → overlaps with tactics hub articles
- `drills` → overlaps with drills hub articles
- `rules` → overlaps with `/padel-rules`
- Good standalone topics: serve, volley, overhead, defense, doubles, coaching

