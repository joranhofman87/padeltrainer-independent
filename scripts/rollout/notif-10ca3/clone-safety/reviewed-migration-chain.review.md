# Reviewed migration-chain pin — the review behind the digest

`reviewed-migration-chain.json` is a claim: a human reviewed the WHOLE migration chain for
scheduling and outbound capability, and its digest was taken afterwards. This file is the record
behind the current value, so a later reader can tell a reviewed re-pin from a blind hash
replacement. Update it with every re-pin.

## The pin

|            | previous                                                              | current                                                               |
|------------|-----------------------------------------------------------------------|-----------------------------------------------------------------------|
| sha256     | `3d87a2a95000198b20acdf47fb12fae75b648b5521a451359a9238c18982efce`    | `52900f2b8aa90dae5a8bba3bdadb7d8a2dd1d835dbe5e246357fb9f5a9e2230b`                                                      |
| files      | 607                                                                   | 643                                                                   |
| pinned     | 2026-08-07 (commit `e1c6b5f0`, PR #638)                               | 2026-09-04 (the commit that carries this file)                        |

Generator: `node scripts/rollout/notif-10ca3/synth/sanitize-migrations.mjs supabase/migrations <out> --write-pin`,
run only after the review below. Before pinning, the generator's own sweep — the extension
allow-list and the outbound-call patterns, over comment-stripped text — reported no refusal other
than the digest mismatch (exit 4, one refusal), and `--write-pin` refuses to run on any other.

## What changed since the reviewed 607-file chain

`git diff --name-status e1c6b5f0..HEAD -- supabase/migrations`: 36 files ADDED, 0 removed,
0 modified. One of the 36, `20261118110000_abc16_abc17_relationship_evidence_containment.sql`,
was corrected in the same commit as this re-pin (an explicit `service_role` EXECUTE grant on
`get_invoices_delivery_status`, and the comment that explained the omission); the digest covers
the corrected bytes.

### Per-file review

Scan: comment-stripped text (`/* */` and `--` removed, as the generator does) matched against
scheduler calls (`cron.schedule` / `unschedule` / `alter_job` / `schedule_in_database`), network
primitives (`net.http_*`, `extensions.http_*`, `supabase_functions.http_request`, `dblink`,
`pg_read_file`, `COPY … PROGRAM`, FDW DDL), `CREATE EXTENSION`, Vault reads, role DDL,
`SET [LOCAL] ROLE`, `ALTER DEFAULT PRIVILEGES` and untrusted-language bodies. Every hit was then
read in context; the findings follow the table.

| file | lines | sha256 of the reviewed bytes | capability hits (comment-stripped statements) |
|---|---:|---|---|
| 20261113100000_u1a_academy_player_memberships.sql | 52 | `4ed542ef39d2a18da7143a6224ecefb5ed6129985aff27d97cb2134acac29313` | none |
| 20261114100000_u1b_membership_backfill_manifest.sql | 115 | `8c4eff654678f9a9cf74b4ce0dbd11925423b702ffc15b6a22ab78aef73aca75` | none |
| 20261115100000_u1c_prereq_membership_repoint.sql | 752 | `007e96c0e26b31aea4a03dbc2450d427cfa27c5918f50dbcb555134a7a786c97` | none |
| 20261116100000_u1c_prereq_deletion_preflight.sql | 79 | `93721abe27607218dd9fd49d0bd01f6d1400c48ada95f094aa8156866dcf90a6` | none |
| 20261117100000_u1c_prereq_academy_deletion.sql | 1401 | `9c25d6bd3d8136022fd6c447c567797dcf14a90b4da6e6f132afd2a705ca1b55` | none |
| 20261118100000_u1c_prereq_backup_export.sql | 230 | `0cf44646519971e2412b42e2c62625773f45343002df21b87efd75e2ee994754` | none |
| 20261118110000_abc16_abc17_relationship_evidence_containment.sql | 5467 | `8820d99b817263d563f33bf3babae6a3d70991699b478bbcd86feb57793f85c5` | none |
| 20261118115000_d7_runtime_crons.sql | 262 | `6ed3cfb7e9d5f21101e76a1ba6c089b3526c563118eee0960d4f73ed789a69ff` | scheduler×7, network×3, vault×6 |
| 20261118115500_d7c_cross_owner_contention_closure.sql | 1030 | `46b544b146362a204988105277a078668874db45804fa123befa9979a97f3f62` | none |
| 20261118120000_abc27_rebook_round_notification_authority.sql | 20634 | `05e04451f944cabfaaa74842cacf6e7b0299afc366b443d9609908136e86d78f` | role DDL×4, SET ROLE×6, default ACL×1 |
| 20261203110000_d7_retire_member_open_surfaces.sql | 323 | `f2d8234b70e9f97ceab7d0fcf0c86486a7e23ef0b921a001135be2eacebad09a` | none |
| 20261203120000_d7_paid_group_hold_safety.sql | 379 | `74e44e68070fffa09cb55c1cbbe32cc2c99e18dbee094c9f0654759bb8ed63f1` | SET ROLE×3 |
| 20261203130000_d7_dispatch_linearization.sql | 513 | `3973e7c3dbd613e0d44952cc0f0b507c8384215d277248e58b8e868b293feb01` | SET ROLE×3 |
| 20261203140000_d7_paid_group_hold_booking_anchored.sql | 418 | `edd589747ef1133eb4c27513d8b7d010bb19a846d89a120aa970fdb589eba6f5` | SET ROLE×3 |
| 20261203150000_d7_dispatch_after_cutoff_reason.sql | 382 | `eb30fc830052f916a95b5ee4d2e1751f8e6eef4a027a71375c396ad2d1c8fbce` | SET ROLE×3 |
| 20261203160000_d7_runtime_guard_hardening.sql | 143 | `946589a5976ec1bcdf5d25753de04b0f9025a5c995867d08457379d3b066cf60` | none |
| 20261203180000_d7_cohort_selection_authority.sql | 694 | `920e3d976755ab5f06904e50597baef39bbae100d14a321a31d9ac5578625afa` | none |
| 20261203190000_d7_selection_actor_surface.sql | 644 | `c3243a98260eeff749c0f72fe2feca84dda370752e932c7120d9ebd519fefdba` | none |
| 20261203200000_d7_human_child_names.sql | 220 | `4e8f32875e6dd99e4a714ff832997220475be6bffe9d26f0e28932b53a15114e` | none |
| 20261203210000_d7_selection_apply_surface.sql | 265 | `a6f66d0c007a8dbd4c33ba17749420c4b9ee9514afe6cec6a1af65504154bc6f` | none |
| 20261203220000_d7_naming_persisted_form.sql | 208 | `5f8155f2fe149c0ae3a0ef23e7490c8b19b6f630f5da959d419b7d6185443974` | none |
| 20261203230000_d7_selection_semantics_closure.sql | 1049 | `8aa900827143f4b266a1f840ef78375048c230602d1d19d6f3447d92fc739ea7` | none |
| 20261203240000_d7_protected_event_vocabulary.sql | 218 | `c78f564025ea380c0b21815a333b582c7bac32d2062e6f07660d169cdbe1d2e2` | none |
| 20261203250000_d7_invite_recipient_bridges.sql | 172 | `f460c4f12c6d1a90eac0f38416362ed1b41dd4714ad702195f124e83e47dde0b` | none |
| 20261203260000_d7_transport_subject_model.sql | 271 | `f6197a5230f5f38d5936bb6320643d81f5d318642e1647324f4482992e599782` | none |
| 20261203270000_d7_transport_subject_authority.sql | 375 | `980119a684ee497ce85e1420a8cc141a04dfa1bcd2357119d44a07702d69f0f4` | none |
| 20261203280000_d7_outbox_guard_subject_split.sql | 191 | `b18c6d75628d44d1e1e05b7e53491762b149d7830df9a4843defaa64404e325e` | none |
| 20261203290000_d7_protected_invite_enqueue.sql | 563 | `c0da7d73f6c7acba459d7d4a83b651a00a4c34dbf4e5bc177dd6791ad6f22777` | none |
| 20261203300000_d7_tier4_future_base.sql | 131 | `960b5a45c251a666f19971cb75f1d92ee1cbfe2bb8fc009114c8eeb329c601ed` | none |
| 20261203310000_d7_invite_dispatch_closure.sql | 289 | `fff7590dce16257e8bd839b432a8bacc0df8861dfb6686c0c9e48ab3c73b5395` | none |
| 20261203320000_d7_invite_identity_and_hold.sql | 172 | `33627a2ac5c9bc916a3e8dbc95af24f58c7207501b0ccfd4d3f8ae379c3bc3da` | none |
| 20261203330000_d7_invite_dispatch_policy.sql | 296 | `68d36068e5b0225f44930228db4faeaa2b9e8559f85831b5da5fdbf2b4b57c4d` | none |
| 20261203340000_d7_invite_offer_and_race.sql | 297 | `30eb54a1d4a515bb650357b5809bd98d95da56aba691ae1f95082557a5400214` | none |
| 20261203350000_d7_invite_offer_contract.sql | 334 | `77dbb5f7b4303ce033bd673deb80ae1f26258c350cec3603e5bad4a1dcb70eae` | none |
| 20261203360000_d7_invite_verdict_authority.sql | 378 | `c9caa8b24cdfb98f9e74592350e8fdbbd2c68929e5bda1ff042eee920a54f2ee` | none |
| 20261203370000_d7_invite_enqueue_contract.sql | 422 | `605fee24a8ea8f6681217f90cb1ded4cb758a974b8c7caa4f3d1a9137514881b` | none |

### Findings for the six files with hits

1. `20261118115000_d7_runtime_crons.sql` — the ONLY file that touches the scheduler or the network.
   - `cron.unschedule(…)` ×1: retires the ONE pre-D7 member-open notifier job, whose edge function
     this release deletes; the lookup is owner-scoped (`username = current_user`). The file names
     that job; this record does not, because `src/test/d7RuntimeWiring.test.ts` enforces that no
     file outside its reviewed exclusions spells a retired name.
   - `cron.schedule` ×3: `rebook-member-open-worker` (`*/2`), `rebook-round-materializer` (`*/5`),
     `rebook-member-open-janitor` (`*/10`). Each is followed, in the SAME `DO` block and transaction,
     by `cron.alter_job(v_jobid, active := false)`: the job is recorded inactive with no window in
     which a scheduler tick could fire it. A job that already exists is left exactly as the owner
     left it, active or not.
   - `net.http_post` ×3 and `vault.decrypted_secrets` ×6: the three `net.http_post` calls live
     INSIDE the scheduled `$cmd$` command literals and execute only when a job is active, which
     nothing in the chain makes true; Vault is read once per job as an existence probe (a NULL is
     tolerated and reported) and once inside each command.
   - All three job names are registered in `reviewed-cron-jobs.tsv` as `SHIPS INACTIVE` (the
     worker `outbound=yes`, the materializer and janitor `outbound=no`), and
     `src/test/reviewedCronJobsRegister.test.ts` fails on any scheduled name missing from that
     register.
   - Executable confirmation at this re-pin (2026-09-04):
     * `src/test/d7ForwardChain.realpg.test.ts` installs the file against a stub `pg_cron` and
       asserts every D7 job row is `active = false` ("must ship INACTIVE — arming it is an owner
       gate"); it runs in the `db-tests` lane on every PR.
     * A fresh local stack (`supabase start`, REAL pg_cron) applied this file in this run and
       logged each job as scheduled INACTIVE; the stack then stopped at the frozen
       `20261118120000` unit's own Stage-0 preflight (see below), which is why the run is
       recorded here rather than in the workflow.
     * The sanitized chain — the rollout's own build input — applied through
       `20261118115500` (616 files) on a bare embedded PostgreSQL over `sql/platform_stub.sql`
       (the harness's platform roles, nothing else) leaves `cron.job` with zero active rows,
       `net.http_request_queue` empty, and neither `pg_cron` nor `pg_net` installed. On that
       target this file takes its `pg_cron not installed — skipping` arm, so it schedules nothing.
     * `verify/clone-safety-pg.mjs` step [5b] would make the same zero-active assertion after the
       FULL chain, but at this re-pin it stops earlier: the frozen `20261118120000` unit refuses
       the bare project in its Stage-0 preflight ("a Domain-P relation's ACL cardinality drifted
       from the pinned 4-role x 8-privilege predecessor seed" — the bare project carries none of
       the hosted project's default ACLs). That refusal is the frozen unit doing what it is
       certified to do outside its predecessor shape; it is not a property of the pin.
2. `20261118120000_abc27_rebook_round_notification_authority.sql` — the FROZEN ABC-27 unit
   (byte-exact; sha256 in the table). Every role-related hit, by line of the comment-stripped text:
   - line 627 — the ONE role statement: `EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT
     NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', …)`, minting the
     owner-approved `padeltrainer_abc27_owner` domain role when absent (an existing one is adopted
     only under a closed privilege gate, or refused).
   - line 1835 — two matches inside one HINT string (`DROP ROLE on a policy audience raises 2BP01`,
     `CREATE ROLE "PUBLIC" succeeds where lowercase public is reserved`): text explaining a
     refusal, not statements.
   - line 2989 — one match inside a HINT string (`… a mid-install ALTER ROLE impossible`): text.
   - `SET ROLE` ×6: all inside exception and hint TEXT describing what the unit refuses; the unit
     issues no `SET ROLE` statement of its own.
   - `ALTER DEFAULT PRIVILEGES` ×1: a hint string in the preflight that REFUSES to install beside
     any default-ACL drift (the statement form appears nowhere in the file).
   No scheduler, no network, no extension.
3. `20261203120000`, `20261203130000`, `20261203140000`, `20261203150000` — `SET LOCAL ROLE %I`
   ×2 each, inside `DO` blocks that switch to the Domain-P / Domain-N owner to re-emit that owner's
   functions and switch back (transaction-local); the third hit in each is the error text raised
   when the switch is refused. No other capability.

### The other 30 files

No hit of any class: DDL and DML on public objects only — the U1a/U1b/U1c membership, deletion
and backup-export prerequisites, the ABC-16/17 containment (with the correction above), and the D7
selection, transport, invite and naming units.

### What the chain still does NOT contain

No new `CREATE EXTENSION` (the generator's allow-list is unchanged; the two neutralised
extensions remain `pg_cron` and `pg_net` at 20260117134212 / 20260330204208); no new outbound
FUNCTION (`reviewed-outbound-functions.tsv` unchanged — the only `net.http_post` texts in the
36 files are the inactive cron commands above); no `dblink`, FDW, `COPY … PROGRAM`, server-file
read or untrusted-language body.
