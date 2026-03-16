

## Upgrade Topic Pillar Pages — Implementation Plan

### Overview
Transform topic pages from basic archive listings into full SEO pillar hubs by adding reverse article queries, article counts, Table of Contents, "Start Here" section, grouped articles by content type, and a trainer CTA.

### Changes

#### 1. `src/lib/topics.ts` — Data layer updates

- **Add `articleCount` to `TOPICS_LIST_QUERY`** (and `ALL_TOPICS_LIST_QUERY`):
  ```groq
  "articleCount": count(*[_type == "learningArticle" && references(^._id) && !(_id in path("drafts.**"))])
  ```
- **Add reverse article query to `TOPIC_BY_SLUG_QUERY`**:
  ```groq
  "referencingArticles": *[_type == "learningArticle" && references(^._id) && !(_id in path("drafts.**"))] | order(datePublished desc) {
    _id, title, "slug": slug.current, h1, intro, contentType, skillLevel, datePublished
  }
  ```
- **Update `TopicSummary`** type: add `articleCount: number`
- **Update `TopicDetail`** type: add `referencingArticles` array type
- **Add `ItemList` structured data builder** in the detail query helpers or inline in the page

#### 2. `src/pages/marketing/TopicPage.tsx` — Full layout restructure

Reorder and add sections in this sequence:

**A. Hero** (existing, enhanced)
- Keep h1, intro, badges
- Add article count badge: `"{N} articles"` if `referencingArticles.length > 0`

**B. Table of Contents** (new)
- Use existing `extractHeadings` from `PortableTextRenderer` + `TableOfContents` component
- Only show if `topic.content` has 2+ headings

**C. Portable Text content** (existing, keep as-is)

**D. "Start Here" section** (new)
- Use `featuredGuides` (first 6) if available
- Distinct visual: slightly different background (`bg-accent/10` or border highlight)
- Heading: "Start Here" with BookOpen icon
- If no featuredGuides, use first 3 `referencingArticles` as fallback

**E. "All Articles" / Grouped article blocks** (new)
- Show all `referencingArticles` (excluding those already in "Start Here")
- If 3+ articles of a single `contentType` exist, group into sub-sections (Tactics, Drills, Improvement, etc.) using `CONTENT_TYPE_LABELS`
- Otherwise show flat list
- Each card: title, intro (line-clamp-2), contentType badge, skillLevel badge, link to `/learn/{slug}`

**F. Supporting resources** (existing sections — rules, strokes, videos, trainers — no changes needed, just reordered after articles)

**G. Related Topics** (existing, no changes)

**H. CTA section** (new)
- Reuse existing `CTASection` component
- Pass contextual fallback: `"Work on ${topic.h1} with a trainer"` as label, `/trainers` as URL

**I. Parent Topic** (existing, no changes)

**Structured data enhancement**: Add `ItemList` schema for `referencingArticles` to the `buildStructuredData` function.

#### 3. `src/pages/marketing/TopicsIndex.tsx` — Index page enhancements

- Add intro paragraph below title explaining the hub purpose
- Show article count badge on each topic card (e.g. `"12 articles"`)
- Use updated `TopicSummary` type with `articleCount`

### Files to modify
- `src/lib/topics.ts`
- `src/pages/marketing/TopicPage.tsx`
- `src/pages/marketing/TopicsIndex.tsx`

