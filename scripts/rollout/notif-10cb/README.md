# 10c-b Release Units 2 and 3 — enablement tooling

**Nothing in this directory does anything by itself.** It is a set of individually gated operator
subcommands plus the SQL that proves each step landed. There is no auto-run, no "do it all" mode,
and every step that changes production requires `--yes` and re-asserts the project ref.

Everything here is owner-gated. Building the tooling is not the same as running it, and running any
of the mutating subcommands is an owner decision made from the runbook, not by an agent.

## The sequence, and why it is this order

| # | Step | What it proves |
|---|---|---|
| 0 | *(owner)* ship **Admin Notification Operations** | MANDATORY before any canary or activation. Without it there is no in-product, global view of the pipeline and no safe controls — intervening means a hand-written psql-session against production. Separate release unit; scope and acceptance criteria in [`docs/FOUNDATION_ROADMAP.md`](../../../docs/FOUNDATION_ROADMAP.md). |
| 1 | `status <url>` | Read-only. Engine flags, cron presence/armed state, dispatch liveness, and the counters a disabled smoke must not move. |
| 1b | `assert-inert <url>` | Read-only **gate**. The cron job present is EXACTLY the reviewed one **and inactive**, and no engine is enabled. Must pass BEFORE either switch — the migration preserves an existing job's active state, so a job left armed by an earlier rollout would tick the moment the engine went live. `status` prints these facts; this one fails on them. |
| 2 | `smoke-disabled --switch-off-confirmed <url>` | Read-only. Capture counters either side of a disabled invocation through the real Vault/pg_net path. The invocation must answer **exactly** `200 {"status":"disabled","reason":"disabled"}` and move **no** counter. |
| 3 | *(owner)* set `DIGEST_SEND_ENABLED=true` on `notification-digest-worker` | The edge kill switch. No SQL can see it; this bundle has no view of it. |
| 3b | `enable-engine --yes <url>` | Turns the engine on for the cutover event **only**, in one transaction: the cron must still be inactive, exactly one row changes, and the postcondition proves this event on and nothing else. The activation gate requires this to be true already. |
| 3c | *(owner)* wire the EXTERNAL monitor | Point cron/uptime monitoring at `public.notif_digest_worker_liveness()` and verify it alerts on a stale `last_success_at`. Before the canary, so it is watching from the first send. |
| 4 | `canary-invoke --yes --admin-ops-confirmed --monitor-confirmed [--max-recipients=N] <url>` | **SENDS.** Invokes the worker once, cron still INACTIVE, through the real Vault/pg_net path — by executing the cron job's *own* stored command after asserting it hashes to the reviewed value under a row lock. It prints the reply so you can read **`dispatchRunId`**; that uuid is what every later step passes as `<run_id>`. |
| 5 | `canary --yes --admin-ops-confirmed <url> <run_id>` | Reconciles **that** run and verifies it delivered. Does not invoke anything. |
| 6 | `preflight <url> <run_id>` | Read-only **dry run** of the whole activation gate. Arms nothing. |
| 7 | `activate --yes --monitor-confirmed --admin-ops-confirmed <url> <run_id>` | Verifies **and** arms, in one transaction against the locked job row. |
| 8 | `rollback --yes --switch-off-confirmed <url>` | Engine off **and** cron inactive, then proves both. |

**Step 4 has a subcommand, and it did not always.** It used to read "*(owner)* invoke the worker by
hand", on the reasoning that the moment mail goes out should not happen on a script's say-so. That
reasoning was right about the decision and wrong about the mechanics: it left the single sending step
as the only one performed with no tooling at all — outside `EXPECTED_REF`, outside the `PG*`
stripping, with nothing re-checking that the job was still the reviewed one and still inactive.
`assert-inert` proves that at step 1b, four steps and two switches earlier. `--yes` is where the
owner's intent goes; it was never a reason to run that one statement unguarded.

`canary-invoke` therefore executes **the job's own stored command**, not a transcription of it: it
locks the job row, asserts the whole-command hash, and runs that exact text. So what is invoked is by
construction what was reviewed and what a tick would run, and no checked-in `.sql` grows a
`net.http_post` + `Authorization` + Vault-read triple — the signature
`scripts/check-legacy-service-role-consumers.mjs` exists to find.

**It also bounds the blast radius, which nothing did before.** "Canary: one recipient" was a hope:
the worker sends to every group it can claim, plus everything materialization forms in the same run,
so a backlog left by an earlier rollout would have gone out on the first invocation.
`--max-recipients` (default **1**) is checked **twice**, and the two checks bound different things:

* **before** the request is queued, against a deliberate **over**-estimate of the live digest work
  visible in that transaction — every non-terminal email digest group (`terminal_at IS NULL`, the
  schema-owned clock, never a copied state list) plus every ungrouped pending digest outbox row,
  where many of the latter collapse into one group per recipient. Over-estimating occasionally
  refuses a canary that would have been small, which is the right way round for a gate whose failure
  mode is mail.
* **after** the worker answers, against what the finished run *actually reached* —
  `canary_scope_verify.sql` counts distinct `recipient_key` across the groups that run touched. The
  first check is a snapshot and cannot cover work committed between it and materialization, since
  pg_net dispatches only after the transaction commits; saying otherwise would be a claim the code
  does not make. The second cannot unsend, but it fails the subcommand, so the rollout does not
  continue to `canary` and `activate` as though a one-recipient canary had happened when it had not.

**Splits count once.** A group is one recipient's digest for one boundary, and an oversize group is
split into chunk groups sharing a `recipient_key` — so the post-check counts recipients, not groups.
Counting groups would refuse a perfectly good canary, and a gate that cries wolf gets switched off.

**Note what `--admin-ops-confirmed` actually gates.** With step 4 now a subcommand, the flag is a
mechanical precondition on the send itself, not only on reconciling (step 5) and arming (step 7). A
failed canary was never invisible — it has an HTTP result, `canary_verify.sql` and the worker's Slack
alert. What is missing without the admin surfaces is a global view and a safe way to intervene.

**`canary-invoke` cannot send by accident.** If `DIGEST_SEND_ENABLED` is off the worker answers
`200 {"status":"disabled","reason":"disabled"}` and nothing goes out — which is why there is no
`--switch-on-confirmed` flag: the failure direction is safe, and the surfaced response says so
plainly. A 200 with **no** `dispatchRunId` is treated as a failure, because there is then no run for
`canary` to reconcile and nothing was sent.

**Arming the cron before enabling the switch would schedule a worker that finds nothing to do and
reports healthy** — a green light over an engine that is still off. The preflight refuses that, and
a good deal more besides: an already-armed job, more or fewer than one cutover event, any other
event with the engine on, a group mid-send or awaiting evidence, and any quarantined orphan.

## Verification and arming are one transaction

`activate.sql` opens a transaction, takes `FOR UPDATE` on the exact `(jobname, username)` row,
runs every assertion against **that locked row**, arms **that jobid**, and asserts the postcondition
before committing. The assertions themselves live in `sql/_activation_assertions.sql`, shared with
the read-only dry run so the two cannot drift into checking different things.

It is written that way because checking in one statement and arming in another is a
time-of-check/time-of-use hole. Between the two the job can be altered, re-pointed or unscheduled,
and everything the check proved describes a job that is no longer there. Worse, arming *by name*
when the job has been deleted matches zero rows and **succeeds** — so the tooling would report the
cron as ARMED over nothing at all.

## Three things the gate refuses that are easy to get wrong

* **A job that merely has the right NAME.** The F migration deliberately leaves an existing
  `notification-digest-worker` job alone (an unschedule/reschedule would silently disarm an
  activation the owner had already performed), so the job present at activation time may not be the
  one that was reviewed. Its stored command is what a tick executes, and that command posts a
  Vault-decrypted `service_role` bearer to whatever url it names. The preflight therefore checks the
  schedule, the **node** it dispatches to (`nodename`/`nodeport` — a re-pointed job runs the reviewed
  command, hash and all, against a different server), the database, the owner, the endpoint, that
  **no other** url appears, that the bearer is read from Vault at tick time rather than inlined, and
  finally that the whole command hashes to the reviewed value. `src/test/notif10cbActivationPreflight.test.ts` recomputes that hash from the
  migration on every CI run, so the two cannot drift apart in silence.
* **Evidence from a previous rollout.** `activate` takes the canary's run id and every canary
  assertion is scoped to it. It must also be the newest dispatch run — nothing in flight, nothing
  that **started** after it, nothing that **ended** after it — and less than six hours old.
  Otherwise "a canary succeeded" stays permanently true from an earlier attempt, and a canary that
  failed today cannot stop an activation. Both timestamps are compared because ordering by
  completion alone misses a run that started later and failed fast.
* **An `accepted` attempt that did not correlate.** `record_notification_digest_result` writes the
  attempt as `accepted` *before* it notices the group is bound to a different provider message; it
  then manual-holds the channel and returns `correlation_mismatch`. The **worker** reads that return
  value, counts it, refuses to count it as a send, and fails the run — before that fix it discarded
  the return, so once the cron was armed it would have reported a healthy 200 every five minutes
  while the channel was held open.

  The SQL checks remain, as defence in depth and because they cover what a return value cannot: the
  preflight compares the attempt's provider message id against its group's, checks the run's ledger
  for a `global_config` event, requires the email circuit to be **closed**, and rejects any orphan
  provider event still unreconciled against a group this canary sent. That last one matters most —
  a tag/message mismatch arriving by **webhook** takes the uncorrelated branch and enrols an orphan
  with `quarantined = false`, leaving the group `sent`, the circuit closed and the run ledger
  untouched. The orphan row itself **is** durable — it is exactly what these assertions read. What
  nothing durably records is that the already-completed **run** was unhealthy: the webhook handler
  fires a best-effort alert, but it cannot change the status of a run that has finished, so the run
  keeps reading `succeeded` and only the first armed tick would quarantine the orphan and fail.
  `canary_verify.sql` checks the same properties at canary time.

## The command a tick runs must be safe on its own

Every name in the scheduled command is schema-qualified — `pg_catalog.jsonb_build_object`,
`OPERATOR(pg_catalog.||)`, `::pg_catalog.jsonb` — and that is not house style. A cron job runs under
its owner's `search_path`, which is settable per role and per database and which by default still
contains `public`. **Function resolution does not prefer `pg_catalog`:** an exact-arity, exact-type
overload beats `pg_catalog`'s `VARIADIC "any"` wherever its schema sits in the path, *including after
an explicit `pg_catalog`*. So an unqualified `jsonb_build_object` would hand the decrypted
`service_role` bearer to anyone who could create `public.jsonb_build_object(text,text,text,text)`, on
the very next tick, while returning plausible headers. **Both operators** are qualified for the same
reason: `||` builds the header value and `=` selects the Vault row, and a hostile `(text,text)`
equality runs inside a query over `vault.decrypted_secrets` and can change *which* secret comes back.

**How that is proved, and why it is not a text scan.** `verify/preflight-pg.mjs` builds a view over
the command, then compares the stored parse tree (`pg_rewrite.ev_action` — the OIDs the planner
actually bound) between an empty `search_path` and a hostile one. Identical trees mean identical
resolution. The candidates it plants are *derived from that tree*: every operator, function and cast
OID it names is looked up and re-created in a hostile schema with the same signature, and anything
that cannot be shadowed is reported rather than skipped.

Three earlier versions of this check were wrong, and are recorded in the harness so nobody re-derives
them: a **regex** over the command is a partial parser and missed `=`, then `LIKE`/`IN`/`BETWEEN`/
`CAST(x AS t)`; an **empty search_path** proves nothing because `pg_catalog` is searched implicitly
whatever the path says; **`pg_depend`** is blind because initdb objects are pinned and get no
dependency rows; and **`pg_get_viewdef`** is not identity-preserving, because PostgreSQL renders
`IS DISTINCT FROM` and `CASE x WHEN y` as syntax and the deparse reads identically even when the
underlying operator has been redirected.

**Every artifact pins the path too**, session-wide (`SET search_path = pg_catalog`) as its first
executable line — not `SET LOCAL`, which `COMMIT` reverts while these files are still asserting and
printing. This is load-bearing, not decorative: `_job_identity_assertions.sql` alone calls `count`,
`md5`, `btrim`, `regexp_replace`, `regexp_matches` and `current_setting` unqualified, and a hostile
`md5(text)` makes the whole-command hash match any command at all. A test enumerates the directory,
so a new artifact cannot forget, and walks the include graph so a shared file is only ever reached
from a pinner.

**And nothing reaches psql except those artifacts.** The reconcile and the two rollback writes used
to be inline `psql -c` statements — separate processes under the role/database path, where `::uuid`,
`now()` and `=` are all lookups no artifact pin could reach. They are now `sql/canary_reconcile.sql`
and `sql/rollback_disable.sql`, and the self-test enforces the rule structurally: every `psql_safe`
call site must be inside one of the two file-based wrappers.

## The connection string is not just a url either

`assert_conn_url_is_ref` parses a URI. libpq accepts a **second** form — keyword/value conninfo
(`host=… user=… dbname=…`, last occurrence winning) — and on that form the URI parser reads the
wrong thing entirely. A value like `dbname=postgresql://postgres.<expected>@<expected-pooler>/…
host=<other> dbname=postgres` splits at the first `://` into an authority naming the expected
project, passes every check, and is then handed to psql, which connects to `<other>`. So the string
must start with `postgresql://` or `postgres://` and contain no whitespace or control characters.

## Three preconditions this tooling CANNOT see, and therefore refuses to assume

All three live outside the database, so no SQL here can check any of them. The operator asserts each
with an explicit flag and the tooling refuses without it — the alternative is a script that says it
verified something it never looked at.

* **`DIGEST_SEND_ENABLED`** is an env var on the edge function, and it is the worker's real kill
  switch. Nothing in *this* bundle can read or set it (Supabase's own secret tooling can, which is
  how the operator changes it — this script simply has no view of it). `--switch-off-confirmed` on
  `smoke-disabled` and `rollback`.
* **Admin Notification Operations** — the release unit that provides global admin visibility into
  the pipeline and safe controls (acceptance criteria in `docs/FOUNDATION_ROADMAP.md`). MANDATORY
  before any canary or activation, a separate release unit, and nothing here can detect whether it
  has shipped. `--admin-ops-confirmed` on `canary-invoke`, `canary` and `activate` — so it now gates
  the send as well as reconciliation and arming.
* **The external cron/uptime monitor** on `notif_digest_worker_liveness()` is the only detector for
  a worker that is never invoked — an unscheduled or disabled job, a missing Vault secret, a paused
  project all produce silence, and the in-worker Slack alert needs the worker to run in order to
  fire. `--monitor-confirmed` on `canary-invoke` **and** `activate`. Wire it and verify it alerts on
  a stale `last_success_at` before the FIRST send, not before the arm: the canary *is* the first
  send, so requiring it only at activation would start the watch one step too late.

## Two rules that are asserted, not merely written down

* **Never `cron.unschedule` to pause.** Deactivate. Unscheduling destroys the reviewed Vault-backed
  command, and re-creating it by hand under time pressure is how a wrong endpoint or a missing
  bearer gets introduced. `verify/enablement-selftest.sh` fails if any path here unschedules.
* **Never assert absolute zero against a live system.** A disabled smoke is proven by a *delta*
  across the invocation; anything else running in the window is otherwise indistinguishable from
  the thing under test. The same reasoning is why the canary reconciles the run id the worker
  returned rather than a before/after snapshot.

## The connection is not just the url

`assert_conn_url_is_ref` validates the url, and libpq does not connect from the url alone. It also
reads the `PG*` environment, where `PGHOSTADDR` supplies an address directly (a *separate* parameter
from `host`, applied even when the URI carries one), `PGSERVICE`/`PGSYSCONFDIR` can inject one from a
service file, and `PGOPTIONS` can re-point `search_path` under every unqualified reference in the
artifacts. So an expected-ref url passed every string check and connected somewhere else entirely.

Every `psql` invocation in this bundle therefore goes through `psql_safe` (in
`../notif-10ca3/lib/common.sh`), which removes the identity-affecting `PG*` variables from the child
and disables `~/.psqlrc`. Any `PG*` variable the bundle does not recognise **stops the run** rather
than being guessed at — it may well be a newer libpq identity parameter. `PGPASSWORD`/`PGPASSFILE`
are left alone: they cannot redirect a connection, and they are how the password is supplied.

If a connection needs a non-default port, put it in the url. `PGPORT` is stripped.

## Self-tests

Both are wired into `npm run verify:rollout`.

* `verify/enablement-selftest.sh` runs the real dispatcher with `psql` stubbed, because the
  properties it covers are the **gates**: refusal without `--yes`, refusal of a url belonging to
  another project or carrying a query string, preflight-before-arm ordering, switch-before-cron
  ordering on rollback, the uuid-only run-id arguments, the no-unschedule rule, and the `PG*`
  environment handling. The stub records the environment it was actually given, because the property
  is about the child process — checking the parent's environment would pass with the stripping gone.
* `verify/preflight-pg.mjs` executes `activation_preflight.sql`, `canary_verify.sql`,
  `assert_inert.sql`, `enable_engine.sql` and `canary_invoke.sql` on a **real** PostgreSQL against
  production-shaped rows. A stub can only show that an artifact ran; this shows that it would have
  **refused**. Each scenario mutates one fact away from a passing baseline and pins which assertion
  did the refusing, so a scenario cannot pass by failing for the wrong reason. The `canary-invoke`
  scenarios additionally assert that a refusal **queued nothing** — a gate on a sending step that
  refuses loudly and posts anyway is worse than no gate — and the passing one reads back the request
  the reviewed command actually made: the reviewed endpoint, and a bearer it could only have got by
  reading Vault at execution time.
