

# Hub Pages for Blog Post Pillar Content

## What this does
When a blog post matches one of 5 specific hub slugs, the page renders with an enhanced layout: a styled hero section with a "Guide" badge, an auto-generated Table of Contents, wider content area (900px vs 720px), and a "Related Guides" card grid showing the spoke articles fetched from Sanity.

Regular blog posts are completely unaffected.

## How it works

**Detection**: A config file maps each hub slug to its spoke article slugs. The existing `BlogPost.tsx` checks if the current slug is a hub page and conditionally renders the hub layout.

**Spoke data**: A single GROQ query fetches all spoke articles by their slugs in one request. Results are reordered to match the config order.

**TOC**: Already built — `extractHeadings()` and `TableOfContents` component exist. Just need to wire them into the hub layout.

**SEO**: Hub pages get `CollectionPage` structured data with `hasPart` linking to all spokes, instead of the regular `Article` schema.

## Files

| File | Change |
|------|--------|
| `src/lib/hubPages.ts` | **New** — Hub slug config, spoke mappings, metadata, and `getSpokeArticles()` fetch function |
| `src/components/blog/HubHero.tsx` | **New** — Hero section with badge, title, excerpt, date, read time |
| `src/components/blog/RelatedGuidesSection.tsx` | **New** — 2-col responsive card grid for spoke articles |
| `src/components/blog/GuideCard.tsx` | **New** — Individual spoke card with category badge, title, excerpt, "Read guide →" link |
| `src/pages/marketing/BlogPost.tsx` | Modified — if `isHubPage`, render hub layout (hero + TOC + wider content + related guides) instead of standard layout; swap structured data to `CollectionPage` |

## Layout structure (hub pages only)

```text
┌─────────────────────────────────────┐
│  ← Back to Blog                     │
├─────────────────────────────────────┤
│  Breadcrumbs: Home > Blog > [Title] │
├─────────────────────────────────────┤
│  [Guide badge]                      │
│  H1 Title                           │
│  Date · Read time · Author · Share  │
├─────────────────────────────────────┤
│  Table of Contents (collapsible)    │
├─────────────────────────────────────┤
│  Article content (max-w 900px)      │
├─────────────────────────────────────┤
│  ── Related Guides ──               │
│  ┌─────────┐  ┌─────────┐          │
│  │ Card 1  │  │ Card 2  │          │
│  └─────────┘  └─────────┘          │
│  ┌─────────┐  ┌─────────┐          │
│  │ Card 3  │  │ Card 4  │          │
│  └─────────┘  └─────────┘          │
├─────────────────────────────────────┤
│  CTA Section                        │
└─────────────────────────────────────┘
```

## Technical details

- **GROQ query** for spokes: `*[_type == "blogPost" && slug.current in $slugs && language == $lang]{title, "slug": slug.current, excerpt, category}`
- Spoke results sorted client-side to match config order
- TOC uses existing `extractHeadings()` from `PortableTextRenderer.tsx` — only rendered when content has 2+ headings
- Card hover: elevated shadow + green left border
- Cards link to `/<locale>/blog/<spoke-slug>` via `LocalizedLink`
- `CollectionPage` schema includes `hasPart` array with each spoke's title and URL
- No new dependencies needed

