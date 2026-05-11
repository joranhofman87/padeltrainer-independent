# Cron service-role fix + verification

## Context

`enrich-clubs` and `fetch-location-logos` now call `requireAdmin` (which accepts the service-role bearer as a short-circuit). The two pg_cron jobs that drive them are still wired with the **anon key** as bearer, so they will start returning 401 on every tick.

Two pieces:

```
schedule_enrichment_job()   → cron 'enrich-locations-background'    every 2 min   → enrich-clubs
schedule_logo_fetch_job()   → cron 'fetch-location-logos-background' every 15 min → fetch-location-logos
```

Both functions hardcode the anon key inside `cron_command`. The cron jobs themselves were already scheduled with that command, so updating the wrapper functions alone does nothing — the live `cron.job` rows must also be re-scheduled.

## #1 — Fix the live cron jobs (insert tool, NOT a migration)

Per the project's cron-job guidance: SQL that contains the project's anon/service keys should be executed via the insert tool, not committed in a migration file (so it doesn't leak into remixes).

Run, in one transaction:
```sql
SELECT cron.unschedule('enrich-locations-background');
SELECT cron.unschedule('fetch-location-logos-background');

SELECT cron.schedule(
  'enrich-locations-background',
  '*/2 * * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/enrich-clubs',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'
      ),
      body := '{"batch_size": 5, "fill_missing_only": true}'::jsonb
    ) AS request_id;
  $cron$
);

SELECT cron.schedule(
  'fetch-location-logos-background',
  '*/15 * * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/fetch-location-logos',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'
      ),
      body := '{"batch_size": 10}'::jsonb
    ) AS request_id;
  $cron$
);
```
The `<SUPABASE_SERVICE_ROLE_KEY>` placeholder is filled in inline at execution time from the project's stored secret (already configured). Nothing secret lands in the repo.

## #2 — Fix the wrapper functions (migration, no secret)

`schedule_enrichment_job()` / `schedule_logo_fetch_job()` are admin-callable RPCs used to re-create the cron jobs from the UI / admin panel. They currently embed the anon key in source. Replace them so they read the bearer from a GUC instead, with a clear error if it's not set:

```sql
-- (committed in a migration — no secret here)
CREATE OR REPLACE FUNCTION public.schedule_enrichment_job()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job_id bigint;
  sr_key text;
  cron_command text;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  sr_key := current_setting('app.settings.service_role_key', true);
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE EXCEPTION 'app.settings.service_role_key is not configured';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'enrich-locations-background';
  IF job_id IS NOT NULL THEN RETURN job_id; END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/enrich-clubs',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{"batch_size": 5, "fill_missing_only": true}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  SELECT cron.schedule('enrich-locations-background','*/2 * * * *', cron_command) INTO job_id;
  RETURN job_id;
END;
$$;
```
Same shape for `schedule_logo_fetch_job()`.

The GUC `app.settings.service_role_key` is set once via the insert tool with `ALTER DATABASE postgres SET app.settings.service_role_key = '<key>'` — also kept out of the migration file. (Standalone DB-level GUC SETs are allowed when run ad-hoc; the "no `ALTER DATABASE postgres` in migrations" rule is exactly because the value would otherwise get committed.)

After the GUC is set, any future admin click on "Re-schedule cron job" produces a job that uses the SR key with no source-code secret.

## #3 — Verification (curl_edge_functions)

After step #1 lands, hit each endpoint:

| Function | Auth | Expected |
|---|---|---|
| `enrich-clubs` | no Authorization | 401 |
| `enrich-clubs` | Bearer SUPABASE_ANON_KEY | 401 (admin guard) |
| `enrich-clubs` | Bearer SUPABASE_SERVICE_ROLE_KEY | 200 |
| `fetch-location-logos` | no Authorization | 401 |
| `fetch-location-logos` | Bearer SUPABASE_SERVICE_ROLE_KEY | 200 |
| `impersonate-user` | no Authorization | 401 |
| `admin-reset-password` | no Authorization | 401 |
| `create-admin-trainer` | no Authorization | 401 |
| `get-admin-stats` | no Authorization | 401 |
| `get-admin-stats` | preview admin session | 200 |

Then wait 2–3 minutes and `cron.job_run_details` for both jobs should show `succeeded`.

## Order

1. Insert-tool SQL (step #1) — unblocks the cron immediately.
2. Migration (step #2) — committable cleanup of the wrapper functions.
3. Curl verification (step #3).

## Out of scope

- Migrating the inline SR key in cron jobs to Postgres `vault.secrets` (cleaner long-term but pg_cron + vault interplay isn't already wired in this project — separate refactor).
- Re-auditing every other `requireAdmin` edge function caller for cron usage (only these two were flagged as currently broken).
