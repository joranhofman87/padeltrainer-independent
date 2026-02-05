

# Background Logo Fetching for Locations

Enable automatic logo fetching using a scheduled database job that runs independently of the admin browser session.

---

## Current State

| Metric | Count |
|--------|-------|
| Total locations | 1,703 |
| Pending first fetch | 275 |
| Already processed | 1,400 |
| Have logos | 1,149 |

The current approach requires the admin to keep the dialog open while scraping runs.

---

## Solution: Database-Scheduled Background Job

Use the existing `pg_cron` infrastructure (already used for onboarding emails) to schedule the logo fetch edge function to run automatically.

---

## Implementation

### 1. Create Database Migration for Cron Job

Schedule the `fetch-location-logos` edge function to run every 15 minutes, processing 10 locations per run:

```sql
-- Schedule background logo fetching (runs every 15 minutes)
SELECT cron.schedule(
  'fetch-location-logos-background',
  '*/15 * * * *',  -- Every 15 minutes
  $$
  SELECT
    net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/fetch-location-logos',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer ..."}'::jsonb,
      body := '{"batch_size": 10}'::jsonb
    ) as request_id;
  $$
);
```

### 2. Add Admin Controls to Enable/Disable

Update the `ScrapeLogosDialog` to include:

| Control | Action |
|---------|--------|
| Enable Background Fetch | Creates the cron job |
| Disable Background Fetch | Removes the cron job |
| Status indicator | Shows if job is running |
| Retry All toggle | Allow re-processing locations that already have `logo_fetched_at` set |

### 3. Edge Function Already Supports This

The `fetch-location-logos` function already:
- Skips locations with `logo_fetched_at` set (unless `retry_previous: true`)
- Processes in batches
- Tracks progress via `logo_fetched_at` timestamp
- Handles errors gracefully

---

## Files to Modify

| File | Changes |
|------|---------|
| `supabase/migrations/new_migration.sql` | Add cron job schedule/unschedule functions |
| `src/components/admin/ScrapeLogosDialog.tsx` | Add background mode toggle, status display, and retry option |
| `src/lib/admin.ts` | Add functions to enable/disable background job |

---

## Processing Timeline

With 275 pending locations at 10 per 15 minutes:
- **~7 hours** to complete all pending locations
- Runs completely in background without browser

---

## Optional: Retry Previously Fetched

Add a button to reset `logo_fetched_at` for locations that:
- Have a website URL but no logo found
- Allow the system to try again with improved scraping

