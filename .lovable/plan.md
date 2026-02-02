

# Scrape Logos from Location Websites

## Current Situation
- **578 locations** have website URLs configured
- **Only 13 locations** currently have logos
- The `enrich-clubs` edge function already has logo scraping capability built-in

## Solution: Add Admin UI to Trigger Logo Scraping

Rather than building new scraping logic, we'll add a user-friendly admin interface to trigger the existing `enrich-clubs` function, with options to:
1. Scrape logos for selected locations
2. Batch process locations without logos
3. Preview results before saving

---

## Changes Required

### 1. Add "Scrape Logos" Button to Admin Locations Page
**File: `src/pages/admin/AdminLocations.tsx`**

Add a new button in the header:
- "Fetch Logos" button that opens a dialog
- Shows count of locations without logos (565 currently)

### 2. Create Logo Scraping Dialog Component
**New file: `src/components/admin/ScrapeLogosDialog.tsx`**

A dialog with:
- Summary: "X locations have websites but no logo"
- Batch size selector (5, 10, 25 locations at a time)
- Option to select specific locations or process all without logos
- Progress indicator during scraping
- Results preview showing extracted logos before confirming

### 3. Create Admin API Helper for Enrichment
**File: `src/lib/admin.ts`**

Add a function to call the `enrich-clubs` edge function:
```text
enrichLocations(options: {
  location_ids?: string[];
  batch_size?: number;
  offset?: number;
  dry_run?: boolean;
}) => Promise<EnrichmentResult[]>
```

---

## Technical Details

### How Logo Extraction Works (already implemented)

The `enrich-clubs` function uses Firecrawl's branding extraction:

```text
Request: { url, formats: ["markdown", "branding"] }

Response includes:
  branding: {
    images: {
      logo: "https://example.com/logo.svg"
    }
  }
```

The function then:
1. Downloads the logo from the extracted URL
2. Uploads it to Supabase Storage: `avatars/clubs/{location_id}/logo.png`
3. Updates `locations.logo_url` with the public storage URL

### Batch Processing Flow

```text
+------------------+     +-------------------+     +------------------+
|  Admin clicks    | --> | Dialog shows      | --> | Call enrich-clubs|
|  "Fetch Logos"   |     | locations w/o     |     | edge function    |
|                  |     | logos (565)       |     |                  |
+------------------+     +-------------------+     +------------------+
                                                           |
                                                           v
+------------------+     +-------------------+     +------------------+
|  Refresh table   | <-- | Show success/     | <-- | Update DB with   |
|  with new logos  |     | failure counts    |     | extracted logos  |
+------------------+     +-------------------+     +------------------+
```

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/components/admin/ScrapeLogosDialog.tsx` | New dialog component |
| `src/pages/admin/AdminLocations.tsx` | Add "Fetch Logos" button |
| `src/lib/admin.ts` | Add `enrichLocations()` helper function |

---

## User Flow

1. Admin opens Location Management page
2. Clicks "Fetch Logos" button
3. Dialog shows:
   - "565 locations have websites but no logo"
   - Batch size selection (default: 10)
   - "Start" button
4. Progress bar shows as locations are processed
5. Results show: "8 logos found, 2 failed"
6. Table refreshes to show new logos

---

## Rate Limiting Considerations

- Firecrawl API has rate limits
- Process in batches of 10-25 with 500ms delay between each
- Allow admin to stop/pause the process
- Show which locations failed so they can be retried

