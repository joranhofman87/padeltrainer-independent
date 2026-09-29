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
| Database | one migration, `20261208100000_players_overview_current_training.sql`: schema `players_private`, the private authority `players_private.players_overview_rows`, the list entry `public.get_players_overview` (same signature, return type and grantees) and the export entry `public.get_players_overview_export` | `PTF_DATABASE_BASELINE_RECEIPT_2026-09-29.md`: ledger 620 to `20261207100000`, after the verified ACL correction; which BASE fields are receipt values is stated below |
| Data, pre-apply | **A1 preservation** (Tom's binding decision, 2026-09-29): academy `f5124b05-6c8b-40e4-9d67-36e2a41acd36` keeps all 34 guest sides that A1 would drop (2 academy-invoice-linked, 32 manual prospects). Each gets one explicit academy relationship: an `academy_player_metadata` row, which is the relationship A1 reads. No schema change. Guest ownership, invoices, bookings, person links and removals are untouched. In the list they render as CAP's `effective_persons` rows (one per canonical person), not necessarily 34. | Tom's production classification (read-only; `ptf_a1_exclusion_classification.sql`, validated on PGlite). The exact set is pinned in two places: by row CAP at execution time, and then by the reviewed PINNING DELTA in `a1_preserve_repair.sql`. |
| Excluded | ABC-16 (deferred; its rebase gate stands), ABC-17 and every booking writer, U2, U4, U7, the F0 UI, any production data repair other than the A1 preservation above | — |

The packet's own files (`SHA256SUMS` in this directory):

| File | Role |
| --- | --- |
| `preflight.sql` | Read-only baseline: byte-identical to the operator-run `ptf_live_baseline.sql` (`86eccf1b…`) |
| `apply.sql` | The only schema write: guard, migration, ledger row and in-transaction verification, all in one transaction. The one data write, `a1_preserve_repair.sql`, precedes it. |
| `postcheck.sql` | Read-only end-state check, the effective client-role privileges, and two refusal probes |
| `recovery.sql` + `restore_canonical_get_players_overview.sql` | Forward recovery to the exact BASE state |
| `state_descriptor.sql` | The CANONICAL state-descriptor query (read-only; prints the descriptor and its sha256). The six copies embedded in apply, recovery and post-check must equal it byte-for-byte; the local suite asserts that. |
| `a1_preserve_capture.sql` | Read-only, with booking evidence bound to the academy's sessions and the dropped guests. It pins the academy's exact A1-dropped guest set (ids, count, sha256 and `effective_persons`) with its classification, for rows CAP and CV. |
| `a1_preserve_repair.sql` | The pre-apply relationship repair (the one data write): guards, one relationship row per pinned guest, and in-transaction verification. It **refuses until the reviewed PINNING DELTA** fixes CAP's `pinned_sha256` and `effective_persons` in its two marked constants. The ids enter only as `-v pinned_ids=…`, a quoted literal read by one canonical parser. Nothing is included or executed from outside the file, and no production id is ever committed. |

## Expected object states

Apply, post-check and recovery compare one **state descriptor**: one line per object this release creates or
replaces.
- **Canonical source:** `state_descriptor.sql`, embedded identically in six places.
- **Function lines:** signature and full arguments (defaults included), return type, and every `pg_proc`
  attribute that changes behaviour or authority:
  - kind, owner, language, volatility;
  - STRICT, set-returning, SECURITY DEFINER, LEAKPROOF;
  - parallel safety, planner support function;
  - config, ACL, body sha256.
- **Deliberately excluded:** `procost` and `prorows`, which are planner estimates only.
- **Schema line:** `players_private`, with its ACL and content counts.
- **Comparison:** the files compare the sha256 of the byte-sorted lines.

**BASE** (sha256 `24b71348940111025c9353b339b5eb8ce4b041922575e4dd9b8f900fa7f84d0b`): production before PTF and
after recovery. The digest combines two kinds of content. Only the first was observed in production.

1. **Receipt-observed** (`PTF_DATABASE_BASELINE_RECEIPT_2026-09-29.md`; the preflight re-prints these):
   - the signature and the argument defaults (receipt line 11: search `NULL::text`, filters `'{}'::jsonb`,
     sort `'name'::text`, direction `'asc'::text`, limit 50, offset 0);
   - the set-returning `TABLE(…)` result;
   - owner, language, volatility, SECURITY DEFINER, config, ACL and body.

   Compare the fresh preflight's `fn_arguments` with the `args=(…)` below.
2. **Apply-guard expectations** (not in the receipt, and not printed by the preflight). Each is fixed by the
   migrations, and `apply.sql` refuses fail-closed on any difference:
   - the list function's kind, STRICT, LEAKPROOF, parallel and support attributes, as created by
     `20261006120000`;
   - the **absence** of `public.get_players_overview_export` and of schema `players_private`. No migration in
     the 620-version ledger creates either.

A preflight that matches the receipt therefore does not prove the whole BASE state. Only `apply.sql`'s
descriptor check does.

```text
function public.get_players_overview(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer) args=(p_scope text, p_scope_id uuid, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'name'::text, p_sort_dir text DEFAULT 'asc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint) kind=f owner=postgres language=plpgsql volatility=s strict=f returns_set=t security_definer=t leakproof=f parallel=u support=- config=search_path=public acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres body_sha256=0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4
```

**PTF** (sha256 `ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc`): after apply. The body
hashes are those of the reviewed migration file's three `$$` bodies, and the local suite checks that.

```text
function players_private.players_overview_rows(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer, p_enrich boolean) args=(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer, p_enrich boolean) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint, sort_ord bigint) kind=f owner=postgres language=plpgsql volatility=s strict=f returns_set=t security_definer=f leakproof=f parallel=u support=- config=search_path=pg_catalog, pg_temp acl=postgres=X/postgres body_sha256=35214faa33ed144d3c06ebacaef3af915427f0b920e3471cb3e6acd25861d4b4
function public.get_players_overview(p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer) args=(p_scope text, p_scope_id uuid, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'name'::text, p_sort_dir text DEFAULT 'asc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) returns TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, email_undeliverable boolean, total_count bigint) kind=f owner=postgres language=plpgsql volatility=s strict=f returns_set=t security_definer=t leakproof=f parallel=u support=- config=search_path=pg_catalog, pg_temp acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres body_sha256=1a17b7643486d5db0e9d415e567817e6108ec87f1d1b094208f0d79c101d0d2f
function public.get_players_overview_export(p_academy uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text) args=(p_academy uuid, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'name'::text, p_sort_dir text DEFAULT 'asc'::text) returns TABLE(total bigint, rows jsonb) kind=f owner=postgres language=plpgsql volatility=s strict=f returns_set=t security_definer=t leakproof=f parallel=u support=- config=search_path=pg_catalog, pg_temp acl=authenticated=X/postgres,postgres=X/postgres body_sha256=a74a03ffc6595a5bce475432870754ef3058ee190acfbe63285299357abbdc24
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

Steps 1–3 (1a–1d included) and Recovery are judged ONLY by the **Operator outcome contract** below: one
matrix and one escalation rule. No other document restates them.

1. **Preflight (read-only).** Use the command above. Contract row **PF**.
   - **1a. A1 preservation: capture (read-only; Tom).** Use the same command with
     `-f docs/deployment/ptf-release/a1_preserve_capture.sql`. Contract row **CAP**. Send the record's
     `pinned_sha256` and `effective_persons` to the owner. Keep `pinned_ids` locally, and never commit it.
   - **1b. PINNING DELTA (owner and review; not an operator run). STOP here until it is reviewed.**
     - One commit sets exactly the two constants marked `PINNING DELTA` in `a1_preserve_repair.sql` to CAP's
       `pinned_sha256` and `effective_persons`, and updates `SHA256SUMS`. Nothing else changes.
     - After review, that commit is the release commit for every later step.
     - Until then the repair refuses: contract row "—", `the capture digest is not pinned`.
   - **1c. A1 preservation: repair (the one data write, before apply; Tom).** Use the same command with
     `-1 -v expected_sysid=7642734024280108049 -v pinned_ids='<CAP pinned_ids>' -f docs/deployment/ptf-release/a1_preserve_repair.sql`.
     - Contract row **PR1** (first run) or **PR2** (a deliberate replay).
     - Keep the NOTICE's transaction time.
   - **1d. A1 preservation: verify (read-only; Tom).** Run the capture again. Contract row **CV**.
2. **Apply (the only schema write).** Use the same command with `-1 -v expected_sysid=7642734024280108049` and
   `-f docs/deployment/ptf-release/apply.sql`. Contract row **A1** (first run) or **A2** (a deliberate replay).
   Never run the migration on its own or through `supabase db push`.
3. **Post-check (read-only), immediately.** Use the same command with
   `-f docs/deployment/ptf-release/postcheck.sql`, with no `-1` (it ends in ROLLBACK). Contract row **PC**.
4. **Frontend, only after row PC is met.** Put the candidate's frontend live on production (a separately
   authorized merge to `main`, which Vercel deploys), then confirm the production deployment's commit.
   - **The order matters.** The old function body silently ignores unknown filter keys, and the export RPC
     does not exist before apply. A new frontend on the old database would show everyone under "Currently
     training" and fail every export.
   - Database-first is safe: the current frontend never sends the new keys, never calls the export, and the
     list returns the same columns.
   - **A1 changes who appears in academy lists at once** (list, campaign, booking and invoice pickers, rebook
     priority). Players reachable only through a shared trainer's other sessions, the trainer's own roster or
     unstamped sessions disappear from an academy; players linked only by the academy's metadata appear.
     The impact observation (Tom, 2026-09-29) found 34 such guest sides, all at one academy. Tom decided to keep
     them all, and steps 1a–1d do that before apply.
5. **Observe for 15–30 minutes:**
   - function errors, including `22023`, `42501` and `54000` rates;
   - overview and export latency;
   - export refusals and cancels;
   - download failures;
   - academy reports of missing players (A1).

   No player data in logs or chat.

## Operator outcome contract (canonical)

This is the only operative contract for steps 1–3 (1a–1d included) and Recovery. Other documents cite this README by path,
commit and sha256; they do not restate it. psql adds `psql:<file>:<line>:` in front of each stderr line.

**Reading a row.**
- Judge each run by the row for the run you **intended**: a first run, or a replay deliberately chosen after an
  escalation.
- Only the "Required" cell decides the outcome. The "Other expected output" cell is derived statically from the
  files, statement by statement, and it never decides anything.

**The escalation rule (the only one).** A result that does not meet every "Required" item of the intended row is
an ESCALATION. Then:
- **Do:** keep the complete stdout, stderr and exit status, and hand them to Tom and the coordinator.
- **Don't:** run anything further: no retry, no next step, no frontend, no bookkeeping.
- **This covers:**
  - a non-zero exit (psql uses 3 for a script error, which includes every guard refusal, and 2 for a lost
    connection);
  - any `ERROR:`, `FATAL:` or `WARNING:` line;
  - a missing or different required line;
  - a no-op result when a first run was intended (someone else has already changed the database);
  - an unknown exit status, or a lost or partial transcript.
- **What a refusal leaves behind:** nothing. A guard refusal changes nothing, because the transaction rolls back.
- **What a lost connection leaves behind:** an unknown outcome during the repair, apply or recovery. It is resolved
  only by a read-only step chosen at escalation.

| Row | Intended run and starting state | Required: every item | Other expected output (never decides) | Outcome, then | Local evidence (`src/test/ptfReleasePacket.realpg.test.ts`) |
| --- | --- | --- | --- | --- | --- |
| **PF** | Preflight before apply: ledger 620 | Exit 0; no `ERROR:`/`FATAL:`/`WARNING:`. The record matches the receipt: `db` postgres, `sysid` 7642734024280108049, `connected_as` postgres; `ledger_rows` 620, `ledger_head` 20261207100000, `ledger_is_reviewed_plus_acl` t, `versions_after_acl` empty; `fn_count` 1; `fn_identity_args`, `fn_arguments` (with the receipt's defaults) and `fn_result` as in the BASE block; `fn_language` plpgsql, `fn_volatility` s, `fn_security_definer` true, `fn_config` `search_path=public`, `fn_owner` postgres; `fn_acl` `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`; `fn_body_sha256` `0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4`, `fn_body_bytes` 29903 | `BEGIN`, `SET`, `SET`, `Expanded display is on.`, the record, `ROLLBACK` | MATCH (receipt-observed fields only, see BASE) → step 1a as CAP | exit status and every value except `db`, `sysid`, `connected_as` and `fn_arguments`: `:407-415` |
| **CAP** | A1 preservation capture, before the repair: ledger 620 | Exit 0; no `ERROR:`/`FATAL:`/`WARNING:`. The record: `pinned_count` 34; `effective_persons` between 1 and 34 (record it: it is the number of list rows these 34 sides render as); `cat3_academy_signal` 2 with `signal_academy_invoice` 2 and `signal_other_academy_signal` 0; `cat6_no_booking_no_signal` 32; `cat1_person_still_listed`, `cat2_other_academy_owned`, `cat4_trained_other_academy`, `cat5_trainer_private`, `cat7_other` all 0; `origin_manual` 34; `refuse_person_removed_side` 0; `refuse_other_side_metadata` 0; `pinned_ids` holding 34 ids; `pinned_sha256` 64 hex characters | `Pager usage is off.`, `BEGIN`, `SET`, `SET`, `Expanded display is on.`, the record, `Expanded display is off.`, `ROLLBACK` | CAPTURED → send `pinned_sha256` and `effective_persons` to the owner for step 1b (the PINNING DELTA). Keep `pinned_ids` locally. | exit status and every value, on the classification's own hand-worked fixture (bounded booking evidence classifies exactly as the validated classification) and on a 34-guest fixture: `:582-588`, `:628-633` |
| **PR1** | A1 preservation repair, first run, at the reviewed PINNING DELTA commit: ledger 620; no pinned guest has a row for the academy; the pinned set is the academy's current dropped set | Exit 0; stdout the one-row `a1_preserve` result `inputs loaded`; stderr `NOTICE:  ptf a1 preserve: inserted 34, linked 34/34 for academy f5124b05-6c8b-40e4-9d67-36e2a41acd36, pinned <CAP pinned_sha256>, effective persons <CAP effective_persons>, dropped now 0, transaction time <timestamp>`; no `ERROR:`/`FATAL:`/`WARNING:` | `SET` ×3, the `a1_preserve` row, `LOCK TABLE`, `DO` | PRESERVED: 34 relationship rows; nothing else written → step 1d. Keep the transaction time: with the academy and the pinned ids, it identifies the 34 rows. | on a fixture-pinned copy (the committed file with only the two PINNING DELTA lines substituted): exit status and the NOTICE; the 34 rows (canonical person stamped, no notes or tags); invoices, bookings, person links, guests, another academy's rows, ledger and state unchanged as exact row images: `:739-754`. Each refusal changes none of them: the unpinned template; system identifier; 8 malformed or injected `pinned_ids` values; unsorted; duplicate; 33 ids; another 34-set; a moved set; academy-owned; inactive trainer; a removed side; an already-related profile side and guest side; partial run; persons moved; split-frozen: `:670-737` |
| **PR2** | Repair, deliberate replay at the same commit: every pinned guest already has its row | Exit 0; the PR1 NOTICE with `inserted 0, linked 34/34` (same pinned digest and persons); no `ERROR:`/`FATAL:`/`WARNING:` | As PR1 | NO-OP (the relationship rows byte-identical) → step 1d | the rows unchanged; another 34-set and the unpinned template refused on replay too: `:756-762` |
| **CV** | Capture again, after PR1 or PR2 | Exit 0; no `ERROR:`/`FATAL:`/`WARNING:`; `pinned_count` 0, `effective_persons` 0, `pinned_ids` `{}`, `pinned_sha256` `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (the empty set) | As CAP | VERIFIED → step 2 as A1. After apply, the academy lists these sides as CAP's `effective_persons` rows. | `:764-765`. After apply, a fixture's 34 sides (two of them one person) list as 33 rows, and the repair refuses: `:821-830` |
| **A1** | Apply, first run: ledger 620, BASE state | Exit 0; stdout `INSERT 0 1`; stderr `NOTICE:  ptf apply: object state ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc, ledger 621 to 20261208100000`; no `ERROR:`/`FATAL:`/`WARNING:` | stdout: `SET` ×3, `LOCK TABLE`, a one-row `set_config` result showing `7642734024280108049`, `DO`; then the migration's `CREATE SCHEMA`, `REVOKE`, `CREATE FUNCTION`, `REVOKE`, `CREATE FUNCTION`, `REVOKE`, `GRANT`, `CREATE FUNCTION`, `REVOKE`, `GRANT`; then `INSERT 0 1`, `DO` | APPLIED → step 3 | exit status, `INSERT 0 1` and the NOTICE's digest: `:789-791` |
| **A2** | Apply, deliberate replay: ledger 621, PTF state | Exit 0; stdout `INSERT 0 0`; the same NOTICE as A1; no `ERROR:`/`FATAL:`/`WARNING:` | The A1 stdout with `INSERT 0 0`; stderr also has `NOTICE:  schema "players_private" already exists, skipping` | NO-OP (nothing changed) → step 3 | exit status, `INSERT 0 0` and the state unchanged: `:912-916`. The NOTICE is raised unconditionally when the verification passes (`apply.sql:180`); it is not asserted on replay. |
| **PC** | Post-check after A1 or A2 | Exit 0; no `ERROR:`/`FATAL:`/`WARNING:`. The record: `db` postgres, `sysid` 7642734024280108049, `connected_as` postgres; `ledger_rows` 621, `ledger_head` 20261208100000; `ledger_ok` t; `state_ok` t; `state_sha256` `ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc`; `client_roles_ok` t; `foreign_access` and `foreign_export` both `refused: not authorized`; `prepared_xacts` 0; `in_flight` empty. Then `object_state`: exactly the four PTF lines, in order. | `BEGIN`, `SET`, `SET`, `DO`, `Expanded display is on.`, the record, `Expanded display is off.`, the 4 rows, `ROLLBACK` | PASS → step 4 | exit status, every value except `db`, `sysid` and `connected_as`, and each PTF line: `:810-819` |
| **R1** | Recovery, first run: ledger 621, PTF state | Exit 0; stdout `INSERT 0 1`; stderr `NOTICE:  ptf recovery: object state 24b71348940111025c9353b339b5eb8ce4b041922575e4dd9b8f900fa7f84d0b (the base), ledger 622 to 20261208110000`; no `ERROR:`/`FATAL:`/`WARNING:` | `SET` ×3, `LOCK TABLE`, the `set_config` row, `DO`, `CREATE FUNCTION`, `REVOKE`, `GRANT`, `DROP FUNCTION`, `DROP FUNCTION`, `DROP SCHEMA`, `INSERT 0 1`, `DO` | RECOVERED → Recovery step 3 | exit status, `INSERT 0 1` and the NOTICE's digest: `:1009-1012` |
| **R2** | Recovery, deliberate replay: ledger 622, BASE state | Exit 0; stdout `INSERT 0 0`; the same NOTICE as R1; no `ERROR:`/`FATAL:`/`WARNING:` | The R1 stdout with `INSERT 0 0`; stderr also has three NOTICEs ending `does not exist, skipping` | NO-OP → Recovery step 3, if not already done | exit status and `INSERT 0 0`: `:1023-1025` |
| **—** | Anything else, in any step | — | A guard refusal prints `ERROR:  ptf apply guard: …`, `ERROR:  ptf recovery guard: …` or `ERROR:  ptf a1 preserve guard: …` (the object-state case adds the descriptor in DETAIL). Before step 1b, the repair always prints `ERROR:  ptf a1 preserve guard: the capture digest is not pinned in this reviewed file…`. A verification failure prints `ptf … verify: … rolled back`. A lock timeout prints `canceling statement due to lock timeout`. | ESCALATION | Refusals (non-zero exit plus the guard or lock message) for the system identifier, ledger, object state, in-flight DDL and lock timeout: `:432-514`. Recovery before apply refuses: `:508-510`. |

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
   `-1 -v expected_sysid=7642734024280108049`. Contract row **R1** (first run) or **R2** (a deliberate
   replay). Anything else falls under the escalation rule: stop, keep the complete output, and do NOT do
   step 3.
   - It reinstalls the exact canonical list body (`0f42f53c…`, 29,903 bytes; the privileges are preserved,
     `search_path=public` is restored).
   - It then drops `public.get_players_overview_export(uuid, text, jsonb, text, text)`,
     `players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean)`
     and schema `players_private`, each by exact signature and without `CASCADE`. Any dependent object
     makes the DROP fail and the whole transaction roll back.
   - It verifies the BASE state and records ledger version `20261208110000`.
3. **Bookkeeping, only after row R1 or R2 is met:**
   - There is no ledger rewind. Commit `restore_canonical_get_players_overview.sql` plus the three DROP
     statements as `supabase/migrations/20261208110000_players_overview_restore_canonical.sql` before any later
     release.
   - Afterwards, `preflight.sql` shows the canonical body and ACL with 622 ledger rows. So reviewed+ACL is `f`,
     which is expected. `apply.sql` refuses until a new reviewed composition exists.
   - The 34 A1-preservation rows (step 1c) are NOT undone by recovery:
     - they are Tom's decided academy relationships;
     - under the BASE body they change no membership, because those guests were listed there already.
   - Removing them needs a separate decision. The academy, the pinned ids and PR1's transaction time identify
     them exactly.

## Client export: trust boundary

`fetchContactsForExport` (`src/lib/playerContactExport.ts`) checks the export response before any file is
written.
- **What it guarantees:** its guarantee covers what the production transport can deliver.
  - The only production caller, `AcademyPlayers`, passes no `rpc`, so the default
    `supabase.rpc('get_players_overview_export')` is used.
  - That payload is JSON decoded by the client: plain records and arrays with their own data properties.
- **What it is not:** a validator for arbitrary hostile JavaScript objects.
  - The injectable `rpc` option is a developer/test seam. No user input selects or shapes it.
  - An injected transport that returns accessor properties, an index getter, or an array with an overridden
    `map` can still pass (review 6, P3-6). Hardening against that is optional and outside this release.
- **Authorization** is enforced by the database entry (`is_academy_manager`, before the authority is called),
  not by this client check.

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
- every refusal leaves the state unchanged:
  - each drift, applied one at a time to the live function: a grant to `anon`, the owner, `search_path`,
    VOLATILE, SECURITY INVOKER, STRICT, PARALLEL SAFE, LEAKPROOF, and a changed argument default;
  - a stray schema or export function, and the migration run on its own;
  - four kinds of DDL in flight, and a ledger lock;
  - recovery before apply;
- the six embedded descriptor copies equal the canonical `state_descriptor.sql` byte-for-byte;
- no blocking by readers, DML or vacuum-strength locks;
- the exact PTF state, a no-op re-run, and a post-check that passes only after apply;
- no client role reaching the private authority, and the export available to `authenticated` only;
- option A, A1, E1 and tenant refusal on real PostgreSQL;
- **the shared snapshot**. Another session commits a new guest while one export call waits (at the entry's
  authorization read, and at the authority's main statement). The call does not see the guest, and the next
  call does. With the authority or the export made `VOLATILE`, the same commit becomes visible, so the test
  discriminates;
- exact recovery, including refusals on a drifted PTF object: a granted authority, and a STRICT authority.
  The STRICT one keeps `client_roles_ok` and BOTH refusal probes (`foreign_access`, `foreign_export`) green,
  all asserted, yet empties the list; the post-check's `state_ok` catches it;
- the A1 preservation (steps 1a–1d), for the pinned academy:
  - on the classification's own hand-worked fixture, the bounded capture classifies exactly as the validated
    classification did;
  - on a 34-guest fixture (two sides of one person):
    - the capture pins exactly the dropped set and its 33 canonical persons;
    - the committed template refuses until pinned;
    - the input channel refuses every malformed or injected value;
    - every contradiction is refused, changing nothing;
    - a fixture-pinned first run links exactly the 34 once, with the canonical person stamped and every other
      row image unchanged;
    - a replay is a no-op, and a different set is refused;
    - the capture then reads 0;
    - after apply, the academy lists 33 rows, and the repair refuses.

The semantic matrix is `playersOverviewCurrentTraining.pglite.test.ts` on the same migration bytes. It covers:
- option A;
- the 16 A1 cases, including trainer scope byte-for-byte against the canonical body on the same data;
- **merged-person names** (review 01a0ecc9 P1-1): list, search, sort (both directions) and export.
  - Cases: guests-only with an older out-of-scope guest; an out-of-scope account holder; a fully in-scope
    control; a blank admitted profile; an empty and a NULL oldest guest; an exact `created_at` tie.
  - B keeps its own names; trainer scope keeps `persons.full_name` (a recorded follow-up);
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

**Results, corrected tree (PTF-CORRECTION-94ED).** One author-run execution, local only, on 2026-09-29 at 13:42:
- **Tree:** the working tree of the correction commit (HEAD `94ed2cec` plus the uncommitted correction). It
  was identical to that commit except for this results paragraph, which was written afterwards.
- **How:** `src/test/ptfReleasePacket.realpg.test.ts` with `PTF_MEASURE=1`, on PostgreSQL 17.6 server
  binaries, driven by the same psql 18.4 (libpq) client.
- **Outcome:** 13/13 tests and Vitest exit 0.
- **The §3 fixture adds 5,000 merged multi-academy people** to Q's 20,000:
  - each has a second Q guest record, plus either an older academy-R guest or an R-only account holder;
  - each one's global `persons.full_name` is R's.
- **Asserted:**
  - 20,000 people exported;
  - all 5,000 merged people named from their oldest admitted Q guest;
  - 0 R-derived names in the export;
  - 0 search hits for "Secret";
  - the budgets met.
- **Recorded:** 5,000 Q sessions, 200,000 Q bookings, 101,000 R/S bookings, payload 2,605,574 bytes.
- **Medians of 5:**
  - list pages: unfiltered 344.4 ms, "Currently training" 419.5 ms, training club 383.4 ms (budget ≤ 616.6 ms);
  - one 20,000-row export: 421.0 ms (budget ≤ 4 s);
  - 2,000-person fixture: 25 / 31 / 29 ms and a 30 ms export on 17.6; 24 / 31 / 30 ms and a 30 ms export on
    18.4 (separate run).
- **A first attempt failed:** it stopped in the test's own setup (untyped literals in a `UNION ALL`). Only
  two `::uuid` casts were then added to the fixture, and the run above is the one retry.
- **Carried to the review-5 P3 cleanup:** these results still hold, because the cleanup changes no SQL. The
  migration, every packet SQL file and the §3 fixture are byte-identical to `e4acc0ed`. The cleanup's only
  real-PG change is one added assertion in the STRICT drift case (`foreign_export`). That case runs on its own
  slot grant, and its result is recorded in the cleanup's review admission, not here.

**Production build (review 6, P3-8).** One author-run `npm run build`, local, on 2026-09-29, finished 15:49 CEST:
- **Tree:** the clean tree of commit `811dabecff03ed040ebc41a527471d4f6d758c5b`, before this documentation
  was written.
- **Outcome:** exit 0; 5,016 modules; the `AcademyPlayers` chunk is 33.13 kB.
- **Carry-over:** the commit that adds this paragraph changes documentation only, and no build input
  (`src/`, `index.html`, the Vite/TS configs, `package.json`, the lockfiles, `public/`). So the result stands
  for it byte-for-byte on the runtime tree.
- **Scope:** no earlier commit's build is claimed here.

**Results, PRIOR HEAD.** These were measured before correction PTF-CORRECTION-94ED. They stay valid for that
head and don't carry over to the corrected one, whose merged multi-academy 20,000-person check runs under
its own slot grant. One author-run execution, local only, on 2026-09-29, at commit
`235c33dffc82b49bb62cf74f093e487484a50044`:
- **How:** `src/test/ptfReleasePacket.realpg.test.ts` with `PTF_MEASURE=1`, on PostgreSQL 17.6 server binaries
  started by the suite's harness, driven by the psql 18.4 (libpq) client at `/opt/homebrew/opt/libpq/bin/psql`. That is
  the same client path the operator commands above use.
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
