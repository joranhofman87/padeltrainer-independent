# PTF export — First training date in the Academy Players CSV

Owner-approved 2026-10-01. Forward-only, on top of the APPLIED export follow-up `20261208120000` (production
ledger 622), which is not edited or re-applied. One database object changes, `public.get_players_overview_export`,
with the same signature, result, owner, SECURITY DEFINER, config, ACL and 20,000-row bound. No table, column,
index, backfill or data change; the filter authority, the list entry and the location semantics are untouched.
The function is `20261208120000`'s definition byte-for-byte plus exactly two lines (see the header of
`supabase/migrations/20261208130000_players_overview_export_first_training.sql`).

## New CSV column

| Column | Source and rule |
| --- | --- |
| First training date | Earliest ENDED academy-owned session with a confirmed/completed booking for that person; academy-local date of the session's start; blank if none |

It is booked-session history, not attendance and not registration. It uses exactly the rules of Last training
date: the same qualifying bookings (confirmed/completed only), the same tenant scope (only sessions stamped
with this academy), the same person keying, a person's sides on one session counted once, and the same
academy timezone. It is blank exactly when Last training date is blank and is never after it.

## Order: database first, then the frontend

The current production frontend ignores the new `first_training_date` key, so the database step is safe on
its own. The new frontend REQUIRES the key and refuses a response without it (no partial file), so it ships
only after the post-check below passes.

## Database steps (user-operated; one deployer, no other release writer)

From the repository root of a clean checkout of the reviewed commit, after
`shasum -a 256 -c docs/deployment/ptf-export-first-training/SHA256SUMS` passes, with the production connection
form of `docs/deployment/ptf-release/README.md`:

1. **Apply** (one transaction): `-1 -v ON_ERROR_STOP=1 -v expected_sysid=7642734024280108049 -f docs/deployment/ptf-export-first-training/apply.sql`.
   - Required: exit 0; `INSERT 0 1`; `NOTICE:  ptff apply: object state 005e46bea4a92e0f801fc3414317aa2ce8b296fcb08f1060146f7cc1fd5cd6fd, ledger 623 to 20261208130000`; no `ERROR:`/`FATAL:`/`WARNING:`.
   - It refuses, changing nothing, unless production is exactly in the export follow-up state (ledger 622,
     digest `d8115fd6…`; object state `60b71403…`) or already in the first-training state (a re-run:
     `INSERT 0 0`).
2. **Post-check** (read-only, ends in ROLLBACK; no `-1`):
   `-v shape_academy=<an academy id> -f docs/deployment/ptf-export-first-training/postcheck.sql`.
   - Record 1: `db` postgres, `sysid` 7642734024280108049, `ledger_rows` 623, `ledger_head` 20261208130000,
     `ledger_ok` t, `state_ok` t, `state_sha256` 005e46bea4a92e0f801fc3414317aa2ce8b296fcb08f1060146f7cc1fd5cd6fd,
     `export_config` `search_path=pg_catalog, pg_temp;plan_cache_mode=force_custom_plan`,
     `export_acl` `authenticated=X/postgres,postgres=X/postgres`, `anon_can_execute` f,
     `service_role_can_execute` f.
   - Record 2: `shape_manager_found` t.
   - Record 3 (counts only, no personal data): `shape_total` = `shape_rows` = `rows_with_exact_keys` =
     `distinct_persons`; `with_first_date` = `with_last_date`; `malformed_dates`, `zero_count_with_last`,
     `count_without_last`, `first_last_presence_mismatch` and `first_after_last` all 0.

Anything else is an escalation: keep the complete output, run nothing further.

## Frontend

Only after the post-check passes: the reviewed PR is merged to `main` (Vercel deploys it). Then confirm the
production deployment's commit, that the served bundle carries the "First training date" header, and a
signed-in production CSV download with the column.

## Recovery

1. Frontend first: revert to the previous production deployment (it works on either export body).
2. Only if the export function itself must go back:
   `-1 -v ON_ERROR_STOP=1 -v expected_sysid=7642734024280108049 -f docs/deployment/ptf-export-first-training/recovery.sql`.
   It re-installs the applied `20261208120000` file byte-for-byte, removes ledger row 20261208130000 and
   verifies the exact follow-up state (`NOTICE:  ptff recovery: object state 60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20 (the export follow-up state), ledger 622 to 20261208120000`).
   Afterwards remove the 20261208130000 migration file from the repository. A re-run is a no-op (`DELETE 0`).

## Local evidence

- `src/test/playersOverviewExportColumns.pglite.test.ts`: the chain applies 20261208120000 then
  20261208130000; first_training_date against representative histories, cancellations, merged and dual-keyed
  sides, split-frozen guests, the academy timezone and tenant isolation, plus an independent per-person minimum.
- `src/test/ptfReleasePacket.realpg.test.ts`: this packet on real PostgreSQL 18.4 (refusals, apply, the
  installed body on a local history with a cancelled session and an academy-local midnight session, re-run,
  post-check, recovery to the exact follow-up state).
- `src/lib/playerContactExport.test.ts` and `src/test/academyPlayersTrainingExport.test.tsx`: the typed
  response refuses a server without `first_training_date` or with a malformed date; the CSV carries the column.
