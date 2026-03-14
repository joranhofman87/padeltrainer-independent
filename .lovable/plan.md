

# Sitemap & Dynamic Pages Status After Large Import

## Current State

**Database**: 5,941 active locations across 3,848 unique cities and 59 countries.

**Edge function (live)**: Working correctly. Generates a fresh sitemap with all new data — 592K lines of XML.

**Committed `public/sitemap.xml`**: Stale. Only 181K lines. The GitHub Action runs daily at 6AM UTC, so it will auto-update tomorrow. You can also trigger it manually from GitHub Actions → "Regenerate Sitemap" → "Run workflow."

**Dynamic pre-rendering**: Already works for all location and city routes — no changes needed there since it fetches from the database at request time.

## Problem: Sitemap Size Limit

Google enforces **50,000 URLs max** and **50MB max** per sitemap file. Current estimated count: **~49,800 URLs**. With any growth at all, this will break.

Additionally, the uncompressed XML at 592K lines is likely approaching or exceeding the 50MB file size limit already.

## Fix: Switch to Sitemap Index

Split the single sitemap into a **sitemap index** (`sitemap.xml`) pointing to multiple sub-sitemaps:

```text
sitemap.xml (index)
├── sitemap-static.xml      (~170 URLs: static + trainers + academies + blog)
├── sitemap-locations-1.xml  (locations 1-10000)
├── sitemap-locations-2.xml  (if needed)
├── sitemap-cities-1.xml     (city pages 1-10000)
├── sitemap-cities-2.xml     (if needed)
└── sitemap-provinces.xml    (~115 URLs)
```

### Changes

**1. `supabase/functions/sitemap/index.ts`**
- Accept a `?type=index|static|locations|cities|provinces` query parameter
- `type=index` (default): Returns a `<sitemapindex>` pointing to sub-sitemaps
- Each sub-type returns only its subset of URLs (with pagination via `&page=1`)
- Keep each sub-sitemap well under the 50K URL / 50MB limits

**2. `.github/workflows/sitemap.yml`**
- Fetch the index and each sub-sitemap separately
- Save all files to `public/`

**3. `public/robots.txt`**
- Already points to `sitemap.xml` — no change needed since the index file keeps the same name

**4. Data quality note**: Country codes are inconsistent ("Spain" vs "ES", "Netherlands" vs "NL"). The country normalizer from the import hardening should clean this up for future imports, but existing data would benefit from a one-time cleanup migration.

