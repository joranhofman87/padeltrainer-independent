

# Fix Enrichment Loop: Track Failed Locations

## Problem
The enrichment cron job keeps retrying the same failing locations every 2 minutes because there's no way to mark a location as "failed". This wastes Firecrawl credits and blocks the remaining 1,452 locations.

## Solution
Add failure tracking columns to `locations`, update the edge function to mark failures and skip them, and give admins a "Retry failed" button.

## Changes

### 1. Database Migration
Add two columns to the `locations` table:
- `enrichment_failed_at` (timestamptz, nullable) -- timestamp of last failure
- `enrichment_error_msg` (text, nullable) -- error reason for admin visibility

### 2. Edge Function (`supabase/functions/enrich-clubs/index.ts`)

**Query filter**: When in `fillMissingOnly` mode, also exclude locations where `enrichment_failed_at` is not null. This ensures failed locations are skipped permanently until manually retried.

**On error**: After `processLocation` returns with `status: "error"`, update the location row:
```
enrichment_failed_at = now()
enrichment_error_msg = result.error
```

**On success**: Clear both fields (set to null) so that if a previously-failed location is retried and succeeds, it's cleaned up.

### 3. Admin UI (`src/components/admin/EnrichmentControls.tsx`)

- Add a query to count locations where `enrichment_failed_at IS NOT NULL` -- show as "X failed" next to the existing "X missing" count
- Add a "Retry failed" button that sets `enrichment_failed_at = null` and `enrichment_error_msg = null` for all failed locations, putting them back in the queue
- The "missing" count query should also exclude failed locations (so it shows truly pending vs failed separately)

### 4. Admin Locations Table (`src/pages/admin/AdminLocations.tsx`)

- Optionally show a small warning icon or red dot on locations that have `enrichment_failed_at` set, so admins can see which specific locations failed and what the error was (via tooltip on hover)

## Expected Outcome
- Failed locations get marked and skipped on subsequent runs
- The job moves on to process the remaining 1,400+ locations
- Admins see a clear split: "X pending | Y failed"
- Admins can manually clear failures with one click to retry them

