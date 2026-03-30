

# Automatic Database Backup System (Every 12 Hours)

## Summary
Build a fully automated backup system that runs every 12 hours via a cron job. An edge function exports critical tables as JSON to a private `backups` storage bucket. An admin page shows backup history and allows downloading past backups.

## Architecture

```text
pg_cron (every 12h) ──► Edge Function (backup-database)
                              │
                              ├── Queries critical tables (service role)
                              └── Writes JSON to "backups" storage bucket
                                       │
Admin UI (read-only) ◄────────────────┘
  - View backup history
  - Download table files
  - Delete old backups
```

## Tables Backed Up
`profiles`, `trainer_profiles`, `academy_profiles`, `club_profiles`, `invoices`, `bookings`, `availability_slots`, `locations`, `guest_players`, `club_managers`, `academy_managers`, `academy_trainers`, `user_roles`

## Changes

| Component | Change |
|-----------|--------|
| **Storage bucket** | Create private `backups` bucket via migration |
| **Edge function** `backup-database` | New. Validates admin role OR cron secret. Queries each table with service role, writes `{timestamp}/{table}.json` to bucket. Returns summary. |
| **Migration** | Enable `pg_net` extension (pg_cron already enabled). Insert cron job to call backup function every 12 hours. |
| **`src/pages/admin/AdminBackups.tsx`** | New page. Lists past backups from storage, download individual files, delete old backups. No "create" button — fully automatic. |
| **`src/components/admin/AdminSidebar.tsx`** | Add "Backups" item under Settings with `Database` icon. |
| **`src/components/DomainRouter.tsx`** | Add route `/app/admin/backups` → `AdminBackups`. |
| **`supabase/config.toml`** | Add `[functions.backup-database]` entry. |

## Cron Schedule
Runs at **00:00 and 12:00 UTC** daily (`0 0,12 * * *`). Each run creates a timestamped folder in the `backups` bucket.

## Admin UI Features
- Backup history list (date, table count, total rows)
- Download individual table JSON files
- Delete old backups with confirmation
- Status badge showing last successful backup time

## Security
- Edge function validates either admin JWT or a shared cron secret
- `backups` bucket is private, admin-only RLS
- Service role used only server-side

