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

### The external monitor — `notif-liveness` (N7 step 3c)

`notif_digest_worker_liveness()` is `SECURITY DEFINER` and granted to `service_role` **only**, so no
uptime provider can read it directly, and giving one the service-role key would be far worse than the
problem it solves. `notif-liveness` is the surface that closes that gap.

**Why it is genuinely external.** The worker's own Slack alert cannot report that the worker never
ran — a process that does not run sends nothing. Nor can the digest cron (it *is* the thing being
watched), a dashboard nobody opens, or `--monitor-confirmed`, which is an operator's assertion rather
than a detector. The detector must run on different infrastructure, on a different schedule, and
alert through a different channel. This endpoint is the read; the uptime service is the poller; that
service's own notification channel is the alert.

**The status code is the contract**, so any provider works without being taught to parse anything:

| HTTP | state | meaning |
|---|---|---|
| 200 | `live` | armed and succeeded within the threshold |
| 200 | `inert` | cron present and INACTIVE, never run — the current pre-activation state, deliberately not an alert |
| 401 | `unauthorized` | missing/incorrect token (no detail is leaked) |
| 503 | `cron_missing` | the job installed by migration is gone |
| 503 | `never_invoked` | cron ARMED but the worker has never succeeded |
| 503 | `cron_disarmed` | activation is DECLARED and the cron is inactive |
| 503 | `unexpectedly_armed` | the cron is active but activation was never declared — the two have drifted |
| 503 | `stale` | last success older than the threshold (default 900s ≈ 3 missed ticks) |
| 503 | `query_failed` / `misconfigured` | the liveness read itself failed — never reported as healthy |

`inert` returning 200 is deliberate: a monitor that paged through the whole pre-activation period
would be switched off long before it was ever needed.

**`NOTIF_LIVENESS_EXPECT_ARMED` — why the operator states this, rather than the endpoint inferring
it.** The runbook order is 3c wire monitor → **4 canary SUCCEEDS while the cron is still inactive** →
5/6 reconcile and preflight → 7a declare → 7b prove → 7c arm. Between the canary and activation the liveness row reads
`last_success_at != null` **and** `job_active = false` — byte-identical to "a live cron was
disarmed". The six fields cannot tell those apart, and no grace window can, because steps 5 and 6
are owner-paced and open-ended. An endpoint that guessed would page continuously through the exact
window it was wired to watch. So the expectation is an explicit input, flipped at **step 7a** and PROVEN at **7b** before 7c arms anything:

**The flip and the arming cannot be atomic**, so the order is part of the procedure. An Edge
Function secret and a database cron row are changed by different systems; one of the two mismatch
states is unavoidable for a few seconds. Take the one that fails safe:

```bash
# STEP 7a — declare the expectation FIRST. The endpoint then reports cron_disarmed (503), which is
# TRUE: activation is expected and the cron is not yet armed. (The value is literally "true" and is
# not a secret, so it may be set inline — unlike NOTIF_LIVENESS_TOKEN.)
supabase secrets set NOTIF_LIVENESS_EXPECT_ARMED=true --project-ref ficwbdrzefmblkbkomzw

# STEP 7b — PROVE it propagated. Asserts BOTH the status and the state; 503 alone is ambiguous,
# since query_failed, misconfigured and stale share it. Non-zero on any failure.
scripts/rollout/notif-10cb/notif-liveness-secret.sh check-endpoint \
  --url https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notif-liveness \
  --expect-status 503 --expect-state cron_disarmed

# STEP 7c — arm, via the reviewed tooling only. `activate` REFUSES without
# --liveness-expectation-confirmed, so 7a and 7b cannot be skipped by accident.
EXPECTED_REF=ficwbdrzefmblkbkomzw scripts/rollout/notif-10cb/run-enablement.sh activate \
  --yes --monitor-confirmed --liveness-expectation-confirmed --admin-ops-confirmed \
  "$DB_URL" "$CANARY_RUN_ID"
```

Arming first would instead show `unexpectedly_armed` — a live cron that the monitor is not yet
watching for staleness, which is the wrong way round. The documented "alert after 2 consecutive
failures" policy absorbs the short transition either way.

**Rollback must reset it too.** `rollback` disables the engine and leaves the cron inactive; if
`NOTIF_LIVENESS_EXPECT_ARMED` stays `true` the endpoint will correctly but noisily report
`cron_disarmed` for a pipeline that is deliberately down. Reset it as part of the rollback, or put
the check in maintenance for the duration:

```bash
supabase secrets unset NOTIF_LIVENESS_EXPECT_ARMED --project-ref ficwbdrzefmblkbkomzw
```

Before that it is absent/false: an inactive cron is correct, staleness does not apply (nothing is
scheduled), and only `cron_missing`, `unexpectedly_armed` and read failures alert.

**Credentials.** `NOTIF_LIVENESS_TOKEN` — a dedicated secret, **not** the service-role key. An uptime
provider stores whatever you give it and displays it in their UI; if that provider is breached the
blast radius should be "someone can see whether our digest worker ran", not "someone owns the
database". Compared in constant time, and **fails closed**: with no token set the endpoint authorizes
nobody, so a half-finished setup cannot leave an open surface. Optional
`NOTIF_LIVENESS_STALE_SECONDS` overrides the threshold.

**Body is PII-free** — six operational fields plus a verdict; a test asserts the key set and that the
serialized body contains no `@`, `email`, `recipient`, `user_id`, `profile` or `phone`.

### Proving the alert works — the safe rehearsal (runbook step 3c)

**Do not try to prove it with a stale `last_success_at`.** That field is deliberately about a
SUCCEEDED run, so before the first send there is nothing to make stale. An instruction to "verify it
alerts on a stale last_success_at" at step 3c is not merely awkward, it is impossible to satisfy —
and an impossible precondition gets satisfied by ticking the box. Staleness is covered before
activation by this module's own state-machine tests, and can only be observed end-to-end after a
prior successful invocation.

What IS provable now — safely, with the cron still inactive and nothing sent — is the thing that
actually matters: that the provider notices and that recovery clears. Rehearse it:

| | action | required result |
|---|---|---|
| a | confirm the cron is INACTIVE and every engine disabled (`assert-inert` exits 0) | precondition — this rehearsal must never arm anything |
| b | set `NOTIF_LIVENESS_EXPECT_ARMED=true` | — |
| c | poll the deployed endpoint | the exact state `cron_disarmed` with **HTTP 503** |
| d | wait for the uptime service's own confirmation threshold | **the provider alerts through its own channel** |
| e | unset `NOTIF_LIVENESS_EXPECT_ARMED` | — |
| f | poll the endpoint again | the exact state `inert` with **HTTP 200** |
| g | wait | **the provider reports recovery** |

Nothing in this sequence arms the cron, enables an engine, or sends anything: it only changes what
the monitor *expects*, and the endpoint reports the truth about a system that stays inert throughout.
Record the provider's alert and recovery notifications as the step 3c evidence.

**Operating ownership.** The owner wires and owns the uptime check and its alert channel. Wiring it
is runbook step 3c and must happen **before** the canary, so it is watching from the first send.

**Setup:**

```bash
# The credential never appears in argv, history, logs or the terminal — which is why this is a
# script with tests rather than a snippet. See scripts/rollout/notif-10cb/notif-liveness-secret.sh.
scripts/rollout/notif-10cb/notif-liveness-secret.sh provision

# `with-env` materialises a mode-0600 env file, RE-EXTRACTS the value from that finished file and
# proves it byte-for-byte against the Keychain before the command runs, substitutes {} with its
# path, then removes it and verifies its absence on every exit path — including Ctrl-C.
scripts/rollout/notif-10cb/notif-liveness-secret.sh with-env -- \
  supabase secrets set --env-file {} --project-ref ficwbdrzefmblkbkomzw

# The deploy is an ordinary command; it needs no secret.
supabase functions deploy notif-liveness --project-ref ficwbdrzefmblkbkomzw
```

The helper exits non-zero on every failure and **never proceeds past one**: a failed Keychain write
(10), read (11), a readback that is empty / truncated / multiline / hex (12), a value that differs
from what was generated (13), or a `cmp` that could not run (14) all stop before anything is
deployed. An item that already exists is refused with 15, and a lookup that fails for any reason
other than "not found" — a locked keychain, denied access — is refused with 16 **before a token is
generated or anything is written**. `with-env` returns the wrapped command's own status verbatim, so a failed
`secrets set` is reported as that failure and not masked. Cleanup failure is reported honestly and
escalates a success to 90 — it never converts a failure into a success. INT/TERM/HUP clean up and
exit 130/143/129, so Ctrl-C cannot leave the token on disk *or* let the next step run.

**Clipboard: deliberately not used.** Clearing it afterwards does not undo the exposure — a clipboard
manager or Universal Clipboard has already captured the value — and it exists only to serve a paste,
which requires displaying the token. A test asserts `pbcopy` is never invoked.

Point the uptime service at `GET https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notif-liveness`
with header `Authorization: Bearer <token>` (or `x-monitor-token`), interval 5m, alert on any
non-2xx, confirm after 2 consecutive failures. Paste the token into the provider's own secret field;
do not put it in a shell command.

**Verifying the endpoint by hand** — same rule, the token must not reach argv or history:

```bash
scripts/rollout/notif-10cb/notif-liveness-secret.sh check-endpoint \
  --url https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notif-liveness \
  --expect-status 200 --expect-state inert
```

**Requires `jq`**, and checks for it *first* — before the Keychain is read and before any request is
made (33 if absent). The state is then validated **structurally**, not by text matching: the body
must parse as a single JSON object whose `.state` is a string exactly equal to the expectation.
Matching text was fail-open in a way that mattered — an error envelope that merely echoed the
requested state anywhere in the body read as success, so
`{"ok":false,"state":"query_failed","echo":{"state":"cron_disarmed"}}` passed a check for
`cron_disarmed`. It was fail-*closed* in the other direction too: a pretty-printed body, or one
serialized with a space after the colon, failed a perfectly healthy check.

A body containing a **NUL byte** is rejected outright (34): `jq` stops reading at a NUL and ignores
everything after it, so a truncated or proxy-mangled response could otherwise present a healthy
prefix and hide the rest.

The order is transport (30) → HTTP status (31) → body is a single JSON object (34) → `.state` is a
string equal to the expectation (32), so a network failure can never be reported as a wrong state,
and none of them can end in 0. Neither the response body nor `jq`'s stderr is ever printed — the
exit code carries the diagnosis — because the body is PII-free *today* and the check should not
depend on that staying true. It never uses `-f` (which would suppress the very body being checked)
and never `-H` (argv).

**Rotation / revocation.** `notif-liveness-secret.sh provision --force` regenerates and re-proves
the Keychain item; re-run `with-env -- supabase secrets set --env-file {} …` and update the
provider's stored secret. Without `--force` an existing item is never touched: the write is a
**create**, and the keychain itself refuses a duplicate (`errSecDuplicateItem`) with the stored
bytes untouched. That, not the preceding lookup, is what makes it safe — an item created in the
window between the two is refused rather than overwritten. `--force` is the only path that replaces
a value, and it re-proves the round trip byte-for-byte afterwards. To revoke,
`supabase secrets unset NOTIF_LIVENESS_TOKEN` — the endpoint
then fails closed and authorizes nobody, which is the safe direction: the monitor goes dark loudly
rather than the endpoint going open quietly.

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

So after an outage longer than a day, before the worker resumes: open
**`/admin/notifications` → After a long outage**, and

1. **Look.** Choose the channel and the threshold (24h by default — the case this exists for) and
   press *Look*. It reports the pending rows and the **abandoned** leases older than that, and the
   oldest of them. A lease a worker still holds is never counted, because a worker may be
   mid-provider-call.
2. **Dispose of what is no longer worth sending**, with a reason. Bounded to 500 per press,
   audited with the count, and idempotent — the whole decision is fingerprinted, so a retry that
   widens the window is a new decision rather than a replay.

**The disposal acts on the snapshot you were shown, or it refuses.** *Look* returns the exact
`cutoff_at` it measured, and *Dispose* hands that instant and both counts back to the server. It
takes a short table lock, recounts, and applies the change only if the set is byte-for-byte the one
you confirmed; anything else is refused as `rejected_stale_preview`, which names what it found. A
**shrink** is refused too — consent to destroy four rows is not consent to destroy three others.
The first version of this control recomputed `now() − threshold` at act time, so the window slid
forward between reading the number and pressing the button; the confirmation said "these rows" and
meant "whatever matches now". If you get a refusal, press *Look* again and decide on the new
number: that is the control working, not a fault.

Both halves refuse a window inside the last 60 minutes: this is an outage tool, not a way to cancel
a live queue. Neither touches a digest member — those belong to the state machine, and a group that must
not go out is *cancel group* instead. There is deliberately no automatic sweep: "is this message
still worth sending a day later" is not a decision code should make.

(The underlying RPCs are `admin_stale_outbox_preview` and `admin_dispose_stale_outbox`. They are
admin-gated on `auth.uid()`, so the page is the only place they can be run — a psql session carries
no JWT and both will refuse it.)

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
