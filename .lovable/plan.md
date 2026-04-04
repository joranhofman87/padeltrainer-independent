

# Add proposed_assignments and intake_requests to automated backups

## Situation
The automated backup system already runs every 12 hours via pg_cron, backing up 13 tables to a private storage bucket. It just doesn't include `proposed_assignments` or `intake_requests` — the two tables whose data was lost.

## Change
One file, two lines added:

| File | Change |
|------|--------|
| `supabase/functions/backup-database/index.ts` | Add `"proposed_assignments"` and `"intake_requests"` to the `TABLES_TO_BACKUP` array |

That's it. The backup infrastructure (cron job, storage bucket, admin UI at `/app/admin/backups`) is already in place. Next time slots/assignments are created, they'll be included in the 12-hourly snapshots automatically.

