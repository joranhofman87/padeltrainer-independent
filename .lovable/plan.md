

# Enrich Location Profiles via Firecrawl

## Current Situation

You already have a working `enrich-clubs` edge function that scrapes websites using Firecrawl and extracts court counts, descriptions, and logos. However, it doesn't extract all available fields.

**Data gaps across 1,678 locations with websites:**

| Field | Missing | Coverage |
|-------|---------|----------|
| Description | 1,609 | 4% |
| Opening hours | 801 | 52% |
| Email | 777 | 54% |
| Phone | 759 | 55% |
| Instagram | 642 | 62% |
| Facebook | 629 | 63% |
| Court counts (both 0) | 401 | 76% |
| Logo | 355 | 79% |

## Approach

Upgrade the existing `enrich-clubs` edge function to also extract phone, email, social media URLs, and opening hours -- all in a single scrape + AI call per location. Only fill fields that are currently empty (never overwrite existing data).

## Changes

### 1. Upgrade `enrich-clubs` edge function

Expand the AI extraction prompt to return a single JSON object with all fields:

- `indoor_courts`, `outdoor_courts` (existing)
- `description` (existing)
- `phone` -- extract from contact page / footer
- `email` -- extract from contact info
- `facebook_url` -- look for Facebook links
- `instagram_url` -- look for Instagram links
- `opening_hours` -- extract opening hours text

The function will:
1. Scrape the website (already done)
2. Send content to AI with an expanded prompt asking for ALL fields
3. Only UPDATE fields that are currently NULL/empty in the database (preserve manual edits)
4. Continue to handle logo upload as it does now

### 2. Add "only missing fields" mode

Add a `fill_missing_only` parameter (default: true) so the function:
- Fetches the current location data including all fields
- Skips locations that already have all fields filled
- Only writes to NULL fields, never overwrites existing values

### 3. Admin UI trigger (existing)

The function is already callable from the admin dashboard. No UI changes needed -- just use the existing batch processing with the updated function.

## Technical Details

**File modified:** `supabase/functions/enrich-clubs/index.ts`

Key changes:
- Expand the `Location` interface to include phone, email, social URLs, opening_hours
- Merge the two separate AI calls (court extraction + description) into one combined call for efficiency (saves API costs and time)
- Add conditional update logic: only set fields where current value is NULL
- Request `links` format from Firecrawl alongside `markdown` to better detect social media URLs
- Increase content sent to AI (from 6000 to 8000 chars) for better extraction

**No new tables or migrations needed** -- all target columns already exist.

## Usage

After deployment, run enrichment from the admin panel or directly:

```
// Process 10 locations, only filling missing data
{ "batch_size": 10, "fill_missing_only": true }

// Process specific locations
{ "location_ids": ["uuid1", "uuid2"], "fill_missing_only": true }

// Dry run to preview what would be extracted
{ "batch_size": 5, "dry_run": true }
```

To process all 1,609 locations missing descriptions, run in batches of 10-20 (the function already supports offset-based pagination).

