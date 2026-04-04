

# Add 14-day retention policy to automated backups

## What changes
After each backup completes, the edge function will automatically delete any backup folders older than 14 days. This keeps storage clean without manual intervention.

## How it works
At the end of each backup run, the function:
1. Lists all folders in the `backups` bucket
2. Parses the timestamp from each folder name
3. Deletes all files in folders older than 14 days
4. Logs how many old backups were cleaned up

At 2-hour intervals, this means you'll keep roughly **168 snapshots** (14 days x 12/day) at any time.

## Changes

| File | Change |
|------|--------|
| `supabase/functions/backup-database/index.ts` | After the backup loop, add a cleanup step that lists folders, checks age, and removes folders older than 14 days |
| `src/pages/admin/AdminBackups.tsx` | Update subtitle to mention "14 dagen bewaard" so admins know the retention policy |

## Technical detail
The cleanup logic reuses the same `parseTimestamp` pattern already used in `AdminBackups.tsx`. For each expired folder, it lists its files and calls `storage.remove()` — the same approach the existing delete mutation uses in the admin UI.

