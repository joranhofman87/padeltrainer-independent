

# Fix Video Tips Page — Empty Title + Enhanced Schema

## Root Cause

The `videoTips.*` i18n keys are **completely missing** from all 5 locale marketing.json files. When `t('videoTips.title')` is called, i18next returns an empty string despite the inline fallback — resulting in an empty `<title>` tag.

## Changes

### 1. Add i18n keys to all 5 locale files

Add `videoTips` section to `src/i18n/locales/{en,nl,de,es,fr}/marketing.json` with all keys used in VideoTips.tsx:
- `title`, `metaDescription`, `subtitle`, `introText`, `badge`
- `breadcrumbLearn`, `filterStroke`, `filterLevel`, `filterCoach`, `filterTags`, `clearFilters`
- `noMatch`, `empty`, `adjustFilters`, `emptyDescription`, `matchingFilters`
- `wantMore`, `wantMoreDescription`, `findCoach`

Updated meta description (EN): `"Watch expert padel coaching videos. Learn strokes, tactics, and techniques from certified coaches with short, focused video lessons for every level."`

### 2. Enhance VideoObject schema in `VideoTips.tsx`

Current schema is minimal. Add:
- `embedUrl` (derived from `parseVideoUrl`)
- `thumbnailUrl` auto-generated from YouTube ID when not set in Sanity
- `publisher` block with org name + logo
- Fallback `description` to title when `shortSummary` is null

### 3. No structural changes needed

BreadcrumbList is already present (lines 27-35). The SEO component already handles title/description/OG tags correctly — the issue was purely missing i18n keys.

## Files changed

| File | Change |
|------|--------|
| `src/i18n/locales/en/marketing.json` | Add `videoTips` section |
| `src/i18n/locales/nl/marketing.json` | Add `videoTips` section (Dutch) |
| `src/i18n/locales/de/marketing.json` | Add `videoTips` section (German) |
| `src/i18n/locales/es/marketing.json` | Add `videoTips` section (Spanish) |
| `src/i18n/locales/fr/marketing.json` | Add `videoTips` section (French) |
| `src/pages/marketing/VideoTips.tsx` | Enhance VideoObject schema with embedUrl, publisher, better thumbnailUrl |

