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
| 5 | `activate --yes <url>` | Runs `activation_preflight.sql`, then arms the cron. |
| 6 | `rollback --yes <url>` | Engine off **and** cron inactive, then proves both. |

**Arming the cron before enabling the switch would schedule a worker that finds nothing to do and
reports healthy** — a green light over an engine that is still off. The preflight refuses that, and
five other states besides: an already-armed job, more or fewer than one cutover event, any other
event with the engine on, no dispatch run that has ever succeeded, a group mid-send or awaiting
evidence, and any quarantined orphan provider event.

## Two rules that are asserted, not merely written down

* **Never `cron.unschedule` to pause.** Deactivate. Unscheduling destroys the reviewed Vault-backed
  command, and re-creating it by hand under time pressure is how a wrong endpoint or a missing
  bearer gets introduced. `verify/enablement-selftest.sh` fails if any path here unschedules.
* **Never assert absolute zero against a live system.** A disabled smoke is proven by a *delta*
  across the invocation; anything else running in the window is otherwise indistinguishable from
  the thing under test. The same reasoning is why the canary reconciles the run id the worker
  returned rather than a before/after snapshot.

## Self-test

`verify/enablement-selftest.sh` runs the real dispatcher with `psql` stubbed, because the properties
worth testing are the gates rather than the SQL: refusal without `--yes`, refusal of a url belonging
to another project, preflight-before-arm ordering, switch-before-cron ordering on rollback, the
uuid-only canary argument, and the no-unschedule rule. It is wired into `npm run verify:rollout`.
