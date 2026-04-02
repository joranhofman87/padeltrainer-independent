

# SEO & UX Improvements Across 5 Marketing Pages

This is a large scope touching 5 pages. I recommend implementing in 4 phases as outlined in the prompt, focusing on highest SEO impact first.

## Phase 1: Quick Fixes + Intro Paragraphs + BreadcrumbList Schemas

### 1.1 Rules page (`src/pages/marketing/Rules.tsx`)
- **Fix whitespace**: The CTA section uses `bg-accent/30` with `py-16` — the gap is likely between the content section and CTA. Inspect and tighten spacing.
- **Update meta description** to: "Learn the official padel court rules, serving regulations, and scoring system. Master the fundamentals every player needs to know."
- **Add intro paragraph** below hero h1/subtitle, above cards.
- **Add BreadcrumbList** structured data (Home > Learn > Padel Rules).
- **Add FAQPage** structured data with 5-6 common padel rules questions.
- **Add "Related Learning"** internal links section at the bottom (link to strokes + blog posts).

### 1.2 Strokes page (`src/pages/marketing/Strokes.tsx`)
- **Null description fallback**: If `shortDescription` is null, show a generic fallback string.
- **Add intro paragraph** above the stroke grid.
- **Add BreadcrumbList** structured data.

### 1.3 Video Tips page (`src/pages/marketing/VideoTips.tsx`)
- **Add intro paragraph** below hero.
- **Add VideoObject** structured data for each video.
- **Add BreadcrumbList** structured data.
- **Add "Want More?" CTA** section at the bottom.

### 1.4 Blog page (`src/pages/marketing/Blog.tsx`)
- **Fix subtitle** i18n key — change from "Tips, insights, and stories from the Dutch padel community" to "Tips, tactics, and insights for padel players at every level".
- **Show author name**: Already partially implemented (line 194), ensure fallback to "Padel Trainer AI".
- **Fix date display**: The `datePublished` field is already rendered from Sanity — likely a Sanity data issue (all posts have same date). No code fix needed if Sanity data is correct.
- **Add BreadcrumbList** structured data.

### 1.5 Racket Finder page (`src/pages/marketing/RacketFinder.tsx`)
- Already has FAQPage structured data and SEO content section (`RacketFinderContent`).
- **Add BreadcrumbList** structured data.
- **Add "Related Resources"** internal links section at the bottom of `RacketFinderContent.tsx`.

## Phase 2: Filtering & UI Components

### 2.1 Strokes — Difficulty filter tabs
- Add "All | Beginner | Intermediate | Advanced" tabs above the grid.
- Filter strokes by `difficulty` field.
- Store in URL query param (`?level=beginner`).

### 2.2 Strokes — "Start Here" beginner section
- Visual banner with 5 essential strokes (Forehand, Backhand, Serve, Return, Volley).
- Orange accent styling, hide when filtering by intermediate/advanced.

### 2.3 Strokes — Category grouping toggle
- "Group by Category" toggle button (already groups by category by default — add an "All" flat view and a grouped view toggle).
- Store preference in localStorage.

### 2.4 Video Tips — Coach card improvements
- Make coach avatar/name more prominent on cards.
- The coach filter already exists (line 149-163) — just improve the visual presentation.

### 2.5 Blog — Featured section
- Show `isFeatured` posts in a highlighted row at top (already partially done — line 174-203 shows featured post, just enhance with orange accent border).

## Phase 3: Structured Data Enhancements

### 3.1 Video Tips — VideoObject schema per video
- Add `VideoObject` JSON-LD for each video (name, description, thumbnailUrl, uploadDate, contentUrl, author).

### 3.2 Blog — Already has Blog structured data — no additional work.

### 3.3 Racket Finder — Already has FAQPage — just add BreadcrumbList.

## Phase 4: Polish

### 4.1 Racket Finder — "Popular Picks" section
- Show 3-4 top rackets below SEO content.
- Query from Sanity racket database.

### 4.2 Racket Finder — Social proof
- "Trusted by X+ players" stat banner.

### 4.3 Video Tips — "Want More?" CTA
- Links to `/trainers` and external submission form.

## i18n Keys to Add

All new intro paragraphs, labels, and CTAs need keys in all 5 locale files (`en`, `nl`, `de`, `es`, `fr`) under the `marketing` namespace. Key groups:
- `rules.introText`, `rules.faq.*`, `rules.relatedLearning`
- `strokes.introText`, `strokes.filterAll`, `strokes.filterBeginner`, etc., `strokes.startHere.*`
- `videoTips.introText`, `videoTips.wantMore.*`
- `blog.subtitle` (update existing)
- `racketFinder.relatedResources.*`

## Files Changed (All Phases)

| File | Changes |
|------|---------|
| `src/pages/marketing/Rules.tsx` | Intro, meta desc, BreadcrumbList + FAQPage structured data, related links, spacing fix |
| `src/pages/marketing/Strokes.tsx` | Intro, null fallback, BreadcrumbList, filter tabs, "Start Here" section, category toggle |
| `src/pages/marketing/VideoTips.tsx` | Intro, VideoObject structured data, BreadcrumbList, CTA section, coach card improvements |
| `src/pages/marketing/Blog.tsx` | Subtitle fix, author fallback, BreadcrumbList |
| `src/pages/marketing/RacketFinder.tsx` | BreadcrumbList |
| `src/components/racketfinder/RacketFinderContent.tsx` | Related resources links, popular picks |
| `src/components/sanity/VideoTipCard.tsx` | Enhanced coach attribution |
| `src/i18n/locales/en/marketing.json` | New keys |
| `src/i18n/locales/nl/marketing.json` | New keys (Dutch) |
| `src/i18n/locales/de/marketing.json` | New keys (German) |
| `src/i18n/locales/es/marketing.json` | New keys (Spanish) |
| `src/i18n/locales/fr/marketing.json` | New keys (French) |

## Recommendation

Given the size, I suggest implementing **Phase 1 first** (highest SEO impact with least complexity), then proceeding phase by phase. Want me to start with Phase 1, or implement everything at once?

