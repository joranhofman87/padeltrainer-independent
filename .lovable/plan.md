

# Add "Learn to Play Padel" Content Section to Location Pages

## Problem
Location pages are thin on content, which hurts SEO. These pages are indexed by Google but lack substantive content. Meanwhile, Sanity CMS has rich learning articles, strokes, and video tips that could add value.

## Solution
Add a new full-width section below the "Similar Clubs" section that showcases curated Sanity content: top learning articles, strokes, and video tips. This gives users useful content and creates internal links for Google to crawl.

## Changes

### 1. New component: `src/components/locations/LocationLearnSection.tsx`
A reusable section that fetches and displays content from Sanity:

- **Learning Articles**: Fetch top 6 hub/featured articles via `LEARNING_ARTICLES_LIST_QUERY` (limited, hubs first)
- **Strokes**: Fetch all strokes via `STROKES_LIST_QUERY` and display top 6
- **Video Tips**: Fetch top 4 featured videos via `VIDEO_TIPS_LIST_QUERY`

Layout:
- Section heading: "Learn to Play Padel" (translated per language)
- Three sub-sections with cards linking to `/learn/`, `/strokes/`, `/videos/`
- Each card shows title + short description/excerpt
- "View all" links at end of each sub-section
- Uses existing `LocalizedLink` for all internal links
- Data fetched via `useQuery` with 10-min staleTime (matches existing Sanity caching pattern)

### 2. Wire into `src/pages/LocationDetail.tsx`
- Import and render `<LocationLearnSection />` after the Similar Clubs section (after line 791)
- Pass `currentLang` as prop

### 3. Add translation keys to all 5 locale files (`common.json`)
- `locations.learnPadel` — "Learn to Play Padel" / "Leer Padel Spelen" / etc.
- `locations.topArticles` — "Popular Guides" / "Populaire Gidsen"
- `locations.topStrokes` — "Essential Strokes" / "Essentiële Slagen"
- `locations.topVideos` — "Video Tips" / "Video Tips"
- `locations.viewAllArticles` — "View all guides" / "Bekijk alle gidsen"
- `locations.viewAllStrokes` — "View all strokes" / "Bekijk alle slagen"
- `locations.viewAllVideos` — "View all videos" / "Bekijk alle video's"

## Files
- `src/components/locations/LocationLearnSection.tsx` — New component
- `src/pages/LocationDetail.tsx` — Add section after similar clubs
- `src/i18n/locales/{en,nl,es,de,fr}/common.json` — Translation keys

