# PTF release packet — Academy Players current-training filter and contact export

Status: **local release candidate**. Nothing here is authorized to run in production until a separate
go/no-go names this exact commit. It implements three owner decisions:
- PTF-OPTION-A-2026-09-27: ongoing cycles and upcoming standalone sessions count as current training;
  cycles that have not started do not.
- A1 (Tom, 2026-09-29): academy membership comes only from the academy's own guests, sessions and
  metadata, never through a shared trainer.
- E1 (Tom, 2026-09-29): the contact export is one server call over a private shared filter authority.

## Composition

| Part | Content | Evidence |
| --- | --- | --- |
| Frontend base | production deployment `HJ3eNSHPJ`: commit `edf299b5b735f2b5bfb17fd8b44bd658ede3760a` on `main` | `PTF_FRONTEND_BASELINE_RECEIPT_2026-09-29.md`: short SHA resolved locally; the provider deployment id and UTC time are still to be reconciled before execution |
| Code | the reviewed PTF commits over that base (`claude/ptf-training-filter-export` at `20f90e38`, preserved), plus the candidate commits on `claude/ptf-release-candidate`: this packet, A1, E1 and the review fixes | the owner-approved player-list change (`b21c4f2e`, `73d145cd`) is deliberately included, since PTF is built on it |
| Database | one migration, `20261208100000_players_overview_current_training.sql`: schema `players_private`, the private authority `players_private.players_overview_rows`, the list entry `public.get_players_overview` (same signature, return type and grantees) and the export entry `public.get_players_overview_export` | `PTF_DATABASE_BASELINE_RECEIPT_2026-09-29.md`: ledger 620 to `20261207100000`, after the verified ACL correction; every field of the BASE state below is a receipt value |
| Excluded | ABC-16 (deferred; its rebase gate stands), ABC-17 and every booking writer, U2, U4, U7, the F0 UI, production data repair | — |

The packet's own files (`SHA256SUMS` in this directory):

| File | Role |
| --- | --- |
| `preflight.sql` | Read-only baseline: byte-identical to the operator-run `ptf_live_baseline.sql` (`86eccf1b…`) |
| `apply.sql` | The only write: guard, migration, ledger row and in-transaction verification, all in one transaction |
| `postcheck.sql` | Read-only end-state check, the effective client-role privileges, and two refusal probes |
| `recovery.sql` + `restore_canonical_get_players_overview.sql` | Forward recovery to the exact BASE state |

## Expected object states

Apply, post-check and recovery compare one **state descriptor** (the same query text in every file): one
line per object this release creates or replaces. It covers signature, return type, owner, language,
volatility, SECURITY DEFINER, config, ACL and body sha256, plus schema `players_private` with its ACL and
content counts. The files compare the sha256 of the byte-sorted lines.

**BASE** (sha256 `e6f1ccc592be54132684c36b8bf77611cbe686c4f4115c94d621f196aac32c91`): production before PTF
and after recovery. Every field is a value in the database baseline receipt, and neither the export entry
nor the schema exists:

```text
function public.get_players_overview(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint) owner=postgres language=plpgsql volatility=s security_definer=t config=search_path=public acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres body_sha256=0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4
```

**PTF** (sha256 `8b9d2f98127a66387234d6890f59117a516388c65fa776acf67742d619ff749b`): after apply. The body
hashes are those of the reviewed migration file's three `$$` bodies, and the local suite checks that.

```text
function players_private.players_overview_rows(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer, p_enrich boolean) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint, sort_ord bigint) owner=postgres language=plpgsql volatility=s security_definer=f config=search_path=pg_catalog, pg_temp acl=postgres=X/postgres body_sha256=42120fc3e51ff7477e2167549c703ce781d8d101c01c801cc3e2c4e287aacb28
function public.get_players_overview(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint) owner=postgres language=plpgsql volatility=s security_definer=t config=search_path=pg_catalog, pg_temp acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres body_sha256=1a17b7643486d5db0e9d415e567817e6108ec87f1d1b094208f0d79c101d0d2f
function public.get_players_overview_export(p_academy uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text) returns TABLE(total bigint, rows jsonb) owner=postgres language=plpgsql volatility=s security_definer=t config=search_path=pg_catalog, pg_temp acl=authenticated=X/postgres,postgres=X/postgres body_sha256=a74a03ffc6595a5bce475432870754ef3058ee190acfbe63285299357abbdc24
schema players_private owner=postgres acl=postgres=UC/postgres relations=0 types=0
```

- `volatility=s` on all three is the **shared-snapshot guarantee**: PostgreSQL runs a STABLE function with
  its calling statement's snapshot, so one export call reads one database state.
- The private authority is `security_definer=f` with no client grant: it runs only inside an entry, with
  the entry owner's rights.
- The export's grantees are the proposed least privilege: owner + `authenticated`, no `service_role`.
  Oversight still has to confirm them.

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
   - Success: exit 0, `NOTICE: ptf apply: object state 8b9d2f98…, ledger 621 to 20261208100000`, and
     `INSERT 0 1` (`INSERT 0 0` on a re-run).
   - Refusal: psql exits 3, and nothing changes. The guard names the cause:
     - target, ledger;
     - the object state, with the full descriptor in DETAIL (any attribute of any of the objects: privileges,
       owner, config, volatility, SECURITY DEFINER, body, or a stray `players_private` /
       `get_players_overview_export`);
     - a prepared transaction;
     - migration/DDL work in flight;
     - a lock timeout.

     Fix the cause and preflight again.
   - Never run the migration on its own or through `supabase db push`.
3. **Post-check (read-only), immediately.** Use the same command with `-f docs/deployment/ptf-release/postcheck.sql`.
   Done only if:
   - every `*_ok` column is `t`: `ledger_ok`, `state_ok` and `client_roles_ok`;
   - `foreign_access` and `foreign_export` are both `refused: not authorized`;
   - `prepared_xacts` is 0 and `in_flight` is empty.

   The second result lists the object state; it must equal the PTF block above.
4. **Frontend, only after step 3 passes.** Put the candidate's frontend live on production (a separately
   authorized merge to `main`, which Vercel deploys), then confirm the production deployment's commit.
   - **The order matters.** The old function body silently ignores unknown filter keys, and the export RPC
     does not exist before apply. A new frontend on the old database would show everyone under "Currently
     training" and fail every export.
   - Database-first is safe: the current frontend never sends the new keys, never calls the export, and the
     list returns the same columns.
   - **A1 changes who appears in academy lists at once** (list, campaign, booking and invoice pickers, rebook
     priority). Players reachable only through a shared trainer's other sessions, the trainer's own roster or
     unstamped sessions disappear from an academy; players linked only by the academy's metadata appear.
     Quantify it before step 2 with `PTF_A1_IMPACT_OBSERVATION.md`.
5. **Observe for 15–30 minutes:**
   - function errors, including `22023`, `42501` and `54000` rates;
   - overview and export latency;
   - export refusals and cancels;
   - download failures;
   - academy reports of missing players (A1).

   No player data in logs or chat.

## Lock and compatibility behaviour (measured locally on real PostgreSQL)

- Apply is not blocked by any of these, and it completed with all three open:
  - open reader transactions;
  - uncommitted DML (`RowExclusive`);
  - an autovacuum-strength lock (`ShareUpdateExclusive`).
- A transaction that was already open may keep running the old body until its next invalidation point,
  without error. New transactions run the new body.
- **The in-flight probe** (apply and recovery guards, post-check) refuses when another session holds or
  awaits:
  - the migration ledger;
  - the schema lock that creating a relation (table, view, index, sequence) takes on `public` or
    `players_private` (creating a function takes none);
  - a DDL-strength lock (`Share`, `ShareRowExclusive`, `Exclusive`, `AccessExclusive`) on any relation in
    `public`;
  - any lock on one of the release's functions.
- `ShareUpdateExclusive` is deliberately not refused: autovacuum and ANALYZE hold it routinely. Each probe
  is point-in-time; the quiesced-writers rule above still applies.
- The ledger `ACCESS EXCLUSIVE` lock serialises migration runs. Waits are bounded: `lock_timeout` 5 s,
  `statement_timeout` 60 s. No reader blackout is required.

## Recovery

1. **Frontend first:** revert production to the previous deployment (`HJ3eNSHPJ`, commit `edf299b5b`).
2. **Only if the database must be restored:** run `recovery.sql`, with the same command form and
   `-1 -v expected_sysid=…`. It accepts the 621 ledger with the PTF state, or its own re-run.
   - It reinstalls the exact canonical list body (`0f42f53c…`, 29,903 bytes; the privileges are preserved,
     `search_path=public` is restored).
   - It then drops `public.get_players_overview_export(uuid, text, jsonb, text, text)`,
     `players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean)`
     and schema `players_private`, each by exact signature and without `CASCADE`. Any dependent object
     makes the DROP fail and the whole transaction roll back.
   - It verifies the BASE state and records ledger version `20261208110000`. A re-run writes `INSERT 0 0`.
   - After it: `preflight.sql` shows the canonical body and ACL, with 622 ledger rows (so reviewed+ACL is
     `f`, which is expected), and `apply.sql` refuses until a new reviewed composition exists.
   - No ledger rewind. If it is ever used, commit `restore_canonical_get_players_overview.sql` plus the
     three DROP statements as `supabase/migrations/20261208110000_players_overview_restore_canonical.sql`
     before any later release.

## Local evidence

`src/test/ptfReleasePacket.realpg.test.ts` runs every file here through real psql against real PostgreSQL:
embedded 18.4 by default, and `PTF_PGBIN` for production's 17.6. The harness mirrors production:
- Supabase's schema-scoped default function privileges, which reproduce production's three-grantee ACL
  exactly;
- global default privileges on new schemas and functions, the worst case for what PTF creates;
- the canonical chain;
- the 620-version ledger derived from the repository plus the F0/ACL versions.

It proves:
- baseline parity with the receipt and the BASE state;
- every refusal leaves the state unchanged: each attribute drift, stray objects, four kinds of DDL in
  flight, a ledger lock, and recovery before apply;
- no blocking by readers, DML or vacuum-strength locks;
- the exact PTF state, a no-op re-run, and a post-check that passes only after apply;
- no client role reaching the private authority, and the export available to `authenticated` only;
- option A, A1, E1 and tenant refusal on real PostgreSQL;
- **the shared snapshot**. Another session commits a new guest while one export call waits (at the entry's
  authorization read, and at the authority's main statement). The call does not see the guest, and the next
  call does. With the authority or the export made `VOLATILE`, the same commit becomes visible, so the test
  discriminates;
- exact recovery, including a refusal on a drifted PTF object.

The semantic matrix is `playersOverviewCurrentTraining.pglite.test.ts` on the same migration bytes. It covers:
- option A;
- the 16 A1 cases, including trainer scope byte-for-byte against the canonical body on the same data;
- export = list for every sort and several filters;
- per-entry authorization with the authority's check stubbed out;
- the 20,000 / 20,001 bound.

## Performance

**Regression budget** (2,000-guest fixture in the suite: 20 cycles and 80 standalone sessions, about 20,000
bookings over four statuses, plus a second academy's noise):
- a filtered 50-row page may cost at most 1.5 × the unfiltered page + 100 ms;
- the whole-academy export stays at or under 2 s.

**Decision packet §3** (run with `PTF_MEASURE=1` in one granted heavy slot, on 17.6):
- the fixture: 20,000 people, 5,000 sessions, about 200,000 bookings, plus two academies sharing the
  trainers with about 100,000 bookings of history;
- list pages within the budget above;
- one 20,000-row export at or under 50% of the configured `authenticated` statement timeout. Until Tom's
  A1 observation reads it, that is the Supabase default of 8 s, **unverified**.

**Results.** One author-run execution, local only, on 2026-09-29, at commit
`235c33dffc82b49bb62cf74f093e487484a50044`:
- **How:** `src/test/ptfReleasePacket.realpg.test.ts` with `PTF_MEASURE=1`, on PostgreSQL 17.6 binaries started
  by the suite's harness, driven by psql 17.
- **Outcome:** 13/13 tests and Vitest exit 0. The run records the counts below exactly: 5,000 sessions,
  200,000 bookings, 100,000 R/S bookings, 20,000 people exported.

| Median of 5 | 2,000-person fixture | 20,000-person fixture (§3) | Budget |
| --- | --- | --- | --- |
| unfiltered 50-row page | 26 ms | 293.8 ms | reference |
| "Currently training" 50-row page | 30 ms | 367.8 ms | ≤ 1.5 × unfiltered + 100 ms: met |
| training-club 50-row page | 33 ms | 330.1 ms | ≤ 1.5 × unfiltered + 100 ms: met |
| whole-academy export, one call | 32 ms (2,000 rows) | 373.8 ms (20,000 rows; payload 2,595,574 bytes) | ≤ 2 s (2k); ≤ 4 s = 50% of 8 s (§3): met |

These are in-database timings of one call through a local `pg` client on a synthetic fixture.

**Not measured and not claimed:**
- wall-clock time and memory of the run; the run had no resource wrapper, so those are unavailable;
- production latency, PostgREST, network or browser time;
- production data distribution;
- the configured `authenticated` statement timeout. The 8 s basis is the unverified platform default until
  the A1 impact observation reads the real setting.
