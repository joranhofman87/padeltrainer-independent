

# Increase backup frequency from 12h to every 2 hours

## Impact assessment
**Very low impact.** The backup function exports 15 tables as JSON files to storage. Each run takes a few seconds and uses a service-role connection. Going from 2 runs/day to 12 runs/day is negligible on the Small instance.

The only consideration is **storage growth** — more snapshots means more files. But JSON exports of these tables are small (KB range), so even at 2-hour intervals you'd accumulate ~12 backups/day. The admin UI already supports deleting old backups, and you could add a retention policy later if needed.

## Changes

| What | Change |
|------|--------|
| Cron job schedule (SQL) | Update from `0 */12 * * *` to `0 */2 * * *` (every 2 hours) |
| `src/pages/admin/AdminBackups.tsx` | Update label from "elke 12 uur" to "elke 2 uur" |

The cron job update is a single SQL statement run via the database tool — no migration needed since it contains project-specific URLs/keys.

