# ADR 0008 — v2 notification digest materializer (durable group, attempt_id, uncertainty-bounded retry)

Status: **Proposed — Rev 8** (self-contained; addresses the Codex review of Rev 7; design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert (no live event
> `digest_engine_enabled`). Four-stage plan: **10c-a** foundation · **10c-b** open_slots→v2 (+ the
> event-specific pre-send policy hook; enables the first real digest event) · **10c-c** durability closure ·
> **10c-d** legacy retirement. This revision is the intended **implementation contract** — self-contained.

## Rev 8 review-response map (distributed-boundary correctness)

| # | Finding | Fix |
|---|---|---|
| 1 | Strict `HTTP == attempt-ledger` is impossible across `fetch` (commit-then-crash) | Durable **`attempt_id`** per authorization; adapter makes **≤1 HTTP per `attempt_id`**; `record` **idempotent by `attempt_id`**; authorized-but-unobserved attempts allowed. **Split counters**: monotonic **`provider_attempts_started`** (audit, never decremented) vs refundable **`delivery_budget_used`** (§SEND, §ATT) |
| 2 | Definite failures age into `delivery_unknown` (deadline from `first_send_at`) | Track **`uncertain_since`**; the 23 h delivery-unknown bound applies **only while acceptance is ambiguous**; a **definite** 429/`global_config`/terminal **clears uncertainty** (§UNC) |
| 3 | `leased_ready` is undefined; clean ambiguous waits for stale reclaim | Due-claim sets ownership on an **owned `request_ready`** (no new state); a **cleanly-recorded ambiguous** result → `request_ready` (clear ownership, `next_attempt_at`, retain reservation + `uncertain_since`) → normally due; **stale reclaim only for process death** (§P1, §P6) |
| 4 | Circuit breaker can't do one half-open probe | States **`closed\|open\|half_open`**; atomic **`open→half_open` CAS** + `probe_locked_by/at` + stale-probe recovery; **reason-aware** retry (auth/config 15 m; daily quota Retry-After/~24 h; monthly quota manual hold) (§CB) |
| 5 | Recipient validation goes stale after `prepare` | **Re-run ALL stop-only checks before every attempt** (preference / current contact / destination / suppression / event policy) without rewriting the frozen request; **finalize `prepare`-rejected members immediately** even in mixed groups (§P5, §MEM) |
| 6 | `counter_key` undefined; member token not scrubbed | `counter_key = channel:event_type:destination_fingerprint:bucket_kind:bucket_start` (per-destination, not per-identity → no shared-mailbox bypass); reservation timestamps; **terminal scrub nulls member `digest_item` token payload** too (§CAPS, §SCRUB) |

Owner-approved params: **50 items**, **~90 KB** ceiling, **academy→trainer→Amsterdam** tz, **35-day**
retention, **1 h** margin (uncertainty deadline = `uncertain_since + 24h − 1h = +23h`), breaker cooldowns
per §CB.

## Authoritative state flow

```
pending → leased → prepared → request_ready ⇄ sending → terminal
```
- **claim** (P1): fresh `pending` (quiet-hours) OR **due owned `request_ready`** (`next_attempt_at ≤ now`,
  unlocked → set ownership, stay `request_ready`); crash reclaim of stale-locked rows.
- **prepare** (P2): validate members once; **finalize rejected members immediately**; ≥1 survivor →
  `prepared`, else `no_work`.
- render → oversize **split** (P3) → **store_digest_request** (P4) → `request_ready`.
- **begin_digest_attempt** (P5): re-run **all** stop-only checks + quiet hours + circuit breaker; reuse/acquire
  capacity; create a durable **`attempt_id`**; `provider_attempts_started++`, `delivery_budget_used++`;
  bound by `delivery_budget_used < max` and (`uncertain_since IS NULL OR now < uncertain_deadline_at`) →
  `sending`.
- worker POSTs the STORED bytes with the frozen key + `attempt_id` via the single-shot adapter (≤1 HTTP).
- **record** (P6, idempotent by `attempt_id`): `accepted`→`sent`; `retryable_definite`→`request_ready`
  (clear uncertainty, release, due); `ambiguous`→`request_ready` (set/keep `uncertain_since`, retain
  reservation, due); `terminal`→`failed_terminal`; `global_config`→`request_ready` (refund budget, trip
  breaker). Members finalized atomically (§MEM).

## Data model (self-contained)

### M1 — immutable enqueue snapshot + canonical key

`enqueue_notification` writes immutably per `notification_outbox` row: **`delivery_mode ('instant'|'digest')`**
(decided once from `digest_engine_enabled` + resolved frequency; later flag flips affect NEW rows only),
`recipient_key` (`p:/u:/g:`), `digest_frequency`, `group_locale`, `recipient_timezone` (§TZ),
`digest_boundary_at`, `template_version`, **`destination_fingerprint`** (sha256 normalized destination), a
**service-role `digest_item` jsonb** `{v:1, occurred_at, summary_text, deep_link}` (NOT `public_summary`)
with server-computed `digest_item_bytes`. `canonical_group_key = jsonb_build_array('v1', channel,
recipient_key, destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, event_type,
template_key, template_version, group_locale, digest_frequency, digest_boundary_at)` (typed, explicit
nulls); `group_key_hash` = its sha256 (index/advisory-lock hint only). `digest_eligible(o) :=
coalesce(o.delivery_mode='digest', false)`; `claim_notification_outbox_batch` gains `AND NOT digest_eligible(o)`.
Outbox `status` gains `'delivery_unknown'`; adds `digest_group_id`, `skip_reason`.

### M2 — durable group row (counters split; uncertainty; attempt_id)

```sql
CREATE TABLE public.notification_digest_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_group_key jsonb NOT NULL, group_key_hash text NOT NULL, chunk_ordinal int NOT NULL DEFAULT 0,
  channel text NOT NULL, event_type text NOT NULL, recipient_key text NOT NULL, destination_fingerprint text NOT NULL,
  tenant_academy_profile_id uuid, tenant_trainer_id uuid, recipient_timezone text NOT NULL,
  digest_boundary_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'forming' CHECK (state IN
    ('forming','pending','leased','prepared','request_ready','sending',
     'sent','failed_terminal','delivery_unknown','retry_stopped','no_work','superseded')),
  item_count int NOT NULL DEFAULT 0, total_item_bytes int NOT NULL DEFAULT 0,
  provider_attempts_started int NOT NULL DEFAULT 0,   -- MONOTONIC audit; never decremented
  delivery_budget_used int NOT NULL DEFAULT 0,        -- refundable; bounded by max_delivery_budget
  max_delivery_budget int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  locked_by text, locked_at timestamptz, worker_run_id uuid,
  attempt_id uuid,                                    -- the current authorized attempt (durable)
  frozen_request jsonb, request_hash text, provider_idempotency_key text,
  first_send_at timestamptz,
  uncertain_since timestamptz, uncertain_deadline_at timestamptz,  -- set on ambiguity; +23h
  provider_message_id text, provider_status text NOT NULL DEFAULT 'none', provider_status_rank int NOT NULL DEFAULT 0,
  superseded_by uuid, terminal_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id));
```

All paths `SELECT … FOR UPDATE` this row.

## Phase A — MATERIALIZE (idempotent, bounded, continuation)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int`:
due ungrouped digest members via the forming index (§IX); per `canonical_group_key`,
`pg_try_advisory_xact_lock(hashtextextended(group_key_hash,0))`; chunk_ordinal =
`coalesce(max(existing for key),-1)+1` under the lock; `INSERT … ON CONFLICT (canonical_group_key,
chunk_ordinal) DO NOTHING`. Assign members `ORDER BY created_at,id` capped by **50 items** + cumulative
`digest_item_bytes`; `state='pending'`. Bounded by **`p_max_members` AND `p_max_chunks`** per call.

## Phase B — the RPCs

**P1 · claim** `claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:
check the **circuit breaker** (§CB) — if not sendable, return `none`. Select ONE group `FOR UPDATE SKIP
LOCKED`, `ORDER BY digest_boundary_at`, from:
- fresh `pending` (`digest_boundary_at ≤ p_now`): quiet-hours (§QH) → defer (stay `pending`, bump boundary,
  ledger `deferred`); else → `leased`, own it, ledger `leased`.
- **due owned `request_ready`** (`next_attempt_at ≤ p_now AND locked_by IS NULL`): set `locked_by`,
  `worker_run_id` — **state stays `request_ready`** (no `leased_ready`).
- **crash reclaim** (process death): stale-locked (`locked_at < p_now − stale`) in
  `leased|prepared|request_ready|sending`. A stale `sending` (record never ran) → treat the unknown
  outcome as ambiguous: set `uncertain_since` if null, → owned `request_ready` (reservation held, due).

**P2 · prepare** `prepare_digest_send(p_run_id, p_worker, p_digest_group_id)` (from `leased`, one txn):
run **pre-send validation** (§PS); **finalize each rejected member immediately** (§MEM) even if others
survive. ≥1 survivor → freeze the surviving member manifest → `prepared`, ledger `prepared`; else →
`no_work`.

Worker **renders**; hard-check `octet_length(html) ≤ 90 KB`; oversize → P3.

**P3 · split** `split_digest_group(p_run_id, p_worker, p_digest_group_id) → int` — ownership-gated, valid
in `pending|prepared`: child chunks (`max(ord)+1` under key lock), move members, original `superseded`, ledger.

**P4 · store request** `store_digest_request(p_run_id, p_worker, p_digest_group_id, p_frozen_request jsonb)
→ TABLE(request_hash, outcome)` (from `prepared`): **recompute `request_hash` server-side**; **validate**
destination == group `destination_fingerprint`, schema, size ≤ 90 KB (reject → error); store
`frozen_request`+`request_hash`; set `provider_idempotency_key`; → `request_ready`, `next_attempt_at=now()`, ledger.

**P5 · begin attempt** `begin_digest_attempt(p_run_id, p_worker, p_digest_group_id, p_now) →
TABLE(attempt_id uuid, provider_idempotency_key text, outcome text)`, ownership-gated, from `request_ready`,
one txn:
1. **Stop-only re-checks (ALL, §PS):** preference off / contact revoked-or-replaced / destination mismatch /
   `is_email_suppressed` / event policy. If a stop holds: `uncertain_since IS NULL` → `retry_stopped`
   (members §MEM, no capacity); else → `delivery_unknown` (retain capacity). No manifest rewrite.
2. **Uncertainty age-out:** `uncertain_since IS NOT NULL AND p_now ≥ uncertain_deadline_at` → `delivery_unknown`.
3. **Circuit breaker** open → stay `request_ready`, `next_attempt_at = circuit.retry_at`, clear ownership.
4. **Quiet hours** (§QH, from `p_now`): outside `[09:00,20:00)` → stay `request_ready`, `next_attempt_at =
   next local 09:00`, clear ownership.
5. **Budget/backoff:** require `p_now ≥ next_attempt_at`; `delivery_budget_used ≥ max_delivery_budget` →
   (`uncertain_since` set → `delivery_unknown`; else `failed_terminal`).
6. **Capacity (§CAPS):** reuse an active held reservation whose buckets are current, else acquire fresh
   current hour+day; unavailable → stay `request_ready`, bump `next_attempt_at`, clear ownership, ledger `deferred_cap`.
7. Create `attempt_id = gen_random_uuid()`; `provider_attempts_started++`; `delivery_budget_used++`; append
   the **`attempt`** ledger event (with `attempt_id`); set `first_send_at` if unset; → `sending`; return `attempt_id`+key.

Worker POSTs via **`sendResendDigestOnce`** (§SEND) — ≤1 HTTP for this `attempt_id`.

**P6 · record** `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_attempt_id,
p_outcome_class, p_provider_message_id, p_resend_error_name, p_retry_after_seconds) → text` —
**idempotent by `p_attempt_id`** (a replay after crash is a no-op if already recorded), ownership-gated
(`state='sending' AND locked_by=p_worker AND worker_run_id=p_run_id AND attempt_id=p_attempt_id`), one txn
with the ledger + members (§MEM). Uncertainty rule: any **definite** outcome sets `uncertain_since=NULL`;
`ambiguous` sets it if null (`uncertain_deadline_at = uncertain_since + 23h`).
- `accepted` → `sent`; `provider_message_id`; commit reservations; scrub (§SCRUB); ledger `sent`.
- `retryable_definite` (429 `rate_limit_exceeded`) → `request_ready`; **clear uncertainty**; release
  reservations; **clear ownership**; `next_attempt_at = now()+max(Retry-After, backoff(delivery_budget_used))`; ledger.
- `ambiguous` (5xx/network/timeout; 409 `concurrent_idempotent_requests`) → `request_ready`; **set/keep
  `uncertain_since`**; **retain** reservation; **clear ownership**; `next_attempt_at = now()+backoff`; ledger.
  (Now normally due; not parked in `sending`.)
- `terminal` (422/validation/invalid) → `failed_terminal`; clear uncertainty; release; scrub; ledger.
- `global_config` (401/403 auth/config; `daily_quota_exceeded`; `monthly_quota_exceeded`) → record the
  attempt (audit); **`delivery_budget_used--`** (refund — not the row's fault); clear uncertainty (definite
  rejection); release reservations; **trip the breaker** (§CB, reason-aware); → `request_ready`, clear
  ownership, `next_attempt_at = circuit.retry_at`; ledger `global_config`.

### SEND / ATT — attempt identity (fixes #1)

`sendResendDigestOnce(apiKey, frozen_request, idempotencyKey, attempt_id) → { ok, provider_message_id?,
http_status, resend_error_name?, retry_after_seconds?, ambiguous }` makes **exactly one** HTTP request for
a given `attempt_id` (no internal loop; distinct from `_shared/resend-send.ts`). Invariants (not strict
equality): **each HTTP call has exactly one preceding authorized `attempt_id`; at most one HTTP per
`attempt_id`; `record` is idempotent by `attempt_id`; an authorized attempt with no observed HTTP (crash)
is permitted** — recovered as ambiguous. `provider_attempts_started` is the monotonic count of authorized
attempts (audit, never decremented); `delivery_budget_used` (refundable) bounds retries via `max_delivery_budget`.

### ERR — classify by Resend error NAME

| Result | class | budget (`delivery_budget_used`) | capacity | uncertainty |
|---|---|---|---|---|
| 2xx | `accepted` | — | commit | clear |
| 429 `rate_limit_exceeded` | `retryable_definite` (Retry-After) | keep (+1 at begin) | release | clear |
| 429 `daily_quota_exceeded`/`monthly_quota_exceeded` | `global_config` | refund | release + breaker | clear |
| 401/403 auth, config | `global_config` | refund | release + breaker | clear |
| 5xx / network / timeout | `ambiguous` | keep | **held** | **set** |
| 409 `concurrent_idempotent_requests` | `ambiguous` | keep | **held** | **set** |
| 422 / validation / invalid | `terminal` | keep | release | clear |

### CB — provider circuit breaker (fixes #4)

`notification_provider_circuit(channel text PRIMARY KEY, state text CHECK IN ('closed','open','half_open'),
reason text, tripped_at timestamptz, retry_at timestamptz, probe_locked_by text, probe_locked_at timestamptz)`.
- **Trip** (`global_config`): `open`, `reason`, reason-aware `retry_at` — **auth/config** `now()+15m`;
  **daily_quota** `now()+coalesce(Retry-After, 24h)`; **monthly_quota** `retry_at=NULL` (manual hold, no auto-probe).
- **Claim gate:** `open` and (`retry_at IS NULL OR now<retry_at`) → not sendable. At `now≥retry_at` a worker
  does an **atomic CAS** `UPDATE … SET state='half_open', probe_locked_by, probe_locked_at WHERE channel=…
  AND state='open' AND now≥retry_at` — exactly one wins and claims **one probe group**.
- **Half-open:** the probe's `accepted` → `closed`; its `global_config` → re-`open` (new `retry_at`). A stale
  `half_open` (`probe_locked_at` old) is re-CAS-able by another worker.

### CAPS — reuse/acquire, release-once, key + retention (fixes #4, #6)

`notification_send_counters(counter_key text PK, bucket_kind text CHECK IN ('hour','day'), bucket_start
timestamptz, used int NOT NULL DEFAULT 0 CHECK(used>=0), cap int NOT NULL)`;
`notification_send_reservations(digest_group_id uuid, counter_key text, bucket_start timestamptz,
state text CHECK IN ('reserved','committed','released'), created_at timestamptz DEFAULT now(),
updated_at timestamptz DEFAULT now(), PRIMARY KEY(digest_group_id, counter_key))`.
**`counter_key = channel || ':' || event_type || ':' || destination_fingerprint || ':' || bucket_kind ||
':' || bucket_start::text`** — per **destination fingerprint** (a shared mailbox can't multiply
identity keys to bypass the cap; caps come from `event_types.max_per_user_per_hour|day`). In
`begin_digest_attempt`: **reuse** an active `reserved` pair whose `bucket_start` is current, else **acquire
fresh** — ensure both rows (`INSERT … ON CONFLICT DO NOTHING`), `SELECT … FOR UPDATE` **hour then day**,
verify `used<cap`, `used=used+1` on both, upsert reservations `reserved`. **Commit** on `accepted`.
**Release-once** on `retryable_definite`/`terminal`/`global_config`/pre-attempt `retry_stopped`
(`reserved→released` AND `used=used-1`, guarded `WHERE state='reserved'`). **Never** on `ambiguous`/
`opted_out_after_ambiguous`. Retention: purge counters `bucket_start<now()-35d` and terminal reservations
`updated_at<now()-35d`.

### MEM — atomic member finalization (fixes #5 mixed groups)

At `prepare`, **each rejected member is finalized immediately** (its own txn segment) even when others
survive. Every group terminal finalizes remaining member rows in the same txn — no member left `pending`:

| Terminal / event | Member `status` | `skip_reason` |
|---|---|---|
| prepare reject (mixed or all) | `cancelled` | `preference_off`/`suppressed`/`contact_revoked`/`destination_mismatch`/`opted_out`/`unfollowed` |
| group `no_work` (all rejected) | (already finalized above) | — |
| `sent` | `sent` | — |
| `failed_terminal` | `failed` | `provider_terminal` |
| `retry_stopped` | `cancelled` | `opted_out_before_send` |
| `delivery_unknown` | `delivery_unknown` | `ambiguous_window_expired`/`opted_out_after_ambiguous_attempt` |
| `superseded` | (moved to child `digest_group_id`) | not terminal |

### PV — provider events (append-only) + one suppression call per destination

Acceptance → group row (`provider_message_id` UNIQUE, `first_send_at`, `provider_status='sent'`).
`notification_provider_events(resend_event_id text PK, provider_message_id text, digest_group_id uuid,
status text, occurred_at timestamptz, received_at timestamptz DEFAULT now())` append-only (`ON CONFLICT
(resend_event_id) DO NOTHING`); the webhook advances the group's monotonic rollup (none<sent<delivered<
bounced<**complained**) and calls **`record_email_event` once per group destination** so suppression stays
authoritative. Member timelines resolve via `digest_group_id → rollup`.

### LEDGER + REC — durable identity, honest metrics

`notification_digest_group_attempts(event_id uuid PK DEFAULT gen_random_uuid(), seq bigint GENERATED BY
DEFAULT AS IDENTITY, worker_run_id uuid, digest_group_id uuid, attempt_id uuid, action text, item_count int,
occurred_at timestamptz DEFAULT now())` — append-only, **same-txn** with every state change; repeated
deferrals are distinct events; `action='attempt'` rows carry the `attempt_id`.
`notification_worker_runs(run_id uuid PK, worker, channel, phase, status, started_at, ended_at)`;
`start_/finish_notification_worker_run` (`finish` status ∈ `succeeded|failed|abandoned`).
`reconcile_notification_digest_run(p_run_id) → TABLE(family, metric, count)`: **event counts** (ledger:
leases, deferrals, authorized attempts [= `provider_attempts_started` deltas], sends) and **distinct-group**
counts by terminal state. Group invariant: `groups_touched = sent + failed_terminal + no_work + retry_stopped
+ delivery_unknown + in_flight`. HTTP calls ≤ authorized attempts (crash gap allowed).

### PS — generic fail-closed checks (at prepare AND re-checked every attempt) + event hook

Stop-only checks: current **preference** (prefs_v2 off), **contact revoked/replaced**, **destination
mismatch**, `is_email_suppressed`, and the **event policy hook** (open-slot "unfollowed", registered by
10c-b). Run at `prepare` (dropping members before freeze) AND **re-run before every attempt** in
`begin_digest_attempt` as whole-group stop conditions (no manifest rewrite). Required-delivery events are
exempt from opt-out.

### QH / TZ / SCRUB / MIG / ACL / IX

- **QH:** window `[09:00,20:00)` in `recipient_timezone` (DST via `AT TIME ZONE`), evaluated at claim AND
  in `begin_digest_attempt` from `p_now`; outside → next local 09:00. Only when `quiet_hours_respect`.
- **TZ:** precedence **academy → trainer → `Europe/Amsterdam`** (no person tz yet).
- **SCRUB (fixes #6):** on `sent`/`failed_terminal`/`retry_stopped`/`delivery_unknown`, set `frozen_request
  = NULL` **and null the token-bearing member `digest_item` payload** (`digest_item.deep_link` and body) for
  each member outbox row; retain `request_hash` + safe-metadata allow-list (`recipient_key, item_count,
  total_item_bytes, provider_message_id, digest_boundary_at, terminal_reason`).
- **MIG:** legacy NULL `delivery_mode` → instant-path (strict boolean). Catalog `CHECK (NOT
  digest_engine_enabled OR supports_digest)`. Engine exercised by test fixtures only.
- **ACL:** each of the 7 new tables (`notification_digest_groups`, `..._group_attempts`, `..._worker_runs`,
  `..._provider_events`, `..._provider_circuit`, `..._send_counters`, `..._send_reservations`): RLS on, no
  policy, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … service_role`. RPCs `SECURITY DEFINER`,
  `SET search_path=public`, service-role only. Migration-wide ACL guard test.
- **IX:** forming `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND
  digest_group_id IS NULL AND status='pending'`; due-work `notification_digest_groups (channel,
  digest_boundary_at) WHERE state='pending'`; due-retry `(channel, next_attempt_at) WHERE state='request_ready'
  AND locked_by IS NULL`; stale `(channel, locked_at) WHERE state IN ('leased','prepared','request_ready','sending')`;
  member `notification_outbox (digest_group_id)`; dedup `UNIQUE(canonical_group_key, chunk_ordinal)`,
  `UNIQUE(provider_message_id)`, `(group_key_hash)`.

## Crash-point → single recovery route (state+ledger+member writes are one txn)

| Crash | State | Route |
|---|---|---|
| after materialize | `forming` | re-materialize (`ON CONFLICT DO NOTHING`) |
| after claim | `leased`/owned `request_ready` | reclaim/due → next step |
| after prepare | `prepared` | reclaim → render → (split?) → store |
| after store | `request_ready` | due/stale claim → begin |
| after begin, before HTTP | `sending` (attempt_id, reserved) | reclaim → ambiguous (uncertain set) → re-POST same key+attempt_id (dedup) |
| after HTTP accept, before record | `sending` | reclaim → re-POST same key (dedup <24h; idempotent record by attempt_id); >23h uncertain → `delivery_unknown`; capacity held |
| inside any RPC | atomic | all-or-nothing |
| webhook double-fire | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, `SET search_path=public`, service-role only)

`materialize_notification_digest_groups`, `claim_notification_digest_group`, `prepare_digest_send`,
`split_digest_group(p_run_id,p_worker,…)`, `store_digest_request`,
`begin_digest_attempt(… ) → (attempt_id, key, outcome)`,
`record_notification_digest_result(…, p_attempt_id, p_outcome_class, p_provider_message_id, p_resend_error_name,
p_retry_after_seconds)` (idempotent by `p_attempt_id`), `record_notification_provider_event`,
`start_/finish_notification_worker_run`, `reconcile_notification_digest_run`, breaker helpers, and amended
`claim_notification_outbox_batch` (+ strict `AND NOT digest_eligible(o)`). Types drift → CI artifact.

## Test plan (distributed-boundary emphasis)

Real-Postgres: **attempt_id** — begin returns it; a crash after begin/before HTTP → reclaim sets uncertain
→ re-POST same attempt_id/key; record idempotent by attempt_id (double record = one effect); HTTP ≤
authorized attempts. **Counters** — `provider_attempts_started` monotonic (never decremented, incl.
global_config); `delivery_budget_used` refunded on global_config; bound uses the budget. **Uncertainty** —
a definite 429/global_config never ages to delivery_unknown; only an ambiguous outcome sets uncertain_since
and ages at +23h. **Due-claim** — clean ambiguous → request_ready (cleared ownership, due at next_attempt_at,
reservation held); stale reclaim only for a killed process. **Breaker** — closed/open/half_open; concurrent
workers → exactly one half-open probe (CAS); stale probe re-claimable; auth 15m, daily Retry-After/24h,
monthly manual hold. **Stop re-checks** — a suppression/opt-out/destination-change after prepare stops the
group at the next attempt (pre-uncertainty → retry_stopped; post-uncertainty → delivery_unknown), no
manifest rewrite. **Mixed prepare** — a rejected member is finalized while survivors send. **Caps** —
counter_key by destination_fingerprint (shared-mailbox no bypass); reuse/acquire; release-once; 35-day
retention. **Scrub** — terminal nulls frozen_request AND member digest_item token payload. **Provider** —
append-only, complained>bounced, `record_email_event` once/destination. **Reconcile** — event vs
distinct-group families. ACL guard; catalog constraint; 100k scale on real PG; back-compat instant-path.

## Alternatives considered

- **Strict HTTP==ledger (Rev 7)** — impossible across `fetch` (#1); attempt_id + idempotent record +
  monotonic/refundable counter split.
- **Deadline from `first_send_at` (Rev 7)** — ages definite failures (#2); `uncertain_since`, cleared by
  any definite outcome.
- **`leased_ready` + ambiguous parked in `sending` (Rev 7)** — undefined state + stale-only recovery (#3);
  owned `request_ready` + clean ambiguous made due.
- **`closed|open` breaker (Rev 7)** — no safe single probe (#4); `half_open` CAS + lease + reason-aware timing.
- **Recheck only opt-out (Rev 7)** — stale contact/suppression (#5); all stop-only checks each attempt.
- **Scrub only `frozen_request` / undefined cap key (Rev 7)** — member token persists + bypassable caps (#6).

## Consequences

- The engine is crash-safe across the provider boundary: an authorized attempt may leave no HTTP call, and
  recovery re-POSTs the same `attempt_id`/key idempotently; the audit counter is honest and monotonic while
  the retry budget is refundable.
- Only genuine ambiguity ages to `delivery_unknown`; definite failures resolve promptly.
- Retries are scheduled/normally-due; stale reclaim is reserved for process death.
- The breaker is concurrency-safe and reason-aware; caps key on the destination; terminal scrub removes all
  token-bearing bytes (group + member).
- Confirmations before implementation (all set per your decisions): 50 / ~90 KB / 09:00–20:00 /
  academy→trainer→Amsterdam / 35-day retention / 23 h uncertainty deadline (24 h − 1 h) / breaker timings
  (auth 15 m, daily Retry-After/24 h, monthly manual).
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
