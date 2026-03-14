

# Plan: Combine Enrichment + Logo Fetch into Single Control

## Current State
- **EnrichmentControls** — inline badge/buttons in the header bar for the enrichment cron job (start/stop/retry)
- **ScrapeLogosDialog** — separate dialog opened via "Fetch Logos" button, with its own background cron job and manual scraping mode

Both are background cron jobs doing similar things (processing locations in batches via edge functions). Having them separate is confusing.

## Proposed Change

Replace both with a single **"Data Processing" control panel** that manages both jobs from one place.

### UI Design

Replace the current `EnrichmentControls` inline component + "Fetch Logos" button with a single **"Data Processing"** button that opens a dialog/popover with two sections:

**Section 1: Enrichment** (description, contacts, hours)
- Status badge (Running/Stopped)
- Pending / Failed counts
- Start/Stop toggle
- Retry failed button

**Section 2: Logo Fetching**
- Status badge (Running/Stopped)  
- Pending / Processed / With Logos counts
- Start/Stop toggle
- Retry failed button

**Section 3: Manual batch controls** (collapsed/expandable)
- Batch size selector + Start button for manual runs of either job
- Kept from the existing ScrapeLogosDialog

### Files to Edit

1. **New: `src/components/admin/DataProcessingDialog.tsx`**
   - Combines logic from `EnrichmentControls` and `ScrapeLogosDialog`
   - Single dialog with two clearly labeled sections
   - Each section has its own start/stop/retry controls
   - Manual scraping section at the bottom (for logos only, since enrichment already has manual via the edge function)

2. **`src/pages/admin/AdminLocations.tsx`**
   - Remove `EnrichmentControls` import and inline usage
   - Remove `ScrapeLogosDialog` import and "Fetch Logos" button
   - Add single "Data Processing" button that opens the new dialog

3. **Delete: `src/components/admin/EnrichmentControls.tsx`** (merged into new component)
4. **Delete: `src/components/admin/ScrapeLogosDialog.tsx`** (merged into new component)

### Technical Details

- Both cron job status checks already exist as RPCs (`check_enrichment_job_status`, `check_logo_fetch_job_status`)
- Both schedule/unschedule RPCs exist (`schedule_enrichment_job`/`unschedule_enrichment_job`, `schedule_logo_fetch_job`/`unschedule_logo_fetch_job`)
- No backend changes needed — purely a frontend consolidation
- The dialog polls status every 30 seconds (same as current EnrichmentControls)
- The header bar shows a compact summary badge: e.g. "2 jobs running" or "Processing idle"

