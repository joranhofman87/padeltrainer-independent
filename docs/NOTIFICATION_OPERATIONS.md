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

**No control here resends anything.** No operator, admin surface or API can ask for a re-send,
because provider acceptance can be ambiguous and asking again over an ambiguous send is how you
duplicate one. The complete admin function surface is pinned by a test that also asserts no
function name matches `retry|resend|redeliver`.

That is a statement about CONTROLS, not about the workers. The instant worker retries a row it
already owns — three attempts in-adapter, a backoff requeue, and a stale-lease reclaim — all under
one stable idempotency key, so the provider deduplicates them. The digest worker does not retry an
ambiguous attempt at all. The difference matters when you are reading a row's history, and it is
set out in [`NOTIFICATION_FOUNDATION.md`](NOTIFICATION_FOUNDATION.md) §5.

That is not the same as "every control stops things". Two controls deliberately **restore send
authority**: *reset circuit* closes a breaker (its own schema comment calls it send-enabling), and
*requeue orphan* puts a reconcile back in the queue. Both are gated exactly like the stopping
controls — admin-only, reasoned, request-id idempotent, audited — and neither can produce a *new*
send of an already-attempted message; they let the pipeline resume deciding.

## 2. Stopping a send, right now

**Kill the channel** (`/admin/notifications` → Channels → *Kill*). It takes effect at the claim and
again immediately before every provider call, so rows already claimed are released rather than
sent. It is **immutable evidence**: clearing a kill is an owner/runbook act, deliberately not an
API path, because un-killing is the same act as deciding to send.

If the digest path is misbehaving but email must keep flowing, prefer the narrower control: the
breaker (`admin_reset_notification_circuit` only *closes* it) and the group cancel
(pre-dispatch only — any send evidence refuses).

### Clearing a kill — the way back

Clearing decides that mail **resumes**, so it is a runbook act with the same weight as activation,
not a page button. **Two steps, and the split is the point.**

```
# 1. look. Changes nothing.
run-enablement.sh clear-kill --preview --channel=email <db_url>
#    → who killed it, why, how long ago, and PENDING=<N>: the mail that resumes the moment it clears

# 2. clear, confirming the number you just read.
run-enablement.sh clear-kill --yes --channel=email \
  --kill-request-id=<the request id OF THE KILL> --expected-pending=<N> \
  --reason="<why it is safe now>" <db_url>
```

The server refuses if the live kill is not the one you named (`rejected_stale_kill` — a different
kill is a different incident) or if the queue has **grown past** the number you were shown
(`rejected_backlog_grew` — look again). A queue that shrank is never a reason to refuse: someone
disposing of mail is good news. Both refusals are recorded as rejected attempts, and the clearing
itself is audited beside the original kill.

The clear prints its own request id first: if it dies **ambiguously** (cleared, connection lost),
re-run with `--clear-request-id=<that id>` and the server replays the recorded verdict instead of
answering "not killed".

**Decide about the backlog between the two steps.** Everything queued while the channel was dead
sends as soon as the kill is gone.

Nothing reachable from the app can remove a kill: the table refuses UPDATE, DELETE and TRUNCATE
from every API path, and only the runbook function may delete — inside a transaction that has
published that exact kill's id. A database **owner** with direct SQL can of course set that
setting themselves; the guard binds code paths and mistakes, not the person who owns the database
(no trigger can bind a superuser).

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

**The admin surface shows the v2 pipeline, not every email this product sends.** Two legacy paths
(`notify-rebook-member-open`, `send-digest-emails`) still send outside it and leave no outbox row —
see [`NOTIFICATION_FOLLOWUPS.md`](NOTIFICATION_FOLLOWUPS.md) FA-2. If a recipient says they got
something the outbox does not show, that is where to look next.

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
| A **digest** worker crashed mid-send | *nothing* | by design: the lease ages out, the state machine re-decides, and an ambiguous send finalizes `delivery_unknown` rather than being re-sent |
| An **instant** worker crashed mid-send | *nothing*, but know what happens | the stale lease is reclaimed after 15 minutes and the row is sent again under the SAME idempotency key — a no-op at the provider inside its 24h window. See the downtime note below |

**After prolonged downtime, read this before you resume.** Nothing in this repository bounds the
*wall-clock* gap between an instant row's attempts: `next_attempt_at` is a not-before condition,
and a worker, cron, project or provider outage simply delays the next claim. If instant rows sat
un-attempted for longer than the provider's deduplication window (Resend: 24h) *after* an attempt
that may have been accepted, resuming can duplicate those specific deliveries. The digest path
cannot do this — it never re-sends an ambiguous attempt.

So after an outage longer than a day, before the worker resumes:

```sql
-- 1. look. Read-only, and it never counts a lease a worker still holds.
select * from admin_stale_outbox_preview('email', 1440);

-- 2. dispose of what is no longer worth sending. Bounded, audited, idempotent;
--    its only write is pending / abandoned-processing → skipped.
select * from admin_dispose_stale_outbox('email', 1440, '<why>', gen_random_uuid(), 500);
```

Both refuse a threshold under 60 minutes — this is an outage tool, not a way to cancel a live
queue — and neither touches a digest member (those belong to the state machine) or a row whose
lease is still current (a worker may be mid-provider-call). There is deliberately no automatic
sweep: "is this message still worth sending a day later" is not a decision code should make.

Every one of them: platform-admin only, a reason of 3–500 characters, one request id per decision
(a retry **replays** rather than deciding twice), inputs frozen on submit, and an immutable audit
row. A refused decision is recorded as a rejected attempt — refusals are evidence too.

**Stale-state rejection is not universal, and the difference matters.** *Reset circuit* and *cancel
group* take the exact state you are confirming against (`state`/`reason`/`tripped_at`, and the
group's state) and refuse if it changed since your screen loaded. *Resolve* and *requeue orphan*
take only the event id: they act on whatever classification the row holds when they lock it, so if
the queue moved under you, the server decides on the NEW classification rather than refusing.
Re-read the row before acting on an orphan.

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
| 9 | `postflight` | nothing — the after-activation proof, re-run as often as you like | — |
| 10 | `stage-event --event=<key>` | one MORE event onto the running path | **owner** + `--admin-ops-confirmed`; refuses unless the path is open, the job is armed, and the pipeline is healthy right now |
| — | `rollback` | clears the event flag and **deactivates** the cron (never unschedules) | **owner** (`--yes --switch-off-confirmed`); the owner sets `DIGEST_SEND_ENABLED=false` first, outside this script |
| — | `clear-kill` | removes exactly the kill you name | **owner**; two steps, see above |
| — | `whatsapp-readiness` | nothing | the **separate** WhatsApp gate; exits `BLOCKED_OWNER_WHATSAPP` until the owner confirms the provider, the templates and the opt-in policy |

**Staging is the point of steps 9–10.** After activation, watch with `postflight
--window-minutes=<your watch window>` before adding the next event. A bad event then costs one
event's worth of mail instead of the whole catalogue's — which is why `stage-event` refuses when
the pipeline is not healthy at that moment rather than merely when it was healthy yesterday.

**Postflight is an alarm, not a report.** Every check raises rather than prints, so it can be
scheduled: it re-proves the no-backlog invariant **from the ledger** (no pre-boundary row was ever
sent, no digest holding one was ever dispatched), that the armed job is still the reviewed one,
that the worker has succeeded inside the window, and that no run, group or orphan is stuck.

**WhatsApp is a separate decision and stays blocked.** `whatsapp-readiness` reports what the
database can prove — that the path is still inert, the channel is not killed, consent exists and
every tenant-scoped consent names its tenant, which events support the channel, and how much
queued mail a boundary would exclude — and then refuses on the three facts no SQL can see: the
provider account, the Meta-approved templates, and that those opt-ins were collected the way the
policy says. Until an owner confirms all three, `BLOCKED_OWNER_WHATSAPP` is the correct answer.

Both invoking steps print their **invocation request id first**: after an ambiguous failure
(connection lost mid-commit) re-running with `--invocation-request-id=<id>` resumes the *same*
invocation instead of colliding with the single-flight gate. `enable-engine` does the same with
`--boundary-request-id`.

`whatsapp:instant` stays inert and its worker returns on its env switch: rows accumulate and are
refused, which is the intended state, not a bug.

## 7. Rollback

`rollback` deactivates the cron. It does **not** un-open a delivery path, and nothing can:
a boundary is immutable by design. To stop sends after activation, use the **kill switch** — that
is what it is for. To resume, the owner runs `clear-kill` (above); the boundary is unchanged, so the queue that
accumulated during the kill is *not* historical work and will send.
If that is not wanted, dispose of it first — see *Clearing a kill* above, which prints the size of
that queue before it commits.

## 8. Release inertness — what "deployed inert" means here

Deploying this branch changes nothing that sends. Provable, and proven:

* the digest cron is installed **inactive** and every re-point touches only its command;
* `digest_engine_enabled` is false for every event;
* `email:digest` and `whatsapp:instant` are seeded **inert** — their authorities claim, materialize
  and dispatch nothing;
* `email:instant` keeps behaving exactly as before (unbounded boundary);
* `DIGEST_SEND_ENABLED` / `WHATSAPP_SEND_ENABLED` are edge switches this repo does not flip;
* no migration sends anything, and the clone-safety sweep pins that the whole chain is inert.
