
# Sitemap Index Architecture

## Status: ✅ COMPLETED

Implemented on 2026-03-14.

## Problem

After importing 5,941+ locations across 59 countries, the single sitemap.xml exceeded Google's 50,000 URL / 50MB limits (~49,800 URLs, 592K lines of XML).

## Solution

Switched to a **sitemap index** architecture with paginated sub-sitemaps:

```
sitemap.xml (index)
├── sitemaps/sitemap-static.xml      (static pages + trainers + academies + blog)
├── sitemaps/sitemap-locations-1.xml (5000 locations per page × 5 langs)
├── sitemaps/sitemap-locations-2.xml (if needed)
├── sitemaps/sitemap-cities-1.xml    (5000 cities per page × 5 langs)
├── sitemaps/sitemap-cities-2.xml    (if needed)
└── sitemaps/sitemap-provinces.xml   (23 provinces × 5 langs)
```

## Changes

1. **`supabase/functions/sitemap/index.ts`** — Accepts `?type=index|static|locations|cities|provinces&page=N`
2. **`.github/workflows/sitemap.yml`** — Fetches index + all paginated sub-sitemaps
3. **`scripts/generate-sitemap.ts`** — Updated for new multi-file output
4. **`public/robots.txt`** — No change needed (still points to `sitemap.xml`)
