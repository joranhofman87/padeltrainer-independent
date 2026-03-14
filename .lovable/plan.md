

## Add Sanity Content Pages to Sitemap

### Problem
The three new CMS-driven pages (`/padel-rules`, `/padel-strokes`, `/padel-coaches`) are not included in the sitemap because `staticPages` in the edge function is hardcoded.

### Changes

**File: `supabase/functions/sitemap/index.ts`**

Add the three new pages to the `staticPages` array in the `type === 'static'` block:

```
{ path: '/padel-rules', priority: '0.7', changefreq: 'weekly' },
{ path: '/padel-strokes', priority: '0.7', changefreq: 'weekly' },
{ path: '/padel-coaches', priority: '0.7', changefreq: 'weekly' },
```

This ensures all five languages × 3 pages = 15 new URLs appear in the static sitemap. The next GitHub Action run (or manual trigger) will pick them up.

