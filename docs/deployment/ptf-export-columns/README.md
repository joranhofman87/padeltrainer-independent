# PTF export follow-up — training and profile columns in the Academy Players CSV

Owner-approved 2026-10-01. One database object changes, `public.get_players_overview_export`, with the same
signature, result, owner, SECURITY DEFINER, ACL and 20,000-row bound. No table, column, index, backfill or
data change; the filter authority and the list entry are untouched. The column semantics are documented at the
top of `supabase/migrations/20261208120000_players_overview_export_training_columns.sql`.

## New CSV columns

| Column | Source and rule |
| --- | --- |
| Currently training | Yes/No. Exactly the list's "Currently training" filter for the same search and filters |
| Last training date | Latest ENDED academy-owned session with a confirmed/completed booking; academy-local date; blank if none |
| Next training date | Earliest in-progress or upcoming academy-owned session with such a booking; blank if none |
| Past sessions booked (not attendance) | Distinct ended academy-owned sessions with such a booking; 0 if none |
| Birth date | The list's person birth date; blank if unknown |
| Locations | The list's own club chips for the person, names verbatim, exact duplicates removed, joined by `; `; blank if none |

Cancelled, rejected, pending and pending-approval bookings never count. Another academy's sessions, a shared
trainer's other sessions and unstamped sessions never count. A person's sides booked on one session count it
once.

## Order: database first, then the frontend

The previous frontend reads only `person_id`, `full_name`, `email` and `phone` and ignores the new keys, so
the database step is safe on its own. The new frontend REQUIRES the new keys and refuses a response without
them (no partial file), so it ships only after the post-check below passes.

## Database steps (user-operated; one deployer, no other release writer)

From the repository root of a clean checkout of the reviewed commit, after
`shasum -a 256 -c docs/deployment/ptf-export-columns/SHA256SUMS` passes, with the production connection form
of `docs/deployment/ptf-release/README.md`:

1. **Apply** (one transaction): `-1 -v expected_sysid=7642734024280108049 -f docs/deployment/ptf-export-columns/apply.sql`.
   - Required: exit 0; `INSERT 0 1`; `NOTICE:  ptfx apply: object state 60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20, ledger 622 to 20261208120000`; no `ERROR:`/`FATAL:`/`WARNING:`.
   - It refuses, changing nothing, unless production is exactly in the PTF state (ledger 621, digest
     `901dc2c8…`; object state `ca0d9b03…`) or already in the follow-up state (a re-run: `INSERT 0 0`).
2. **Post-check** (read-only, ends in ROLLBACK; no `-1`):
   `-v shape_academy=<an academy id> -f docs/deployment/ptf-export-columns/postcheck.sql`.
   - Record 1: `ledger_rows` 622, `ledger_head` 20261208120000, `ledger_ok` t, `state_ok` t,
     `export_config` `search_path=pg_catalog, pg_temp;plan_cache_mode=force_custom_plan`,
     `export_acl` `authenticated=X/postgres,postgres=X/postgres`, `anon_can_execute` f,
     `service_role_can_execute` f.
   - Record 2: `shape_manager_found` t.
   - Record 3 (counts only, no personal data): `shape_total` = `shape_rows` = `rows_with_exact_keys` =
     `distinct_persons`; `malformed_dates`, `zero_count_with_last` and `count_without_last` all 0;
     `shape_ms` is the export's server time. (A next date before the last date is valid: last/next split
     sessions by END time and show the START date, so an ongoing long session can start before a later,
     already ended one.)

Anything else is an escalation: keep the complete output, run nothing further.

## Frontend

Only after the post-check passes: the reviewed PR is merged to `main` (Vercel deploys it). Then confirm the
production deployment's commit and that the served bundle carries the new column headers.

## Recovery

1. Frontend first: revert to the previous production deployment (it works on either export body).
2. Only if the export function itself must go back: `-1 -v expected_sysid=7642734024280108049 -f docs/deployment/ptf-export-columns/recovery.sql`.
   It restores the PTF export body byte-for-byte, removes ledger row 20261208120000 and verifies the exact
   PTF state (`NOTICE:  ptfx recovery: object state ca0d9b03… (the PTF state), ledger 621 to 20261208100000`).
   Afterwards remove the migration file from the repository. A re-run is a no-op (`DELETE 0`).

## Local evidence

- `src/test/playersOverviewExportColumns.pglite.test.ts`: representative histories, cancellations, merged and
  dual-keyed sides, multiple and merged locations (parity with the list chips for every person), missing
  birth dates, the academy timezone, tenant isolation, authorization, and proportional cost.
- `src/test/ptfReleasePacket.realpg.test.ts`: this packet on real PostgreSQL (refusals, apply, re-run,
  post-check, recovery to the exact PTF state); with `PTF_MEASURE=1 PTF_MEASURE_FOLLOWUP=1`, the §3
  20,000-person fixture with the follow-up export.
