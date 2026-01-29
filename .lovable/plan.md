
# Plan: Add Academies to Sitemap and Dynamic Pages

## Overview

Add academy pages to the sitemap and ensure SEO is properly configured for both the academy directory page and individual academy profile pages. The routing already exists, but we need to include academies in the sitemap edge function.

## Current State

| Component | Status |
|-----------|--------|
| `/academies` directory page | Already exists at `src/pages/Academies.tsx` |
| `/academies/:slug` profile page | Already exists at `src/pages/AcademyPublicProfile.tsx` |
| Routes configured | Already in `App.tsx` under language-prefixed routes |
| SEO component used | Already implemented on both pages |
| Sitemap edge function | Missing academy pages |

## Implementation Steps

### 1. Update Sitemap Edge Function

**File:** `supabase/functions/sitemap/index.ts`

Add academies to the sitemap by:

1. Adding `/academies` to static pages list
2. Fetching all verified public academies from database
3. Generating URL entries for each academy profile page

```text
Changes:
+------------------------------------------+
| Static Pages                             |
+------------------------------------------+
| Add: /academies (priority: 0.8, weekly)  |
+------------------------------------------+

+------------------------------------------+
| Dynamic Pages                            |
+------------------------------------------+
| Query: academy_profiles                  |
| Filter: is_verified=true, is_public=true |
| Generate: /academies/:slug for each      |
| Priority: 0.7                            |
| Changefreq: weekly                       |
+------------------------------------------+
```

### 2. Update Generate Sitemap Script

**File:** `scripts/generate-sitemap.ts`

Update the breakdown logging to include academy page counts.

## Technical Details

### Sitemap Edge Function Changes

Add to static pages array:
```typescript
{ path: '/academies', priority: '0.8', changefreq: 'weekly' },
```

Add academy fetching (similar pattern to trainers/locations):
```typescript
// Fetch all verified public academies
const { data: academies, error: academiesError } = await supabase
  .from('academy_profiles')
  .select('slug, updated_at')
  .eq('is_verified', true)
  .eq('is_public', true);

if (academiesError) {
  console.error('Error fetching academies:', academiesError);
}
```

Add academy URL generation:
```typescript
// Add academy profile pages (for each language)
if (academies) {
  for (const academy of academies) {
    const lastmod = academy.updated_at 
      ? new Date(academy.updated_at).toISOString().split('T')[0] 
      : today;
    xml += generateUrlEntry(`/academies/${academy.slug}`, lastmod, 'weekly', '0.7');
  }
}
```

### Updated Sitemap Breakdown Script

Add to the breakdown logging:
```typescript
const academyMatches = sitemapXml.match(/\/academies\/[^<]+/g) || [];

console.log(`   Academy pages: ${academyMatches.length - (sitemapXml.match(/\/academies<\/loc>/g) || []).length}`);
```

## Files to Modify

| File | Changes |
|------|---------|
| `supabase/functions/sitemap/index.ts` | Add `/academies` to static pages, fetch and add academy profiles |
| `scripts/generate-sitemap.ts` | Update breakdown to count academy pages |

## Expected Output

After implementation, the sitemap will include:
- 1 static academies directory page (x2 languages = 2 URLs)
- All verified public academy profile pages (x2 languages each)

Example sitemap entries:
```xml
<url>
  <loc>https://padeltrainer.ai/en/academies</loc>
  <lastmod>2026-01-29</lastmod>
  <changefreq>weekly</changefreq>
  <priority>0.8</priority>
  <xhtml:link rel="alternate" hreflang="en" href="..."/>
  <xhtml:link rel="alternate" hreflang="nl" href="..."/>
</url>

<url>
  <loc>https://padeltrainer.ai/en/academies/padel-amsterdam-academy</loc>
  <lastmod>2026-01-15</lastmod>
  <changefreq>weekly</changefreq>
  <priority>0.7</priority>
  <xhtml:link rel="alternate" hreflang="en" href="..."/>
  <xhtml:link rel="alternate" hreflang="nl" href="..."/>
</url>
```

## Visibility Rules

Academy pages will only appear in the sitemap if:
- `is_verified = true`
- `is_public = true`

This aligns with the existing visibility rules enforced in `Academies.tsx` and `AcademyPublicProfile.tsx`.
