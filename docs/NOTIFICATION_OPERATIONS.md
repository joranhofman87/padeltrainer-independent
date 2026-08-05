# Notification operations — running it, and getting it back

Status: **canonical** (N6) | last updated 2026-08-05
Audience / AI-read: yes. **Pinned by `src/test/notificationFoundationDocs.test.ts`.**
What the pipeline *is*: [`NOTIFICATION_FOUNDATION.md`](NOTIFICATION_FOUNDATION.md).

Everything here is doable from **`/admin/notifications`** or the reviewed rollout artifacts. If a
procedure below needs psql against production, that is a gap — say so rather than improvising.

---

## 1. The one page: what it tells you

| Section | The question it answers | Fail-closed behaviour |
|---|---|---|
| Readiness | May this system be activated right now? | Never reads `pass` — `DIGEST_SEND_ENABLED` is an edge env var no SQL can read. `fail` or `not_provable`, and the env line is page text, never a tooltip |
| Delivery paths | Which paths are open, since when, and what is held back | An inert path says *"sends nothing"* in words; a boundary that does not exist renders `—`, never a blank that reads as a date |
| Channels + gauges | Is a channel killed? What is queued? | A missing gauge is `unknown`, not `live` |
| Event states | Per event × channel: catalogue, caps, cron, circuit, kill, and the switch that actually governs each path | Instant and digest conclude **separately**; whatsapp digest is `not_applicable` (there is no such path); an unverifiable env switch can only produce `unknown` |
| Invocations | Is a deliberate smoke/canary in flight or stale? | An unresolved invocation blocks activation |
| Outbox / groups / runs / orphans | What happened to a specific send, and what is stuck | Every list bounded + keyset-paginated; destinations masked |
| Recipient preview | Who would receive this event, and *why* | Mirrors the resolver exactly, including its account-email fallback; a bounded scan says `PARTIAL` rather than implying completeness |
| Decisions + rejected attempts | What did operators do, and what did the server refuse | Append-only; refusals are recorded on the return path |

**Every control is disable-only.** There is no resend, no retry, no redeliver — because provider
acceptance can be ambiguous and a "retry" over an ambiguous send is a duplicate. The complete admin
function surface is pinned by a test that also asserts no function name matches
`retry|resend|redeliver`.

## 2. Stopping a send, right now

**Kill the channel** (`/admin/notifications` → Channels → *Kill*). It takes effect at the claim and
again immediately before every provider call, so rows already claimed are released rather than
sent. It is **immutable evidence**: clearing a kill is an owner/runbook act, deliberately not an
API path, because un-killing is the same act as deciding to send.

If the digest path is misbehaving but email must keep flowing, prefer the narrower control: the
breaker (`admin_reset_notification_circuit` only *closes* it) and the group cancel
(pre-dispatch only — any send evidence refuses).

## 3. Interpreting the monitors

| Signal | Where | What it means | What it does NOT mean |
|---|---|---|---|
| `notif_digest_worker_liveness()` | external uptime monitor (owner-wired) | last **succeeded** dispatch run and its age | Not "mail is arriving" — only that the worker ran |
| Worker Slack alert | `digest_worker_alert` | a run finished unhealthy (group error, reconcile failure, orphan drain failure, correlation mismatch) | Not a page: the run is recorded either way |
| `correlationMismatches > 0` | run summary / admin | the provider accepted a message the group is **not** bound to | Never a retry trigger — hold the channel and investigate |
| Quarantined orphans | Orphan queue | a provider callback could not be correlated after N attempts | Not a lost email; the send may well have arrived |
| Readiness `fail` | Readiness panel | a *named* check failed — read the check, not the badge | — |

A worker that is never invoked is invisible from inside the database. The liveness read is the only
detector, and it must be wired **before** the first canary, not after.

## 4. Diagnosing one notification without exposing anyone

1. **Outbox** → filter by event/status. You get status, skip reason, masked destination, tenant,
   attempt count.
2. **Delivery history** (drill-down on the row) → the ordered attempt/provider timeline, keyset
   paginated, PII-free.
3. **Recipient preview → "Why?"** → the effective preference *provenance* for one user: catalogue,
   explicit preference, opt-in arm, academy cap (and whether it applied), required override,
   contact **source** (a contact row vs the account-email fallback), suppression, kill/circuit, and
   the final decision.
4. If that is not enough, the answer is a **missing surface** — add it. Reading raw destinations
   from production is not a diagnostic step.

Never paste a recipient address into an issue, a Slack thread or a commit message. The masked form
is sufficient to identify a row, and the outbox id is sufficient for support.

## 5. Recovery procedures

| Situation | Control | Refuses when |
|---|---|---|
| Breaker stuck open after a provider incident | Reset circuit | you confirm against a *different* trip than the current one; a channel is killed; an invocation is open |
| A digest group must not go out | Cancel group | any send evidence exists (attempts, message id, first send, uncertainty) |
| Provider callback cannot be correlated | Resolve / requeue orphan | not quarantined, or the reason class does not match the action |
| Pending rows a boundary permanently excludes | Dispose backlog | the path is inert (nothing there is provably historical) |
| A worker crashed mid-send | *nothing* | by design: the lease ages out, the state machine re-decides, and an ambiguous send finalizes `delivery_unknown` rather than being re-sent |

Every one of them: platform-admin only, a reason of 3–500 characters, one request id per decision
(a retry **replays** rather than deciding twice), inputs frozen on submit, stale-state rejection,
and an immutable audit row. A refused decision is recorded as a rejected attempt — refusals are
evidence too.

## 6. The owner-gated rollout sequence

`scripts/rollout/notif-10cb/run-enablement.sh`, in this order. Every mutating step needs `--yes`
and re-asserts the project ref; the send steps additionally need `--admin-ops-confirmed` and
`--monitor-confirmed`.

| # | Subcommand | What it changes | Gate |
|---|---|---|---|
| 1 | `status` | nothing — reads the job, the engine flags and the counters | — |
| 1b | `assert-inert` | nothing | proves the reviewed job exists, is **inactive**, and no engine is on |
| 2 | *(owner)* wire the liveness monitor and verify it alerts | nothing in this repo | **owner** |
| 3 | `enable-engine` | `digest_engine_enabled` for the cutover event **and** opens `email:digest` in the same transaction | **owner** (`--yes`); prints a boundary request id for ambiguous-failure replay |
| 4 | `smoke-disabled` | one worker invocation with the send switch **off**, through the cron job's own reviewed command | **owner** (`--yes --switch-off-confirmed`); demands exactly `200 {"status":"disabled"}` and zero counter deltas |
| 5 | `preflight` | nothing — the read-only dry run of every activation assertion | — |
| 6 | `canary-invoke` | **the first real send**, bounded by `--max-recipients` (default 1) | **owner** + `--admin-ops-confirmed` + `--monitor-confirmed` |
| 7 | `canary` | reconciles that canary's **actual returned run id** | **owner** + `--admin-ops-confirmed` |
| 8 | `activate` | verifies for that run and **arms the cron**, in one transaction against the locked job row | **owner** + both confirmations; refuses under a kill, an unresolved invocation, a drifted job, in-flight work or a quarantined orphan |
| 9 | `rollback` | clears the event flag and **deactivates** the cron (never unschedules) | **owner** (`--yes --switch-off-confirmed`); the owner sets `DIGEST_SEND_ENABLED=false` first, outside this script |

Both invoking steps print their **invocation request id first**: after an ambiguous failure
(connection lost mid-commit) re-running with `--invocation-request-id=<id>` resumes the *same*
invocation instead of colliding with the single-flight gate. `enable-engine` does the same with
`--boundary-request-id`.

WhatsApp is a **separate owner decision** and cannot proceed without provider readiness, approved
templates, a webhook and proven consent. Until then `whatsapp:instant` stays inert and its worker
returns on its env switch: rows accumulate and are refused, which is the intended state, not a bug.

## 7. Rollback

`rollback` deactivates the cron. It does **not** un-open a delivery path, and nothing can:
a boundary is immutable by design. To stop sends after activation, use the **kill switch** — that
is what it is for. To resume, the owner clears the kill through the runbook; the boundary is
unchanged, so the queue that accumulated during the kill is *not* historical work and will send.
If that is not wanted, dispose of it first.

## 8. Release inertness — what "deployed inert" means here

Deploying this branch changes nothing that sends. Provable, and proven:

* the digest cron is installed **inactive** and every re-point touches only its command;
* `digest_engine_enabled` is false for every event;
* `email:digest` and `whatsapp:instant` are seeded **inert** — their authorities claim, materialize
  and dispatch nothing;
* `email:instant` keeps behaving exactly as before (unbounded boundary);
* `DIGEST_SEND_ENABLED` / `WHATSAPP_SEND_ENABLED` are edge switches this repo does not flip;
* no migration sends anything, and the clone-safety sweep pins that the whole chain is inert.
