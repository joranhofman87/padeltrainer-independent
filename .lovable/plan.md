

# Speed Up Logo Scraping

## Current Problem
The `enrich-clubs` function takes 15-30 seconds per location because it does **full enrichment**:
- Scrapes full page content (3+ seconds with waitFor)
- 2 AI calls for courts extraction + description generation (4-10 seconds)
- Logo download and upload (2-5 seconds)

For logo-only operations, we're doing 80% unnecessary work!

## Solution: Create Dedicated Logo-Only Function

Create a new lightweight edge function `fetch-location-logos` that:
- Only requests `branding` format from Firecrawl (no markdown)
- Removes the 3-second `waitFor` (logos load immediately)
- Skips all AI processing
- Only updates `logo_url` field

**Expected speed improvement: 15-30 seconds → 3-5 seconds per location**

---

## Changes Required

### 1. Create New Edge Function
**File: `supabase/functions/fetch-location-logos/index.ts`**

Streamlined function that:
- Calls Firecrawl with `formats: ["branding"]` only
- Removes `waitFor: 3000`
- Downloads logo and uploads to storage
- Updates only `locations.logo_url`

### 2. Update Admin Helper
**File: `src/lib/admin.ts`**

Add new function `fetchLocationLogos()` that calls the new edge function.

### 3. Update Dialog to Use New Function
**File: `src/components/admin/ScrapeLogosDialog.tsx`**

Switch from `enrichLocations()` to `fetchLocationLogos()`.

---

## Technical Comparison

| Step | Current (enrich-clubs) | New (fetch-logos) |
|------|------------------------|-------------------|
| Firecrawl scrape | markdown + branding, 3s wait | branding only, no wait |
| AI: Extract courts | Yes (2-5s) | **No** |
| AI: Generate description | Yes (2-5s) | **No** |
| Download logo | Yes | Yes |
| Upload to storage | Yes | Yes |
| DB update | courts + description + logo | logo only |
| **Total time** | **15-30 seconds** | **3-5 seconds** |

---

## New Edge Function Logic

```text
async function scrapeLogoOnly(url: string) {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url: formattedUrl,
      formats: ["branding"],  // Only branding, no markdown
      // No waitFor - logos are in initial HTML
    }),
  });
  
  const data = await response.json();
  return data.data?.branding?.images?.logo || null;
}
```

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `supabase/functions/fetch-location-logos/index.ts` | **Create** new lightweight function |
| `src/lib/admin.ts` | Add `fetchLocationLogos()` helper |
| `src/components/admin/ScrapeLogosDialog.tsx` | Use new function instead of `enrichLocations()` |

---

## Result
- **5-6x faster** logo scraping (3-5 seconds vs 15-30 seconds)
- Batch of 5 locations: ~20 seconds instead of 2+ minutes
- Lower API costs (no AI calls)
- Firecrawl rate limits less likely to be hit

