# PTF release packet — Academy Players current-training filter and contact export

Status: **local release candidate**. Nothing here is authorized to run in production until a separate
go/no-go names this exact commit. Decision PTF-OPTION-A-2026-09-27 (Tom's option A: ongoing cycles and
upcoming standalone sessions count; cycles that have not started do not).

## Composition

| Part | Content | Evidence |
| --- | --- | --- |
| Frontend base | production deployment `HJ3eNSHPJ`: commit `edf299b5b735f2b5bfb17fd8b44bd658ede3760a` on `main` | `PTF_FRONTEND_BASELINE_RECEIPT_2026-09-29.md`: short SHA resolved locally; the provider deployment id and UTC time are still to be reconciled before execution |
| Code | the 5 reviewed commits over that base (`claude/ptf-training-filter-export` at `20f90e38db6b58a398d1c2ee8391dc77eb61390e`, preserved), plus one candidate commit on `claude/ptf-release-candidate`: this packet and a same-contract performance correction of the migration | the owner-approved player-list change (`b21c4f2e`, `73d145cd`) is deliberately included, since PTF is built on it |
| Database | one migration, `20261208100000_players_overview_current_training.sql` (sha256 `044a0e89…`, function body `22695d9c…`, 33,379 bytes), built on the live canonical `get_players_overview` body `0f42f53c…` and additions-only against it | `PTF_DATABASE_BASELINE_RECEIPT_2026-09-29.md`: ledger 620 to `20261207100000`, after the verified ACL correction |
| Excluded | ABC16 (deferred; its rebase gate stands), U2, U4, U7, the F0 UI, `types.ts` changes | — |

The packet's own files (`SHA256SUMS` in this directory):

| File | Role |
| --- | --- |
| `preflight.sql` | Read-only baseline: byte-identical to the operator-run `ptf_live_baseline.sql` (`86eccf1b…`) |
| `apply.sql` | The only write: guard, migration, ledger row and in-transaction verification, all in one transaction |
| `postcheck.sql` | Read-only end-state check plus one refusal probe |
| `recovery.sql` + `restore_canonical_get_players_overview.sql` | Forward recovery to the exact canonical body |

## Order: one deployer, every other writer quiesced

Run steps 1–3 from the repository root of a **clean checkout of the candidate commit**, after
`shasum -a 256 -c docs/deployment/ptf-release/SHA256SUMS` passes. Use the connection form of
`ACL_MANUAL_PREFLIGHT.md`, with the password entered only at the interactive prompt:

```sh
PGCONNECT_TIMEOUT=10 PGSSLMODE=verify-full PGSSLROOTCERT=/Users/Shared/f0-release-state/prod-ca.crt /opt/homebrew/opt/libpq/bin/psql -X -W -h db.ficwbdrzefmblkbkomzw.supabase.co -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -f docs/deployment/ptf-release/preflight.sql
```

1. **Preflight (read-only).** It must equal the database baseline receipt:
   - 620 / `20261207100000`, reviewed+ACL `t`, no later versions;
   - one function with the same signature and attributes;
   - `fn_acl` `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`;
   - body `0f42f53c…`, 29,903 bytes.

   Anything else: STOP.
2. **Apply (the only write).** Use the same command with `-1 -v expected_sysid=7642734024280108049` and
   `-f docs/deployment/ptf-release/apply.sql`.
   - Success: exit 0, `NOTICE: ptf apply: get_players_overview body 22695d9c…`, `INSERT 0 1` (`INSERT 0 0` on a re-run).
   - Refusal: psql exits 3, and nothing changes. The guard names the cause: target, ledger, signature,
     privileges, ledger/body disagreement, a prepared transaction, in-flight migration/DDL work, or a lock
     timeout. Fix the cause and preflight again.
   - Never run the migration on its own or through `supabase db push`.
3. **Post-check (read-only), immediately.** Use the same command with `-f docs/deployment/ptf-release/postcheck.sql`.
   Done only if:
   - every `*_ok` column is `t`;
   - `foreign_access` is `refused: not authorized`;
   - `prepared_xacts` is 0 and `in_flight` is empty.
4. **Frontend, only after step 3 passes.** Put the candidate's frontend live on production (a separately
   authorized merge to `main`, which Vercel deploys), then confirm the production deployment's commit.
   - **The order matters.** The old function body silently ignores unknown filter keys. A new frontend on the
     old function would show, and export, everyone under "Currently training".
   - Database-first is safe: the current frontend never sends the new keys, and the new function returns
     the same columns.
5. **Observe for 15–30 minutes:**
   - function errors, including `22023` and `42501` rates;
   - overview latency;
   - export refusals and cancels;
   - download failures.

   No player data in logs or chat.

## Lock and compatibility behaviour (measured locally on real PostgreSQL)

- The apply is not blocked by open reader transactions: it completed with an idle-in-transaction reader
  holding the function's input tables.
- A transaction that was already open may keep running the old body until its next invalidation point,
  without error. New transactions run the new body.
- The ledger `ACCESS EXCLUSIVE` lock serialises migration runs. Waits are bounded: `lock_timeout` 5 s,
  `statement_timeout` 60 s. No reader blackout is required.

## Recovery

1. **Frontend first:** revert production to the previous deployment (`HJ3eNSHPJ`, commit `edf299b5b`).
2. **Only if the function itself must be restored:** run `recovery.sql`, with the same command form and
   `-1 -v expected_sysid=…`.
   - It reinstalls the exact canonical body (`0f42f53c…`, 29,903 bytes) with the unchanged privileges.
   - It records ledger version `20261208110000`. A re-run writes `INSERT 0 0`.
   - After it: `preflight.sql` shows the canonical body and ACL, with 622 ledger rows (so reviewed+ACL is
     `f`, which is expected), and `apply.sql` refuses until a new reviewed composition exists.
   - No drop, no `CASCADE`, no ledger rewind.
   - If it is ever used, commit `restore_canonical_get_players_overview.sql` as
     `supabase/migrations/20261208110000_players_overview_restore_canonical.sql` before any later release.

## Local evidence

`src/test/ptfReleasePacket.realpg.test.ts` runs every file here through real psql against real PostgreSQL:
embedded 18.4 by default, and `PTF_PGBIN` for production's 17.6. The harness mirrors production:
- Supabase's default function privileges, which reproduce production's three-grantee ACL exactly;
- the canonical chain;
- the 620-version ledger derived from the repository plus the F0/ACL versions.

It proves:
- baseline parity with the receipt;
- every refusal leaves the state unchanged;
- no blocking by open readers;
- the exact end state, a no-op re-run, and a post-check that passes only after apply;
- option-A and tenant behaviour on the composed function;
- exact recovery.

The semantic matrix is `playersOverviewCurrentTraining.pglite.test.ts`, on the same body bytes.

**Performance acceptance budget** (representative fixture: 2,000 guests, 20 cycles and 80 standalone sessions,
about 20,000 bookings over four statuses, plus a second academy's noise):
- a training-filtered 50-row page may cost at most 1.5 × the unfiltered page + 100 ms;
- a 500-row export page must stay at or under 2 s.

This budget is proposed here for acceptance; no numeric budget was agreed earlier. Measured medians of 5, with
1,685 of 2,000 people (84%) qualifying:

| Page | 17.6 (ms) | 18.4 before the correction (ms) | 18.4 after (ms) |
| --- | --- | --- | --- |
| unfiltered, 50 rows | 20 | 17 | 17 |
| training, 50 rows | 22 | 190 | 22 |
| training, 500 rows | 28 | 198 | 27 |
| club, 500 rows | 28 | 293 | 28 |

The correction matches the one qualifying-session predicate to persons once, at set level (`training_persons`),
so each filter is a hashed membership test rather than a per-row re-scan. The results are identical before and
after; all buffers were shared hits.
