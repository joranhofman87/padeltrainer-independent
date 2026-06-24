# Runbook — database backup & restore

Two independent layers protect the data. Know which one you're reaching for before an incident.

| Layer | What | Covers | Use for |
|---|---|---|---|
| **A. Supabase platform backups / PITR** | Managed by Supabase (dashboard) | The WHOLE database — schema, all tables, RLS, functions, sequences | **Primary disaster recovery** (corruption, bad migration, accidental mass-delete) |
| **B. `backup-database` JSON export** | Our edge fn, daily via cron | 15 core tables only, as JSON in the `backups` storage bucket | **Targeted recovery** of a few rows/tables; a portable off-Postgres copy |

> ⚠️ Layer B is **not** a full backup. It exports row data for 15 tables — no schema, no
> policies/functions/sequences, no storage objects, and not every table (e.g. campaigns,
> session notes, priority claims are NOT in it). Never treat it as your only DR. **Confirm
> Layer A (Supabase PITR/daily backups) is enabled in the dashboard** — that is the real net.

---

## Layer B — what the export contains
- Edge fn `supabase/functions/backup-database/index.ts`, run daily by the `daily-maintenance`
  Vercel cron (`api/cron/daily-maintenance.ts`).
- Writes `backups/{ISO-timestamp}/{table}.json` to the **private** `backups` storage bucket
  (RLS: admins read/insert; service role bypasses). 14-day retention (older folders pruned).
- Tables (in this order — it is roughly FK parent→child, which matters for restore):
  `profiles, trainer_profiles, academy_profiles, club_profiles, invoices, bookings,
  availability_slots, locations, guest_players, club_managers, academy_managers,
  academy_trainers, user_roles, proposed_assignments, intake_requests`.
- It fails **loud**: if any table query or upload fails it returns HTTP 500, so the cron's
  `alertCronFailure` posts to Slack instead of reporting a green "backup complete" while saving
  nothing.

### Verify a backup ran (do this monthly)
1. Supabase dashboard → Storage → `backups` → confirm a folder dated today exists with 15
   `.json` files, non-trivial sizes.
2. Or check the latest `daily-maintenance` cron run (Vercel → Crons) was 2xx, and that no
   `edge_function_error` for `backup-database` hit Slack.
3. Spot-check one file (e.g. `invoices.json`) opens and has the expected rows.

### Trigger a backup on demand
`backup-database` is `verify_jwt=false` and requires service-role-or-admin. From a trusted shell
with the service-role key (the **owner** does this — the assistant has no key):
```
curl -sS -X POST "https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/backup-database" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY"
```
The JSON response lists per-table row counts + `ok`. A non-2xx / `ok:false` means investigate
(`failedQueries` / `failedUploads`) — most often a missing/renamed `backups` bucket.

---

## Restore

### Scenario 1 — full disaster (corruption / bad migration / mass data loss) → Layer A
1. **Stop writes** if feasible (put the app in maintenance / pause the affected flow).
2. Supabase dashboard → Database → **Backups / Point-in-Time Recovery** → restore to a
   timestamp **just before** the incident. Prefer restoring into a **new project/branch** first
   to validate, then cut over, rather than restoring in place blind.
3. After restore: re-run any migrations applied *after* the restore point if needed, re-check
   RLS smoke (`e2e/rls-health.spec.ts`) and invoice health (`invoice-health-check`).
4. Re-point the app env (`VITE_SUPABASE_*`, edge-fn secrets) if you cut over to a new project.

### Scenario 2 — targeted recovery of a few rows / one table → Layer B
Use when a specific table's rows were wrongly deleted/overwritten and platform PITR is overkill.
1. Identify the last-good folder: Storage → `backups` → pick the timestamp before the incident.
2. Download the relevant `{table}.json`.
3. Restore via the **service-role** client (bypasses RLS). Insert **parents before children**
   (the table order above); for an idempotent re-apply use upsert on the primary key:
   ```ts
   // node/deno with the service-role key — NEVER run from the browser
   const rows = JSON.parse(await Deno.readTextFile("invoices.json"));
   for (let i = 0; i < rows.length; i += 500) {
     const { error } = await admin.from("invoices").upsert(rows.slice(i, i + 500), { onConflict: "id" });
     if (error) throw error;
   }
   ```
4. **Caveats**: this only restores columns present in the export — if the schema changed since
   the backup, reconcile manually. FK targets must exist (restore parent tables first). Restoring
   `invoices`/`bookings` may need a follow-up `sync-invoice-to-bookings` / capacity recompute to
   re-derive denormalized state. Money rows: double-check `status`/`paid_at` against Mollie/Stripe
   before trusting a restored value.

---

## Gaps / recommendations
- **Confirm Supabase PITR is on** (Layer A). Layer B alone cannot rebuild the database.
- Layer B omits several tables that now hold real state (email campaigns, session notes,
  priority claims, academy_player_metadata, …). If those become recovery-critical, extend
  `TABLES_TO_BACKUP` — keep the list FK-ordered.
- No automated **restore drill**. At least once, do Scenario 2 for one table into a scratch
  project to prove the JSON round-trips.
- Consider periodically downloading a backup folder off-Supabase (e.g. to cold storage) so a
  full Supabase-account loss is also covered.
