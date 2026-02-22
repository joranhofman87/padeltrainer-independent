

# Automate Location Enrichment via Scheduled Background Job

## Problem
There are 1,608 locations missing descriptions (out of 1,678 with websites). Running the enricher manually in batches of 10-50 would require dozens of tedious API calls.

## Solution
Set up a scheduled background job (like the existing logo fetch job) that runs the enricher automatically in small batches, plus add admin UI controls to start/stop/monitor progress.

## Changes

### 1. Database: Add cron job management functions

Create two new database functions (matching the existing `schedule_logo_fetch_job` / `unschedule_logo_fetch_job` pattern):

- `schedule_enrichment_job()` -- creates a pg_cron job that calls `enrich-clubs` every 2 minutes with `batch_size: 5`
- `unschedule_enrichment_job()` -- removes the cron job
- `check_enrichment_job_status()` -- returns whether the job is active

Using batch_size of 5 and a 2-minute interval keeps API costs manageable and avoids rate limits (each location = 1 Firecrawl scrape + 1-3 AI calls).

### 2. Admin UI: Add enrichment controls to AdminLocations page

Add a section (or button group) to the AdminLocations page header with:

- **"Start Enrichment"** button -- calls `schedule_enrichment_job()`, shows a toast
- **"Stop Enrichment"** button -- calls `unschedule_enrichment_job()`
- **Status indicator** -- shows "Running" / "Stopped" based on `check_enrichment_job_status()`
- **Progress stats** -- show how many locations still need enrichment (missing description count)

### 3. Auto-stop when complete

The enricher already skips locations with all fields filled. Once all are processed, each batch will return `"skipped"` for everything. We could optionally add logic to auto-disable the cron job when a batch returns 0 successes -- but this adds complexity. A simpler approach: just let admins check progress and stop manually when satisfied.

## Technical Details

**Cron job SQL** (same pattern as `schedule_logo_fetch_job`):
- Job name: `enrich-locations-background`
- Schedule: `*/2 * * * *` (every 2 minutes)
- Payload: `{"batch_size": 5, "fill_missing_only": true}`
- Uses `pg_net` to POST to the edge function

**Estimated processing time**: 
- 5 locations per batch, every 2 minutes = ~150 locations/hour
- 1,608 locations / 150 per hour = roughly 11 hours to complete all

**Files to modify:**
- New migration: create `schedule_enrichment_job()`, `unschedule_enrichment_job()`, `check_enrichment_job_status()` functions
- `src/pages/admin/AdminLocations.tsx` -- add enrichment controls to the page header

**No new edge functions needed** -- reuses the existing `enrich-clubs` function.

