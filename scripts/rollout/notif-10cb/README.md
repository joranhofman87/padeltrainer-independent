# 10c-b Release Units 2 and 3 — enablement tooling

**Nothing in this directory does anything by itself.** It is a set of individually gated operator
subcommands plus the SQL that proves each step landed. There is no auto-run, no "do it all" mode,
and every step that changes production requires `--yes` and re-asserts the project ref.

Everything here is owner-gated. Building the tooling is not the same as running it, and running any
of the mutating subcommands is an owner decision made from the runbook, not by an agent.

## The sequence, and why it is this order

| # | Step | What it proves |
|---|---|---|
| 1 | `status <url>` | Read-only. Engine flags, cron presence/armed state, dispatch liveness, and the counters a disabled smoke must not move. |
| 2 | `smoke-disabled <url>` | Read-only. Capture counters either side of a disabled invocation through the real Vault/pg_net path. The invocation must answer **exactly** `200 {"status":"disabled","reason":"disabled"}` and move **no** counter. |
| 3 | *(owner)* enable the send switch | — |
| 4 | `canary --yes <url> <run_id>` | Reconciles the **actual** run id the canary invocation returned. Cron still inactive. |
| 5 | `preflight <url> <run_id>` | Read-only **dry run** of the whole activation gate. Arms nothing. |
| 5 | `activate --yes <url> <run_id>` | Verifies **and** arms, in one transaction against the locked job row. |
| 6 | `rollback --yes <url>` | Engine off **and** cron inactive, then proves both. |

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

## The connection string is not just a url either

`assert_conn_url_is_ref` parses a URI. libpq accepts a **second** form — keyword/value conninfo
(`host=… user=… dbname=…`, last occurrence winning) — and on that form the URI parser reads the
wrong thing entirely. A value like `dbname=postgresql://postgres.<expected>@<expected-pooler>/…
host=<other> dbname=postgres` splits at the first `://` into an authority naming the expected
project, passes every check, and is then handed to psql, which connects to `<other>`. So the string
must start with `postgresql://` or `postgres://` and contain no whitespace or control characters.

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
* `verify/preflight-pg.mjs` executes `activation_preflight.sql` and `canary_verify.sql` on a **real**
  PostgreSQL against production-shaped rows. A stub can only show that an artifact ran; this shows
  that it would have **refused**. Each scenario mutates one fact away from a passing baseline and
  pins which assertion did the refusing, so a scenario cannot pass by failing for the wrong reason.
