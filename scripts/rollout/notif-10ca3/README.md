# 10c-a3 rollout bundle — executable artifacts

Executable, checked-in, CI-verified artifacts for rolling out **#616 (send-invoice-email
maintenance gate + observable tracking)** then **#615 (the three `20261006*`
email-delivery migrations)**. This replaces the prose runbook: every check is a
script or a `\set ON_ERROR_STOP on` SQL file that **fails loudly**.

Nothing here merges, deploys, enables a digest event, or mutates production on
its own. The digest worker / digest event stay **disabled throughout**.

---

## What is proven locally + in CI vs. owner-only

**Proven here (no Docker, no prod)** — also run by CI on every change to this
directory (`.github/workflows/rollout-tooling.yml`), and all at once via
`npm run verify:rollout`:

| proof | command | evidence | result |
|---|---|---|---|
| SQL artifacts execute on the real chain; every assertion mutation-pinned | `node …/verify/verify-artifacts.mjs` | [verify-run.txt](evidence/verify-run.txt) | 13/13 |
| A–F rehearsals (measure / lock-abort / prefix-recovery / full / state-recompute / clone-battery) | `node …/verify/rehearsals.mjs` | [rehearsals.txt](evidence/rehearsals.txt) | 28/28 |
| exact-identity allow-list rejects look-alike hosts / wrong refs | `bash …/verify/identity-selftest.sh` | [identity-selftest.txt](evidence/identity-selftest.txt) | 14/14 |
| critical guards fail when weakened (mutation) | `bash …/verify/guard-mutation-test.sh` | [guard-mutation.txt](evidence/guard-mutation.txt) | 78/78 |
| operator control flow (resume615 / recovery-SHA / no-loss / clean-evidence / full clone-command matrix / secure-delete) | `bash …/verify/operator-flow-test.sh` | [operator-flow.txt](evidence/operator-flow.txt) | 145/145 |
| exit-status integrity (a failure can never report success) | `bash …/verify/exit-status-test.sh` | [exit-status.txt](evidence/exit-status.txt) | 30/30 |
| step-6 send verifier enforces the exact invocation/invoice cardinalities | `bash …/verify/step6-verifier-test.sh` | [step6-verifier.txt](evidence/step6-verifier.txt) | 41/41 |
| step-6 fetch+verify is atomic; stale evidence unusable; live terminal-newline shape | `bash …/verify/logfetch-integration-test.sh` | [logfetch-integration.txt](evidence/logfetch-integration.txt) | 63/63 |
| a failed `db push --dry-run` surfaces the CLI reason (secrets redacted) and never yields a pending set | `bash …/verify/dryrun-diagnostics-test.sh` | [dryrun-diagnostics.txt](evidence/dryrun-diagnostics.txt) | 101/101 |
| every linked-db path links its OWN worktree to the pooler and verifies it before pushing | `bash …/verify/worktree-link-test.sh` | [worktree-link.txt](evidence/worktree-link.txt) | 81/81 |
| a clone can never be touched unless its source was quiesced and it is provably inert | `bash …/verify/clone-safety-test.sh` | [clone-safety.txt](evidence/clone-safety.txt) | 53/53 |
| log-retrieval request well-formed + window-bounded | `bash …/logfetch/fetch-edge-logs.sh --dry-run` | [logfetch-dryrun.txt](evidence/logfetch-dryrun.txt) | OK |

The harnesses boot an embedded Postgres, reproduce the Supabase default-privilege
footgun, and apply the **real** chain: base email + on-main digest from the tree,
then the three PR #615 migrations read at a **pinned SHA** (`verify/chain.mjs`
`PR615_SHA`), so the proof is deterministic and reproducible in CI.

**Owner-only (needs the real Supabase project):** the live `run-rollout.sh`
prod-mutating steps (`gh pr merge`, `supabase functions deploy`,
`supabase secrets set`, `supabase db push`) and the live edge-log fetch. The
executable rehearsals above prove the SQL / lock-timeout / atomicity / recovery
behaviour those steps depend on.

---

## Files

```
run-rollout.sh              operator dispatcher (#616 then #615; per-step gated)
lib/common.sh               logging; EXACT-identity allow-list; drain/pending guards; psql runner
sql/_assert.sql             portable assertion helpers (pg_temp.assert / assert_eq / note)
sql/preflight.sql           pre-migration reads + delta-absent + A_window/CAP (also post-abort check)
sql/manifest.sql            no-loss manifest: salted address/id fingerprints + reader fingerprints
sql/academy_fixture.sql     disposable-clone reader precedence proof (+ rollback proof)
sql/postflight.sql          post-migration delta present + INERT + digest-disabled
sql/acl_matrix.sql          self-contained ACL lockdown assertions
sql/ledger_verification.sql append-only ledger + email-table consistency invariants
sql/clone_source_inventory.sql READ-ONLY outbound inventory (names/counts/md5 only)
sql/_cron_fp.sql            THE cron configuration fingerprint, defined once
sql/_cron_inflight.sql      THE in-flight definition (complement of terminal)
sql/_fence.sql              fence assertions — used ONLY by the retained recovery path
sql/_acl.sql                the marker/fence ACL matrix (recovery path only)
sql/cron_quiet_sample.sql   one quiescence sample (recovery path only)
sql/clone_source_resume.sql ONE atomic transition out of a window opened by the
                            WITHDRAWN tooling (recovery only)
sql/empty_project_check.sql prove a disposable target is EMPTY and outbound-inert
sql/cron_noop_shim.sql      inert cron/pg_net shims, installed BEFORE the build
sql/clone_deactivate_schedules.sql  belt-and-braces: nothing active on the target
sql/rehearsal_inert_check.sql       the clone-side inertness gate
sql/baseline_fingerprint.sql        shape + size + distribution + ledger identity
sql/clone_wipe.sql          reset to bare metal (schema + shims + migration ledger)
sql/withdrawn/*             the withdrawn fence design, retained for review only
synth/build-baseline.mjs    synthetic scale loader (no production value is read)
clone-safety/reviewed-cron-jobs.tsv  the reviewed job allow-list + outbound classification
logfetch/fetch-edge-logs.sh Management API edge-log retrieval + authoritative drain proof
logfetch/verify-step6-send.sh  step-6 send verifier (explicit --from-file only; no default)
verify/chain.mjs            shared embedded-PG setup + SHA-pinned migration source
verify/verify-artifacts.mjs SQL-artifact proof (+ mutations)
verify/rehearsals.mjs       executable A–F rehearsals (incl. step-8 clone battery)
verify/identity-selftest.sh identity allow-list proof
verify/guard-mutation-test.sh critical-guard mutation proofs
verify/operator-flow-test.sh  resume615 + clone-command runtime proof (stubbed gh/git/supabase/psql)
verify/exit-status-test.sh    exit-status integrity proof (masked-failure regression)
verify/step6-verifier-test.sh executable fixtures + mutants for the step-6 verifier
verify/logfetch-integration-test.sh fresh-evidence contract: fetch+verify is atomic
verify/dryrun-diagnostics-test.sh   the dry run must surface the CLI failure reason (redacted)
verify/worktree-link-test.sh       the rollout worktree links its OWN pooler before any push
verify/clone-safety-test.sh        quiesce/restore + clone inertness gate proofs
evidence/                   captured run outputs
```

---

## Rollout order (operator)

`check-identity` and `phase616` are **already DONE** — #616 is merged (`429d35c3`)
and deployed, and the gate is OFF. **Do not run `phase616` again**; re-running it
would attempt a second merge/deploy of an already-shipped PR. The remaining steps
are 6→11 below.

```bash
export EXPECTED_REF=<20-char-project-ref>
export SUPABASE_ACCESS_TOKEN=<PAT>          # Dashboard -> Account -> Access Tokens
export SUPABASE_DB_PASSWORD=<db password>   # consumed by the CLI; never echoed
export MANAGER_TOKEN=<academy-manager JWT>  # freshly minted, short-lived; NOT service_role
# psql auth via PGPASSWORD — keep the password OUT of argv and the connection URL
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
PROD="postgresql://postgres@db.$EXPECTED_REF.supabase.co:5432/postgres?sslmode=require"

# [DONE] identity — refuse to run against the wrong project
run-rollout.sh check-identity

# [DONE] #616: pin-checked merge (--match-head-commit) + deploy from the merge-SHA
#        worktree (--project-ref) + verify gate OFF
run-rollout.sh phase616 --yes

# 6. [PENDING — blocks everything below] production-verify #616 with ONE REAL
#    (non-test) invoice send; see "Step 6" below for the pass/fail contract.

# 7. #615 dry run: pinned head-SHA worktree + real `supabase db push --dry-run`;
#    asserts EXACTLY 20261006100000/110000/120000 pending
run-rollout.sh dryrun615

# 8. rehearsals A–D on ONE synthetic, empty-project target (see "One target for A–D") —
#    clone-make-prefix + clone-push + verify-clone, never against prod

# 9. preflight on prod (read-only): row counts, delta absent, CAP_STMT
#    (this production value is authoritative; the clone's is only an expectation)
run-rollout.sh preflight "$PROD"

# 10. #615 maintenance window (gate ON -> AUTHORITATIVE DRAIN PROOF -> dry-run==3 ->
#     bounded db push from the worktree -> postflight/acl/ledger + baseline compare -> gate OFF)
CAP_STMT=<ms-from-preflight> PROD_CONN_URL="$PROD" \
  run-rollout.sh apply615 --yes         # MIN_DRAIN_SECONDS defaults to the 520s floor

# 11. no-loss comparison, then destroy the retained evidence
run-rollout.sh clean-evidence --yes "$PROD"
```

- **The push cannot be reached without an EXACT drain proof.** After the gate is
  ON, `prove_drain`: (a) fires a **safe authenticated non-probe canary that must
  return 503**, and the maintenance body echoes its `invocationId` (see the
  canary-correlation contract below); (b) waits `MIN_DRAIN_SECONDS` (default
  **520s** — the 400s hosted-function wall + margin; a value below the floor is
  rejected); (c) reads **one widened, minute-rounding-padded analytics snapshot**
  `[T_GATE-MIN-60s, now+60s]` and enforces everything **locally**: the canary's
  **exact** `event:blocked` invocationId present, **zero post-gate**
  `provider_send_started` (compared against the gate epoch, not a minute-rounded
  bound), no in-flight straggler, no `record_failed`. Log reads are **fail-closed**
  — an empty/missing `.result`, a truncated page, an unrelated/stale blocked
  event, or a wrong id all abort before `db push`.
- **No SHA drift.** #615/#616 heads are pinned in `PINS.env`; `apply615`/`phase616`
  assert the live head equals the reviewed pin and merge with
  `gh pr merge --match-head-commit`, so only the CI-tested commit ships.
- **Each rollout worktree links itself to the pooler.** `supabase/.temp/` is
  gitignored, so `git worktree add` never carries it into the detached worktree
  that `dryrun615`/`apply615`/`resume615` build. The CLI there finds no pooler
  metadata and falls back to the DIRECT host `db.<ref>.supabase.co`, which
  resolves **IPv6-only** — step 7 failed with *"IPv6 is not supported on your
  current network"* even though the ordinary checkout was correctly linked.
  **Running `supabase link` in your normal checkout does NOT fix this**: every
  one of those commands builds a fresh worktree that inherits none of it, so
  `apply615` would hit the same wall *after* entering its rollout sequence. Each
  worktree therefore runs `supabase link --project-ref "$EXPECTED_REF"` itself
  (password from the environment; never `--password`, never `--skip-pooler`) and
  then fails closed unless its own `.temp` names `EXPECTED_REF` and a
  regular-file, password-free `postgres(ql)://postgres.<ref>@….pooler.supabase.com:5432|6543`
  URL — never the direct host — with the tracked tree still clean. The ambient
  `.temp` is never copied: it is mutable, unversioned and could point anywhere.
  `phase616` and the `--db-url` clone paths do not link.
- **The caps must actually cap.** PostgreSQL reads `statement_timeout=0` and
  `lock_timeout=0` as **disabled**, so a cap of `0` would unbound the migration
  while every log line still said "bounded"; and both values are interpolated
  into `PGOPTIONS`, where `3000 -c statement_timeout=0` would smuggle in a second
  option. `assert_caps` therefore requires `CAP_STMT` **and** `CAP_LOCK` (default
  3000) to be positive decimal integers — no 0, sign, unit, whitespace or extra
  `-c` — and runs before the merge, before the gate changes, and before any push
  in `apply615`, `resume615`, `clone-push` and `clone-make-prefix`.
- **Target identity on every URL-taking command.** `preflight`, `postflight`,
  `ledger-status` and `rollback615` assert the connection URL is `EXPECTED_REF`
  by default. All four are **decision** commands: preflight's `CAP_STMT` bounds
  the production push, postflight authorizes gate-OFF, and ledger-status /
  `rollback615` decide resume-vs-stop. (`rollback615` mutates nothing — it reads
  the ledger and prints the recovery guidance for that state; the guard matters
  because guidance derived from the *wrong* database would be acted on.) So a
  wrong URL must never report green. `--clone` is **not an identity bypass**: it
  swaps the assertion to `CLONE_REF`, which must be set, well-formed,
  **different from `EXPECTED_REF`**, and matched exactly by the URL. The
  write-bearing clone commands (`clone-push`, `clone-make-prefix`,
  `verify-clone`) *require* an explicit clone target and refuse without it.
- **Explicit targeting.** every `supabase functions deploy` / `secrets set|unset`
  carries `--project-ref $EXPECTED_REF`; `db push` runs from a detached worktree
  with `SUPABASE_PROJECT_ID=$EXPECTED_REF` and the worktree's own
  `config.toml project_id` asserted to equal `EXPECTED_REF`.
- **Recovery — the executable `resume615 --yes`.** `supabase db push` applies
  each migration file in its own transaction + ledger row, so a mid-way failure
  leaves an ordered PREFIX. `ledger_status` queries
  `supabase_migrations.schema_migrations` (fail-loud on a connection error) and
  accepts **only** `none`, `{V1}`, `{V1,V2}`, or `all`; any impossible subset is
  `invalid` and **stops**. Do **not** re-run `apply615` (it would re-merge and
  re-capture the pre-baseline). Instead `resume615 --yes` **re-enables the gate
  (also when it was found OFF) and runs a fresh exact-canary drain**, requires
  the **exact pending suffix** (prefix1→`V2,V3`, prefix2→`V3`), retries only the
  reviewed pin (or a proven-merged `RECOVERY_PR`), pushes the suffix, requires
  `ledger=all`, runs postflight/ACL/ledger, compares against the **original**
  pre-manifest (never overwritten), and only then turns the gate OFF. See the
  operator recovery contract below.
- **Concurrency-safe no-loss manifest.** `manifest.sql` runs all queries in ONE
  `REPEATABLE READ READ ONLY` transaction (so the fingerprint enumeration and the
  `count(*)` share one snapshot), captured **after the drain** (pre) and
  post-migration. `validate_manifest` enforces internal **completeness**: exact
  line grammar, no unknown/duplicate/malformed lines, and unique `EAS`/`EDE`
  fingerprint counts equal to `eas_rows`/`ede_rows` — a vacuous/incomplete
  capture fails. The compare is a **no-loss subset**: every pre-existing address
  key + `email_delivery_events.id` must still exist post-migration; **new rows
  are allowed**. Counts + `eas_bad_state_rows` are **evidence only**; reader
  fingerprints **must** change.
- **Evidence privacy.** Address keys/ids are **salted SHA-256** fingerprints
  (pseudonymous personal data, not anonymous). The manifests + the per-run secret
  salt are written `0600` under `umask 077`; the salt is passed to psql via the
  environment (`\getenv`, psql ≥ 16) so it never appears in process arguments.
  Delete them after the rollout with `run-rollout.sh clean-evidence --yes <url>`
  (`shred` when available; otherwise the bytes are overwritten in place and then
  unlinked, with a warning — note that on SSD/CoW filesystems an overwrite is not
  a guarantee, so the real controls are the `0600` perms and short retention) — the pre-manifest + salt are the ONLY recovery material for
  `resume615`, so cleanup refuses (preserving every file) unless ALL of:
  exact project identity, `ledger=all`, valid pre/post manifests, a passing
  no-loss comparison, passing postflight/ACL/ledger verification, and the
  maintenance gate confirmed OFF. `edge-log-lines.txt` is not deleted.

---

## Rehearsals A/B/C/D — executed here

`node …/verify/rehearsals.mjs` runs each on its own fresh database and produces
[evidence/rehearsals.txt](evidence/rehearsals.txt):

- **A — A_window.** Seeds 20k rows, times the `ADD COLUMN … STORED` rewrite,
  derives `CAP_STMT` (measured + 50% headroom).
- **B — lock abort.** A second session holds `ACCESS EXCLUSIVE`; the migration
  under `lock_timeout` aborts with **55P03** and leaves the column **absent**.
- **C — none → PREFIX → all + recovery.** Uses the real
  `supabase_migrations.schema_migrations` ledger; a mid-push failure leaves
  `{file1}`; re-pushing the pending files reaches `all` and postflight passes.
- **D — full.** Applies all three, asserts the baseline row counts are preserved,
  and runs academy_fixture + postflight + acl + ledger on the full clone.

### Clone safety — the fence is WITHDRAWN; rehearsals use an empty project

> **Read [`docs/ADR-001-clone-safety-fence-withdrawn.md`](docs/ADR-001-clone-safety-fence-withdrawn.md) before
> anything in this section.** The previous procedure — restore a production
> snapshot, then freeze it with statement triggers on `cron.job` and
> `net.http_request_queue` — is withdrawn and `clone-source-quiesce` now refuses
> before it opens a connection.

Two independent reasons, either of which is fatal:

* Supabase advises against triggers on `net.http_request_queue`, and a
  *deliberately failing* one especially, because it can disrupt pg_net:
  <https://supabase.com/docs/guides/troubleshooting/webhook-debugging-guide-M8sk47>
* `CREATE TRIGGER` needs the table's `TRIGGER` privilege; **`DROP TRIGGER` needs
  ownership**. These are extension-managed tables, so a `GRANT TRIGGER` produces
  a fence that can be installed and never removed.

Production inventory (read-only, 2026-08-02) returned **`FENCEABLE no`** — the
guard refusing in the read-only step, exactly as designed. Taking ownership of
extension objects, joining the extension-owner role, or wrapping the trigger in a
`SECURITY DEFINER` function would each make it work and are all rejected: a
rehearsal mechanism must not be the reason production's ownership model changes.

The withdrawn artifacts are kept, unmodified, under
[`sql/withdrawn/`](sql/withdrawn/README.md) for review. Nothing loads them.

#### What a restore would have copied (the threat that drove the fence)

| copied by a database restore | earliest external send |
| --- | --- |
| `cron.job` — `notification-email-worker`, `notification-whatsapp-worker` on `*/2` | **~2 minutes** after boot |
| `net.http_request_queue` | seconds after boot |
| Vault secrets — **production's provider API keys** | enables the above |
| database webhooks, outbound triggers (incl. nested paths), FDW servers | first write/query |
| `auth.users` and live sessions, and **every customer row** | — |

**Not** copied by a database restore: Edge Functions (the workers themselves),
Vercel deployments and env, project settings/API keys/JWT secret, Storage objects,
the Cloudflare Worker. A restored clone is therefore *dangerous because of the
database state it carries* and *unfaithful because of the infrastructure it
lacks* — see ADR-001 §3.

#### The supported replacement

```bash
# 0. READ-ONLY production audit; mutates nothing, needs no window
run-rollout.sh clone-source-inventory "$PROD"

# 1. Start from an EMPTY, disposable, identity-verified project and PROVE it is
#    outbound-inert before anything is loaded: no cron jobs, empty pg_net queue
#    AND response table, no Vault secrets, no webhooks, no outbound triggers
#    (including nested call paths), no FDWs, no auth users.
CLONE_REF=<disposable ref> run-rollout.sh clone-verify-empty "$CLONE"

# 2. Build the pristine baseline: schema from MAIN (not the #615 pin), every
#    schedule the migrations created deactivated, then SYNTHETIC rows in only the
#    two tables #615 locks, at MEASURED production scale.
CLONE_REF=<ref> run-rollout.sh clone-build-baseline --yes "$CLONE"

# 3. Before each rehearsal, and after any that broke the target:
CLONE_REF=<ref> run-rollout.sh clone-baseline-verify "$CLONE"
CLONE_REF=<ref> run-rollout.sh clone-reset-baseline --yes "$CLONE"
```

Inertness is **proven, not manufactured**: the target never held production
state, so there is no provenance question, no marker and no fence. Four
production snapshot restores become **one empty project**, and **no customer PII
leaves production at all**.

The build is inert *while it runs*: `sql/cron_noop_shim.sql` goes in **before**
the first migration, so the 14 migrations that call `cron.schedule` record intent
and schedule nothing, and no outbound call can leave the box. It fails closed if
the real `pg_cron`/`pg_net` are installed, because they cannot be shadowed.

#### Is the timing rehearsal still honest?

Yes, for the property that matters, with caveats stated in ADR-001 §6. Only
`20261006100000` locks existing data — a full rewrite of `email_address_state`
(generated `STORED` column) and a full validation scan of `email_delivery_events`
(CHECK constraint), plus a backfill. **Every one of those costs is driven by row
count, tuple width, index set and value distribution — none reads what a value
means.** The scale file therefore carries widths and distributions, not just row
counts, and injects a configured dead-tuple ratio to approximate bloat.

The result is a **sound lower bound** on the window and an **exact reproduction of
the locking behaviour**. It is not production's physical page layout, and the
runbook carries that caveat into the go/no-go decision.

#### Remaining prerequisite

`clone-safety/rehearsal-scale.json` ships with `source: "placeholder"` and the
tooling **refuses to build a baseline** until it says `"measured"`. Filling it
needs one read-only production sizing query (ADR-001 §7) that returns counts,
lengths, byte sizes and category names only — no address, no reason text, no row.

#### Recovery (only for a window opened by the withdrawn tooling)

`clone-source-resume` and `clone-source-abandon` are unchanged and still require
explicit prior-window evidence. Production reports `PRIORWINDOW 0`, so there is
nothing to recover; the path is retained rather than weakened.

### One target for A–D — rebuilt between rehearsals, never re-restored

Rehearsals **B and C deliberately leave the target broken**, and **A and D leave
all three #615 migrations applied** — new columns, functions, tables, constraints
and three ledger rows. Reloading rows cannot reverse any of that, so
`clone-reset-baseline` performs a **real rebuild**:

1. `clone_wipe.sql` — drop `public`, drop the shims, and **empty the migration
   ledger** (leaving it would make the next `db push` apply a *suffix*, silently
   producing a prefix-migrated target);
2. `empty_project_check.sql` — prove the target is bare and inert again;
3. the **same build code path** as the original baseline, so a reset cannot drift
   from the thing it claims to restore;
4. the fingerprint must match the recorded baseline byte for byte.

```bash
export CLONE_REF=<disposable ref>          # must differ from EXPECTED_REF
CLONE="postgresql://postgres.$CLONE_REF@<region>.pooler.supabase.com:5432/postgres"

run-rollout.sh clone-verify-empty    "$CLONE"        # once, before anything
run-rollout.sh clone-build-baseline  --yes "$CLONE"  # once
# — rehearsal A —
run-rollout.sh clone-reset-baseline  --yes "$CLONE"  # rebuild
# — rehearsal B —   … and so on for C and D
```

- **One project, not four.** Restoring four production snapshots was the cost and
  the hazard; a rebuild is neither.
- **No production snapshot is ever restored**, so no marker, no provenance
  instant and no fence exist to reason about.
- The target holds **no customer data at all**, so an accidental leak has nothing
  to leak.
- **Destroy the project as soon as the evidence is captured.**

### Applying #615 to the rehearsal target (step 8, owner-only)

Three things make this non-obvious, and all are enforced by the tooling:

- **The migrations are not on `main`.** Step 8 happens *before* #615 merges, so
  the three `20261006*` files exist **only** at `PR615_SHA`. A `db push` from
  `main` would apply **nothing**. `clone-push` builds a detached worktree at the
  reviewed pin and pushes from there — it never merges #615 and never uses the
  ambient linked project (it passes `--db-url`).
- **The target is synthetic, not a copy.** It is built by `clone-build-baseline`
  from an empty project (see above) and rebuilt by `clone-reset-baseline` between
  rehearsals. No production snapshot is restored at any point.
- **Clone commands write.** `academy_fixture.sql` INSERTs before it ROLLBACKs, and
  `clone-push` applies migrations. So every clone command demands `CLONE_REF`,
  proves `CLONE_REF != EXPECTED_REF`, and proves the URL addresses `CLONE_REF`
  exactly. `--clone` alone is not accepted.
- **`clone-push` applies the MISSING suffix, not "all three".** It classifies the
  clone's ledger exactly as production recovery does and requires the matching
  pending set — `none`→V1,V2,V3 · `prefix1`→V2,V3 · `prefix2`→V3 · `all`→no-op ·
  `invalid`→refuse. Demanding all three would make rehearsal C impossible to run,
  which is why that behaviour is now mutation-pinned as a failure.

```bash
export EXPECTED_REF=<prod ref>     # never the clone
export CLONE_REF=<clone ref>       # must differ from EXPECTED_REF
export PGPASSWORD='<clone password>'
CLONE="postgresql://postgres@db.$CLONE_REF.supabase.co:5432/postgres?sslmode=require"
```

Each rehearsal needs its **own pristine snapshot** — B and C leave the clone in a
deliberately broken state. Restore/recreate the clone between them.

**A — measure the real rewrite window.** On a fresh prod-scale clone:
```bash
run-rollout.sh preflight "$CLONE" --clone          # emits rows/bytes + CAP_LOCK/CAP_STMT expectations
CAP_STMT=<from preflight> run-rollout.sh clone-push --yes "$CLONE"   # time this
```
*Evidence:* `preflight` output (row count, MiB, CAP values) + wall-clock duration of the push → `evidence/cloneA-<date>.txt`.
*Pass:* push completes inside `CAP_STMT`. *Fail:* statement timeout → CAP is too low for prod scale; re-derive before step 9.

**B — bounded lock abort.** Fresh snapshot. In psql session 1:
```sql
BEGIN; LOCK TABLE public.email_address_state IN ACCESS EXCLUSIVE MODE;  -- hold it
```
Then, in session 2, run the same `clone-push`. *Pass:* it aborts on `lock_timeout`
(**SQLSTATE 55P03**) and `run-rollout.sh preflight "$CLONE" --clone` still passes
— i.e. the delta is **absent**, nothing partial landed. Release the lock
(`ROLLBACK`). *Fail:* the push blocks past `CAP_LOCK`, or preflight now fails.

**C — prefix recovery.** Fresh snapshot. The prefix is *created on purpose*, by
the real CLI: `clone-make-prefix` hands `supabase db push` a detached worktree at
`PR615_SHA` with the later migration files **pruned**, so the CLI applies exactly
the first file and writes exactly that ledger row. No hand-written INSERT into
`supabase_migrations`, and the prune touches only the disposable worktree.

```bash
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: none
CAP_STMT=<from A> run-rollout.sh clone-make-prefix --yes 1 "$CLONE"    # apply V1 only
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: prefix1
CAP_STMT=<from A> run-rollout.sh clone-push --yes "$CLONE"             # applies the V2,V3 suffix
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: all
run-rollout.sh verify-clone "$CLONE" --clone
```
`clone-make-prefix` needs a **pristine** clone (`ledger=none`) — you cannot
manufacture a prefix over existing state — and accepts depth `1` or `2` only.
*Pass:* `none` → `prefix1` → `all`, and `verify-clone` passes. *Fail:* any
`invalid` ledger state — stop and investigate; do not carry it into step 9.
*Evidence:* the three `ledger-status` lines → `evidence/cloneC-<date>.txt`.

**D — clean full apply + verification.** Fresh snapshot:
```bash
run-rollout.sh preflight "$CLONE" --clone                  # phase 1: delta ABSENT
CAP_STMT=<from A> run-rollout.sh clone-push --yes "$CLONE"
run-rollout.sh verify-clone "$CLONE" --clone               # phase 2: fixture+postflight+ACL+ledger
```
*Pass:* all four artifacts green. Capture the output as `evidence/cloneD-<date>.txt`.

**Cleanup:** destroy every clone/snapshot afterwards — they hold production data.

The battery is **two-phase** by construction: `preflight.sql` asserts the delta is
**ABSENT** while `postflight.sql`/`academy_fixture.sql` require it **PRESENT**, so
`verify-clone` contains **no** `preflight.sql`. Rehearsal F pins that by reading
the artifact list out of `run-rollout.sh`, so re-adding a contradictory artifact
fails locally and in CI before a clone cycle is wasted.

---

## Log retrieval (no `supabase functions logs`)

The installed CLI (v2.107.0) has no `functions logs`; `supabase inspect` covers
Postgres only. Deployed edge logs come from the Management API analytics endpoint
the Dashboard uses:

```
GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
    ?sql=…&iso_timestamp_start=…&iso_timestamp_end=…
Authorization: Bearer <Personal Access Token>
```

`fetch-edge-logs.sh` filters `event_message like '%[SEND-INVOICE-EMAIL]%'`
(dialect-agnostic across the ClickHouse/legacy backends), counts
`event:blocked / provider_send_started / finished / record_failed`, correlates
`invocationId`s, and exits non-zero on a gate bypass or an in-flight straggler.
Keep the window well under 24h (the endpoint silently returns empty near ~48h).

---

## Canary-correlation contract

1. `apply615` sends one authenticated **non-probe** request to `send-invoice-email`
   (a sentinel body; the gate returns before any invoice read/send).
2. With the gate ON the function returns **HTTP 503** with body
   `{"success":false,"error":"invoice_email_maintenance","invocationId":"<uuid>"}`
   (#616 change) and logs `event:blocked {"invocationId":"<uuid>"}`.
3. `prove_drain` captures that exact `<uuid>` and requires **its** `event:blocked`
   line in the analytics window (`--require-invocation`). An unrelated/stale
   blocked event, a wrong id, or an empty result all fail. This proves the gate
   is live, log ingestion is current, and — combined with the local
   `--gate-at-epoch` zero-send check — that no send passed the gate.

## Operator recovery contract (`resume615 --yes`)

Preconditions: the interrupted `apply615` left its original
`evidence/manifest-pre.txt` + `manifest-salt.txt` (reused, never re-captured).
`resume615`:

| ledger state | action |
|---|---|
| `none` | refuse — use `apply615` (nothing applied) |
| `prefix1` (`{V1}`) | **re-enable gate + FRESH exact-canary drain**, then push the exact suffix **`V2,V3`** |
| `prefix2` (`{V1,V2}`) | same fresh drain, then push the exact suffix **`V3`** |
| `all` | verify only (no drain) |
| `invalid` (`{V2}`, `{V1,V3}`, …) | refuse — stop, investigate |

**Fresh drain:** current maintenance state does not prove *uninterrupted* gating,
so for prefix states `resume615` re-activates the gate, sets a fresh `T_GATE`,
and runs the same `prove_drain` (exact-canary correlation, 520s coverage, zero
post-gate starts, no straggler, no `record_failed`) **before** the suffix push —
even if the probe already reports `maintenance=true`.

**Reviewed-recovery-SHA trust:** the default retries the reviewed `PR615_SHA`. A
*differing* recovery is accepted **only** with a fully-reviewed `RECOVERY_PR` +
`RECOVERY_SHA` where the PR head equals `RECOVERY_SHA`, its checks are green, and
it is MERGED — then the push deploys from its **verified merge commit**. Arbitrary
local commits, head mismatches, pending/failed CI, and unmerged PRs are rejected.
`resume615` still never re-merges #615.

## No-loss baseline contract

The migration must not lose data. `resume615`/`apply615` prove, against the
manifest captured after the drain, that **every** pre-existing address key and
event id still exists post-migration; **new** rows (a pre-gate send finishing, a
Resend webhook callback) are allowed. Deleting any pre-existing address/event
fails. This replaces the earlier unsafe exact-count equality.

It does **not** re-merge #615 and does **not** overwrite the pre-baseline. It
retries the reviewed pin (`PR615_SHA`); a corrected migration requires a
separately reviewed `RECOVERY_SHA`. After push it requires `ledger=all`, runs
postflight/ACL/ledger, compares against the original pre-baseline, then turns the
gate OFF. The whole control flow is proven by `verify/operator-flow-test.sh` with
stubbed `gh`/`supabase`/`psql` (`gh` is asserted unused on the **default
reviewed-pin path**; the `RECOVERY_PR` path does call `gh` to prove the recovery
PR is merged, checks-green, and head-matched).

---

## Current status + remaining production-only steps

**#616 is MERGED and DEPLOYED** (merge commit `429d35c3`); `send-invoice-email`
runs from that exact SHA and the maintenance gate is **OFF**. **#615 remains
OPEN, draft, and pinned** at `PR615_SHA` — none of its migrations are deployed,
and it is merged **only** by `apply615`, never by hand. The digest engine is
disabled throughout.

**PENDING — step 6:** one real (non-test) invoice send, verified end to end.
Everything after it is blocked on it.

### Step 6 — real-invoice delivery verification (owner performs)

**It MUST be a real, non-test send.** A `testEmail` send cannot prove step 6:
`recordInvoiceEmailEvent` returns early for test sends (no `record_email_event`,
so no delivery tracking) and the invoice-status stamp is skipped. A test send
proves only that the provider accepted a message — useful as an optional
provider smoke check, **never** as step-6 evidence.

*Setup.* **Strongly preferred: pick an invoice that ALREADY resolves to an address
you control, and change nothing.** `get_invoice_recipient_identity` resolves the
recipient as: the academy-scoped override `academy_player_metadata.billing_email`
→ the linked profile's email → the guest's own email.

Three things can each turn the send into a **200 that proves nothing**, so screen
for all three up front. This query is read-only and returns **booleans only — it
never prints a recipient address**:

```sql
SELECT i.id,
       i.invoice_number,
       i.invoice_date,
       i.status,
       -- resolved by the SAME canonical resolver the edge function uses
       (NULLIF(btrim(public.get_invoice_recipient_email(i.id)), '')
          IS NOT DISTINCT FROM '<an address you control>')            AS resolves_to_me,
       -- duplicate-send guard: sent_at NULL or >= 2 minutes old (RECENT_SEND_WINDOW_MS)
       (i.sent_at IS NULL OR i.sent_at <= now() - interval '2 minutes') AS recent_guard_clear,
       -- same suppression function the edge function calls, on the same resolved address
       (NOT COALESCE(
          public.is_email_suppressed(NULLIF(btrim(public.get_invoice_recipient_email(i.id)), '')),
          false))                                                     AS recipient_not_suppressed
  FROM public.invoices i
 WHERE i.academy_profile_id = '<your academy uuid>'
   AND i.status <> 'cancelled'
 ORDER BY i.invoice_date DESC
 LIMIT 50;
```

Pick a row where **all three booleans are true**. Notes on reading it:
- `is_email_suppressed` is `EXISTS(...)`, so it returns `false` for a NULL/empty
  address — `recipient_not_suppressed` alone does not prove a recipient exists.
  `resolves_to_me` is what proves that, which is why all three are required.
- `recent_guard_clear` is a moving target: if you re-send within two minutes of a
  previous send it flips back to false. Re-run the query immediately before
  sending, not once at the start of the session.
- Both `is_email_suppressed(text)` and `get_invoice_recipient_email(uuid)` are
  `service_role`-only (revoked from `anon`/`authenticated`), so run this as
  `postgres`/service role, not from the client.

Only if no row satisfies all three do you redirect one, and then the edit must be
**row-exact**. `academy_player_metadata` is keyed by `id`; a predicate like
`academy_profile_id = … AND (profile_id = … OR guest_player_id = …)` can match
zero rows (silently doing nothing, so you send to the real player) or several
(so the restore later writes one captured value across all of them). Work from
the primary key and require exactly one affected row:

```sql
-- 1. find the ONE metadata row and record its id + exact prior value.
--    NULL and 'no row at all' are different states — note which you got.
SELECT id, academy_profile_id, profile_id, guest_player_id, billing_email
  FROM public.academy_player_metadata
 WHERE academy_profile_id = '<academy uuid>'
   AND (profile_id = '<player uuid>' OR guest_player_id = '<guest uuid>');
```
- **0 rows → ABORT.** Do not create one. Choose a different invoice; an inserted
  row changes which override exists and there is no clean way to unwind it.
- **>1 rows → ABORT.** Resolve the duplicate first, or choose another invoice.
- **exactly 1 row → continue**, using its `id` (call it `<meta id>`) and its
  `billing_email` (call it `<prior value>`).

```sql
-- 2. redirect BY PRIMARY KEY; RETURNING must print exactly one row
UPDATE public.academy_player_metadata
   SET billing_email = '<address you control>'
 WHERE id = '<meta id>'
RETURNING id, billing_email;   -- expect: 1 row, the address you control
```
If that `RETURNING` prints anything other than one row, stop and investigate
before sending. Then confirm the gate probe reads
`{"status":"active","maintenance":false}`.

*Action.* Send that one invoice from the academy/trainer invoice UI. Not a
preview, not a test send. Note the **invoice id** and the wall-clock minute.

*Fetch AND verify in ONE command.* The `invocationId` is not in the 200 response
(`{"success":true,"email":"<recipient>"}` — no correlation id, and it carries the
recipient address, so do not paste it anywhere) and not in the UI. It exists only
in the function log line. You do not retrieve it by hand: the fetch derives it
from the window it just normalised.

```bash
scripts/rollout/notif-10ca3/logfetch/fetch-edge-logs.sh \
  --ref "$EXPECTED_REF" \
  --start <ISO minute before the send> --end <ISO minute after> \
  --allow-sends --assert-all-finished --fail-on-record-failed \
  --verify-step6-invoice '<invoice uuid>'
```

That is the whole step. One atomic operation: fetch the window → normalise it →
run the drain/record-failure analysis → and only then verify the invoice against
**that same freshly normalised window**. `--allow-sends` is required here — unlike
the drain proof, a send in this window is the expected outcome.

**If the fetch fails, NO verification happened.** The command exits non-zero and
says so; there is no partial credit and nothing to interpret. This is enforced,
not merely documented: the verifier only ever receives the temp file produced by
this run (passed explicitly with `--from-file`), a live attempt **deletes** the
previous `evidence/edge-log-lines.txt` before it starts, and `verify-step6-send.sh`
has **no default input** — run standalone without `--from-file` it refuses.
(Earlier the fetch wrote that fixed path and the verifier defaulted to reading it
independently, so a failed fetch left the previous run's window on disk for the
next verification to consume. `evidence/edge-log-lines.txt` is a **gitignored**
local diagnosis copy of the last *successful* fetch; nothing reads it back.)

The verifier parses every record **structurally** with `jq` rather than grepping
free text, binds the invocation from the single `provider_send_started` carrying
your invoice id, and fails unless all six hold:

| # | enforced |
|---|---|
| 1 | exactly ONE `provider_send_started` for the invoice (this binds the invocation) |
| 2 | exactly ONE `provider_send_started` for that invocation |
| 3 | exactly ONE `finished {"outcome":"sent"}` for that invocation |
| 4 | ZERO `finished` with any other outcome for that invocation |
| 5 | ZERO `blocked` for that invocation |
| 6 | ZERO `record_failed` and ZERO `status_update_failed` for the invoice |

Exit codes: `0` pass · `1` usage/setup · `2` malformed input (fail closed) · `3`
verification FAILED. An empty, truncated or unparseable window is a **failure**,
never a vacuous pass — and "unparseable" means *any* record: the verifier
requires exactly one parsed record per input line, so a single bad line cannot be
skipped while the rest of the window quietly verifies. (`jq -R` reports a
per-input error on stderr and then continues to the next input, exiting 0, so its
exit status alone was not enough.)

Live `event_message` values arrive with the console.log terminator attached, so
the normaliser strips **exactly one** trailing LF or CRLF (`sub("\r?\n$"; "")`)
to keep one log record on one physical line. Embedded newlines are untouched and
two trailing terminators still leave one, so a genuinely malformed record still
fails closed. Output is counts plus the two correlation uuids only — no
address, body, or token. Checks 1–5 key on the invocation; check 6 keys on the
invoice, because `record_failed` and `status_update_failed` log an **`invoiceId`
and not an `invocationId`** (`_shared/invoice-delivery-tracking.ts`,
`send-invoice-email/index.ts`) — exact for a single send of a single invoice.
(`record_failed` also exists in `resend-webhook`, but that logs under the
`[RESEND-WEBHOOK]` prefix, which this `[SEND-INVOICE-EMAIL]`-filtered fetch never
returns.)

*Pass — all four:*
1. the email **arrives** at the controlled recipient, correct branding/reply-to;
2. the integrated `fetch-edge-logs.sh … --verify-step6-invoice '<invoice uuid>'`
   exits **0** (a fetch failure means nothing was verified — re-run it, do not resend);
3. **delivery tracking** recorded it: `SELECT public.get_invoice_delivery_status('<invoice uuid>')`
   reports `sent` (later `delivered` when the Resend webhook lands), and the
   invoice shows as sent in the UI. Use the singular RPC — the plural
   `get_invoices_delivery_status` returns a `linked_email` column you do not want
   in your evidence;
4. no Slack alert fired.

*Stop — any one of these is a FAIL, do not advance.* **Three of them return HTTP
200**, so "the UI said it worked" is not evidence:

| what you see | why it is not step-6 evidence |
|---|---|
| `{"success":true,"skipped":"recently_sent"}` (**HTTP 200**) | the duplicate-send guard short-circuited: `invoices.sent_at` was under 2 minutes old. **Nothing was sent**, no `provider_send_started`, no tracking. Wait out the window (or pick another invoice) and re-run the candidate query. |
| `{"success":false,"error":"email_suppressed"}` (**HTTP 200**) | the resolved address is `hard_bounced`/`complained`, so the send was skipped by design. Nothing was sent. Choose an invoice whose `recipient_not_suppressed` is true — do **not** pass `force=true` to punch through it. |
| any `status_update_failed` for `$INVOICE` (**HTTP 200**, email delivered) | the email went out but the invoice's `sent_at`/`status` stamp failed, so the UI and the DB now disagree. The send is real; the verification is not complete. Report it. |
| `{"success":false,"error":"no_email"}` (HTTP 200) | no recipient resolved — the override never applied, or you picked the wrong row. |
| `503 invoice_email_maintenance` | the gate is unexpectedly ON. Stop and check why before anything else. |
| `500 email_not_configured` | Resend config missing on the deployed function. |
| `record_failed` for `$INVOICE` | the send worked but delivery tracking did not — exactly the defect #615 exists to fix. Report it; do not advance. |
| `finished {"outcome":"send_failed"}` or `{"outcome":"error"}` for `$INVOCATION` | the provider rejected it or the handler threw. |

*Evidence to retain (PII-safe):* the `invocationId`, event names + timestamps,
the invoice id, and the resulting delivery status. **Never** paste recipient
addresses, response bodies, message bodies, or any token.

*Cleanup.* The send itself needs none — it is a normal business email. But if you
redirected the recipient, **restore by the same primary key and verify it**, pass
or fail. Use `NULL` (unquoted) if the prior value was NULL:

```sql
-- restore BY THE SAME id; RETURNING must print exactly one row
UPDATE public.academy_player_metadata
   SET billing_email = <prior value, or NULL>
 WHERE id = '<meta id>'
RETURNING id, billing_email;
-- verify: must equal the prior value recorded in step 1, and be exactly 1 row
SELECT id, billing_email FROM public.academy_player_metadata WHERE id = '<meta id>';
```
Step 6 is not complete until that SELECT returns one row whose `billing_email` is
byte-identical to what you recorded (`NULL` included). Since the setup aborts
rather than inserting, there is never a row to delete.

Then:
1. Provide `EXPECTED_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
   `PROD_CONN_URL`, and a **freshly minted** `MANAGER_TOKEN` (short-lived; mint it
   immediately before the step that needs it — never reuse an exposed one).
2. Run rehearsals **A–D on the synthetic rehearsal target** (see "One target for A–D" above) and record the
   clone's `A_window` / CAP expectations.
3. `preflight "$PROD"` immediately before the window — the **production-derived**
   `CAP_STMT` is authoritative; the clone's value is only an expectation. Stop on
   an unexplained divergence.
4. `apply615 --yes` — pin check, merge, drain proof, bounded push, verification.
5. Turn the gate OFF only after `postflight`/`acl_matrix`/`ledger_verification`
   pass, then `clean-evidence --yes "$PROD"`.
