# ADR 0008 — v2 notification digest materializer (durable group + request_ready + bounded retry)

Status: **Proposed — Rev 6** (addresses the Codex review of Rev 5; still design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert. Four-stage
> plan: 10c-a foundation · 10c-b open_slots→v2 (+ event pre-send policy, enables the first digest event)
> · 10c-c durability closure · 10c-d legacy retirement.

## Authoritative state flow (Rev 6)

```
pending → leased → prepared → request_ready → sending → terminal
```
- **claim/lease** — quiet-hours only; no caps, no attempts.
- **prepare** — validate members once; if none survive → `no_work`; else freeze the member manifest → `prepared`.
- worker **renders**; oversize → `split_digest_group` (from `pending`/`prepared`, before any send identity).
- **store_digest_request** — server-recompute + validate the exact rendered request; store it → `request_ready`.
- **begin_digest_attempt** (the ONE ownership-gated pre-HTTP RPC, used for attempt 1 **and every retry**):
  recheck stop conditions; acquire-or-reuse hour+day capacity; `attempts++`; append the attempt ledger
  event; enforce backoff + bounds (`attempts<max` **and** within the 24h key window); set `first_send_at`
  if unset → `sending`.
- worker **POSTs** the STORED bytes with the frozen idempotency key.
- **record** — `accepted`→`sent`; `retryable_definite`→`request_ready` (backoff, capacity released);
  `ambiguous`→stays `sending`, reservation **held**, bounded replay; `terminal`→`failed_terminal`.

Cap/quiet-hours deferral **remains `request_ready`** (no re-render, no re-validate). A stale `sending`
is a bounded ambiguous replay of the same bytes/key, never a free re-POST.

## Rev 6 review-response map (retry path)

| # | Finding | Rev-6 fix |
|---|---|---|
| 1 | Normal retry has no legal RPC (`failed→sending` skips ownership/caps/attempts) | Retries go through **`begin_digest_attempt`** (ownership-gated) from **`request_ready`**; no direct edge into `sending` (§P5, §T) |
| 2 | Cap deferral to `pending` destroys the frozen manifest | New durable **`request_ready`** (exact request stored); cap/quiet-hours defer **stays** there; no re-prepare/re-render (§P4, §P5) |
| 3 | Error classification unsafe (5xx treated as clean) | Exact table: **429→retryable_definite (honor Retry-After); 5xx/network/timeout→ambiguous; 401/403/quota→global defer+alert; validation/invalid→terminal; 409 concurrent-idempotent→retry same key** (§ERR) |
| 4 | Opt-out releases capacity for a possibly-accepted email | Opt-out **before any attempt**→`retry_stopped`, capacity not consumed; **after an ambiguous attempt**→`delivery_unknown` reason `opted_out_after_ambiguous_attempt`, capacity **retained** (§P5, §OPT) |
| 5 | Ambiguous retries unbounded (free re-POST, no backoff/attempts) | Every replay runs through `begin_digest_attempt`: `attempts++`, backoff, bounded by `max_attempts` **and** the 24h window; then `delivery_unknown` — never a retry with an expired key (§P5, §BOUND) |
| ic1 | Trusting the supplied hash | `store_digest_request` **recomputes `request_hash` server-side** and validates destination (== group `destination_fingerprint`), schema, and size (§P3) |
| ic2 | Split lacks ownership | `split_digest_group(p_run_id, p_worker, …)` ownership-gated for `leased`/`prepared` (§P-split) |
| ic3 | "Retain request for audit" vs scrub | Scrub `frozen_request` on `sent`/`failed_terminal`/`retry_stopped`/final `delivery_unknown`; **retain `request_hash` + safe metadata** only (§SCRUB) |
| ic4 | Event-vs-group metrics | Reconcile separates **event counts** (ledger rows) from **distinct-group** counts (terminal per group); a deferred-then-sent group doesn't break the equations (§REC) |
| ic5 | Run lifecycle | Add **`finish_notification_worker_run(run_id, status)`** for `succeeded`/`failed`/`abandoned` (§RUN) |
| ic6 | Retention | 35 days (approved) (§CAPS) |

Owner params (approved): **50 items**, **~90 KB** ceiling, **academy→trainer→Amsterdam** tz, **35-day** retention.

## Decision (unchanged foundation; retry path corrected)

M1 snapshot, M2 durable group row, materialize, provider events, ledger, caps table, ACL, indexes, TZ,
quiet-hours, and the catalog constraint `digest_engine_enabled ⇒ supports_digest` are as Rev 5, with the
retry-path corrections below. (Foundation recap: immutable `delivery_mode`/`destination_fingerprint`
snapshot at enqueue; `digest_eligible := coalesce(delivery_mode='digest', false)`; durable
`notification_digest_groups`; `UNIQUE(canonical_group_key, chunk_ordinal)`; all new tables service-role-only
with a migration-wide ACL guard; six service-role tables.)

### States (group)

`forming, pending, leased, prepared, request_ready, sending, sent, failed_terminal, delivery_unknown,
retry_stopped, no_work, superseded`. Retryable failures do **not** get a distinct `failed` state — they
return to `request_ready` with `next_attempt_at` (backoff). Group columns add `frozen_request jsonb`
(scrubbed on terminal), `request_hash text`, `provider_idempotency_key`, `first_send_at`,
`retry_deadline_at timestamptz` (= `first_send_at + 24h - margin`; the key-window bound).

### Phase B — the RPCs

**P1 · claim/lease** `claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:
- Fresh: a `pending` group via the due-work index, `FOR UPDATE SKIP LOCKED`; **quiet-hours only** (§QH) →
  defer stays `pending` (bump boundary, no caps/attempts, ledger `deferred`); else → `leased`, ledger `leased`.
- **Stale reclaim** routes each stale state to its resumable point: stale `leased`→`leased`; stale
  `prepared`→`prepared`; stale `request_ready`→`request_ready`; stale `sending`→ (bounded, §BOUND) if
  `attempts<max AND now<retry_deadline_at` → `request_ready` (ambiguous replay pending), else
  `delivery_unknown`. Re-acquires ownership (`locked_by`, `worker_run_id`).

**P2 · prepare** `prepare_digest_send(p_run_id, p_worker, p_digest_group_id)` (from `leased`, one txn):
validate members **once** (§PS), drop failing; none survive → `no_work` (ledger). Else freeze the member
manifest → `prepared`, ledger `prepared`. No caps/attempts/send-identity.

Worker **renders** the `prepared` manifest; **hard-check `octet_length(html) ≤ 90 KB`**; oversize → **P-split**.

**P-split** `split_digest_group(p_run_id, p_worker, p_digest_group_id)` — **ownership-gated**, valid in
`pending`/`prepared` only: child chunks (`max(chunk_ordinal)+1` under the key advisory lock), move members,
original `superseded`/`superseded_by`, ledger `superseded`.

**P3 · store request** `store_digest_request(p_run_id, p_worker, p_digest_group_id, p_frozen_request jsonb)`
(from `prepared`, one txn, ownership-gated): **recompute `request_hash` server-side** from
`p_frozen_request`; **validate** its destination equals the group `destination_fingerprint`, its schema,
and its size ≤ 90 KB (reject otherwise); store `frozen_request`+`request_hash`; set
`provider_idempotency_key`; → `request_ready`, ledger `request_ready`. Does **not** touch caps/attempts.

**P4/P5 · begin attempt (the one pre-HTTP RPC for attempt 1 and every retry)**
`begin_digest_attempt(p_run_id, p_worker, p_digest_group_id, p_now)`, ownership-gated, valid from
`request_ready`, one txn:
1. **Recheck stop conditions:** if opted-out and `first_send_at IS NULL` → `retry_stopped` (no capacity
   consumed); if opted-out and a prior ambiguous attempt exists → `delivery_unknown`
   (`opted_out_after_ambiguous_attempt`, capacity retained); global auth/config/quota defer flag set →
   stay `request_ready`, bump `next_attempt_at`, no attempt, raise a run alert (§ERR).
2. **Backoff/bounds:** require `p_now ≥ next_attempt_at`; if `attempts ≥ max_attempts` OR
   `first_send_at IS NOT NULL AND p_now ≥ retry_deadline_at` → `delivery_unknown` (never attempt with an
   expiring/expired key).
3. **Capacity:** reserve hour+day (§CAPS) on the FIRST attempt; **reuse** the held reservation on a replay
   (idempotent per `(digest_group_id, counter_key)`). Cap unavailable → stay `request_ready`, bump
   `next_attempt_at`, **no attempt**, ledger `deferred_cap`.
4. `attempts=attempts+1`; append the **attempt ledger event**; set `first_send_at`/`retry_deadline_at` if
   unset; → `sending`, return `provider_idempotency_key`.

Worker **POSTs** the STORED `frozen_request` with the key (re-renders nothing).

**P5 · record** `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class,
p_provider_message_id, p_error, p_retry_after_seconds)`, ownership-gated (`state='sending' AND
locked_by=p_worker AND worker_run_id=p_run_id`), one txn with the ledger (§ERR for the mapping):
- `accepted` → `sent`; `provider_message_id`; members `sent`; reservations `committed`; `email_delivery_events`
  audit rows; **scrub** `frozen_request` (§SCRUB); ledger `sent`.
- `retryable_definite` → `request_ready`; `next_attempt_at = now()+max(p_retry_after_seconds, backoff(attempts))`;
  reservations `released`; ledger `retryable`.
- `terminal` → `failed_terminal`; reservations `released`; **scrub**; ledger `terminal`.
- `ambiguous` → stays `sending` (reservation **held**); the stale-reclaim path (§P1) drives the bounded
  replay; on window/attempt exhaustion → `delivery_unknown` (reservation stays committed; **scrub**).

### ERR — provider outcome classification (fixes #3)

| Provider signal | `p_outcome_class` | Effect |
|---|---|---|
| 2xx accepted | `accepted` | → `sent` |
| **429** (rate/quota) | `retryable_definite` | → `request_ready`, honor `Retry-After` |
| **5xx / network / timeout** | `ambiguous` | stays `sending`, held, bounded replay of the same key |
| **401 / 403 / auth / config / quota-misconfig** | (global defer) | group → `request_ready` (no attempt), **run alert**, worker stops claiming |
| **422 / invalid payload / invalid idempotent request** | `terminal` | → `failed_terminal` |
| **409 concurrent idempotent request** | `retryable_definite` | retry the SAME request/key later |

Rationale: Resend documents 5xx as infrastructure errors and does not guarantee a 5xx means "not
accepted"; idempotency keys exist precisely for server errors/timeouts — so 5xx/network are **ambiguous**,
never assumed-failed.

### OPT / BOUND / SCRUB / REC / RUN

- **OPT:** opt-out before any attempt (`request_ready`, `first_send_at IS NULL`) → `retry_stopped`, no
  capacity consumed. Opt-out after an ambiguous attempt (`first_send_at` set) → `delivery_unknown`
  (`opted_out_after_ambiguous_attempt`), **capacity retained/committed** — the email may already have been
  accepted.
- **BOUND:** every replay increments `attempts`, applies backoff, and stops at `max_attempts` or
  `retry_deadline_at` (24h key window − margin); then `delivery_unknown`, never a same-key retry past the
  provider window.
- **SCRUB:** on `sent`/`failed_terminal`/`retry_stopped`/final `delivery_unknown`, scrub `frozen_request`
  (tokens/PII) per the existing terminal-payload policy; retain `request_hash` + safe metadata
  (recipient_key, item_count, byte size, provider_message_id) for audit.
- **REC:** `reconcile_notification_digest_run(p_run_id)` reports **two families**, never mixed:
  (a) **event counts** from the ledger (leases, deferrals, attempts, sends — a group can appear many times);
  (b) **distinct-group** counts by current terminal state (`sent`, `failed_terminal`, `no_work`,
  `retry_stopped`, `delivery_unknown`, `in_flight`). Group invariant (over distinct groups touched by the
  run): `groups_touched = terminal(sent+failed_terminal+no_work+retry_stopped+delivery_unknown) + in_flight`.
  A deferred-then-sent group counts as many events but exactly one `sent` group.
- **RUN:** `start_notification_worker_run(p_worker, p_channel, p_phase) → run_id`; **`finish_notification_worker_run(p_run_id, p_status)`** with `p_status ∈ ('succeeded','failed','abandoned')` sets `ended_at`; an
  `abandoned` run's in-`sending`/`request_ready` groups are recovered by the next run's stale-reclaim.

### CAPS (acquire in begin_digest_attempt; reuse on replay; release-once; retention)

As Rev 5 but the CAS runs inside **`begin_digest_attempt`** (not a separate step): ensure both bucket
rows, lock **hour then day**, verify both caps, increment both + insert reservations `reserved`. **Replay
reuses** the existing `reserved`/`committed` reservation (idempotent PK `(digest_group_id, counter_key)`) —
no double count. Commit on `accepted`; release-once (`reserved→released`, `used=used-1`, guarded) on
`retryable_definite`/`terminal`/pre-attempt `retry_stopped`. **Never released** on `ambiguous` or
`opted_out_after_ambiguous_attempt`. `CHECK(used>=0)`; **35-day** retention.

## State-transition table (group)

| From | Event | To | Same-txn side effects |
|---|---|---|---|
| — | materialize | `forming`→`pending` | members assigned |
| `pending` | claim, in-window | `leased` | ownership; ledger `leased` |
| `pending` | claim, quiet-hours | `pending` | boundary bumped; no attempt/cap; ledger `deferred` |
| `pending`/`prepared` | split | `superseded` | children (`max(ord)+1`); ledger `superseded` |
| `leased` | prepare, ≥1 survives | `prepared` | member manifest frozen; ledger `prepared` |
| `leased` | prepare, none survive | `no_work` (terminal) | ledger `no_work` |
| `prepared` | store_digest_request | `request_ready` | server-recompute+validate hash; store request; set key; ledger `request_ready` |
| `request_ready` | begin_digest_attempt, ok | `sending` | reserve/reuse caps; `attempts++`; backoff/bounds; first_send_at; ledger `attempt` |
| `request_ready` | begin, cap/global defer | `request_ready` | `next_attempt_at` bumped; **no attempt** (+alert if global) |
| `request_ready` | begin, opt-out, no prior attempt | `retry_stopped` (terminal) | capacity not consumed; ledger |
| `request_ready`/`sending` | attempts≥max or ≥retry_deadline | `delivery_unknown` (terminal) | capacity per OPT/BOUND; scrub; ledger |
| `sending` | record `accepted` | `sent` | provider_message_id; members sent; reservations committed; scrub; ledger `sent` |
| `sending` | record `retryable_definite` | `request_ready` | `next_attempt_at`; reservations released; ledger `retryable` |
| `sending` | record `terminal` | `failed_terminal` | reservations released; scrub; ledger `terminal` |
| `sending` | record `ambiguous` | `sending` | reservation held; awaits bounded replay |
| stale `leased/prepared/request_ready` | reclaim | same | re-own; resume at that step |
| stale `sending`, within bounds | reclaim | `request_ready` | ambiguous replay pending (reservation held) |
| stale `sending`, out of bounds | reclaim | `delivery_unknown` | capacity retained; scrub |

## Crash-point → single recovery route (all state+ledger writes are one txn)

| Crash | State | Route |
|---|---|---|
| after materialize | `forming` | re-materialize (`ON CONFLICT DO NOTHING`) |
| after claim | `leased` | reclaim → prepare |
| after prepare | `prepared` | reclaim → render → (split?) → store_digest_request |
| after store_digest_request | `request_ready` | reclaim → begin_digest_attempt |
| after begin_digest_attempt, before HTTP | `sending` (frozen request+key+first_send_at+reserved, attempts++) | reclaim within bounds → re-POST stored bytes+key; else `delivery_unknown` |
| after HTTP accept, before record | `sending` | reclaim re-POSTs same key (dedup <24h); out of bounds → `delivery_unknown`; capacity held |
| inside any RPC | atomic | all-or-nothing (state+members+reservation+provider+ledger) |
| webhook double-fire | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, `SET search_path=public`, service-role only)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int` ·
`claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes) → TABLE(...)` ·
`prepare_digest_send(p_run_id, p_worker, p_digest_group_id) → TABLE(member…, outcome)` ·
`split_digest_group(p_run_id, p_worker, p_digest_group_id) → int` ·
`store_digest_request(p_run_id, p_worker, p_digest_group_id, p_frozen_request jsonb) → TABLE(request_hash text, outcome text)` ·
`begin_digest_attempt(p_run_id, p_worker, p_digest_group_id, p_now) → TABLE(provider_idempotency_key text, outcome text)` ·
`record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class text, p_provider_message_id text, p_error text, p_retry_after_seconds int) → text` ·
`record_notification_provider_event(p_resend_event_id, p_provider_message_id, p_status, p_occurred_at) → text` ·
`start_notification_worker_run(p_worker, p_channel, p_phase) → uuid` ·
`finish_notification_worker_run(p_run_id, p_status) → void` ·
`reconcile_notification_digest_run(p_run_id) → TABLE(family text, metric text, count int)`.
Amended `claim_notification_outbox_batch` (+ strict `AND NOT digest_eligible(o)`). Types drift → CI artifact.

## Test plan (retry-path emphasis)

Real-Postgres: every crash-point row → its single route; a reclaim from `request_ready`/`sending`
re-POSTs the byte-identical STORED request (hash-equal) with the same key; a template deploy between
attempts does not change sent bytes. **Error mapping:** 429→request_ready+Retry-After; 5xx/network→
ambiguous (held, bounded replay); 401/403/quota→global defer+alert, no attempt; 422→failed_terminal;
409→same-key retry. **Bounds:** ambiguous replays increment attempts + backoff, stop at max_attempts and
at `retry_deadline_at` (24h−margin) → delivery_unknown, never a same-key retry past the window. **Caps:**
reserve on first attempt, **reuse** on replay (no double count); release-once on retryable/terminal/
pre-attempt stop; never released on ambiguous or opted_out_after_ambiguous. **Opt-out:** before attempt →
retry_stopped (no capacity); after ambiguity → delivery_unknown (capacity retained). **store_digest_request**
rejects a request whose destination ≠ group fingerprint, wrong schema, or >90 KB; recomputes hash
server-side. **split** ownership-gated, pre-send only. **Scrub** on all terminals; hash+metadata retained.
**Reconcile** separates event vs distinct-group families; deferred-then-sent = many events / one sent group.
**finish-run** succeeded/failed/abandoned; abandoned recovered by next run. Two-worker concurrency; ACL
guard; catalog `digest_engine_enabled ⇒ supports_digest`; 100k scale on real PG; back-compat instant-path.

## Alternatives considered

- **`begin_digest_send` (Rev 5) doing store+caps+attempts+send in one step** — rejected (#1,#2,#3): a cap/
  quiet-hours defer had to drop to `pending` and re-prepare; split store (P3) from the attempt (P4/P5) with
  a durable `request_ready` between them.
- **`failed→sending` direct edge (Rev 5)** — rejected (#1): retries route through `begin_digest_attempt`.
- **5xx as clean-fail retry (Rev 5)** — rejected (#3): 5xx/network are ambiguous; only 429/409 are
  definite-retryable.
- **Release capacity on any opt-out (Rev 5)** — rejected (#4): a post-ambiguity opt-out retains capacity.
- **Free stale re-POST (Rev 5)** — rejected (#5): every replay is attempt-counted, backed off, and window-bounded.

## Consequences

- The retry path is now a single ownership-gated RPC (`begin_digest_attempt`) fronting every HTTP attempt;
  `attempts` counts real provider attempts; ambiguous replays are bounded by attempts and the 24h key window.
- `request_ready` makes deferral cheap (no re-render/re-validate) and crash-safe.
- Terminal scrub keeps token/PII out of retained rows while `request_hash` + metadata preserve auditability.
- Reconciliation is dimensionally honest (event vs distinct-group families) and survives deferrals.
- Owner confirmations before implementation: **50 / ~90 KB / 09:00–20:00 / academy→trainer→Amsterdam /
  35-day retention / a `retry_deadline` margin** (proposed 1h before the 24h key expiry).
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
