# ADR 0008 — v2 notification digest materializer (durable group, request_ready, bounded retry)

Status: **Proposed — Rev 7** (self-contained; addresses the Codex review of Rev 6; design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert (no live event
> `digest_engine_enabled`). Four-stage plan: **10c-a** foundation · **10c-b** open_slots→v2 (+ the
> event-specific pre-send policy hook; enables the first real digest event) · **10c-c** durability closure ·
> **10c-d** legacy retirement. This revision is the intended **implementation contract** — self-contained,
> no reference to prior revisions required.

## Rev 7 review-response map

| # | Finding | Fix |
|---|---|---|
| 1 | One DB attempt ≠ one HTTP (the shared `sendResendEmail` loops ≤3 and hides status/name/Retry-After) | **Single-shot digest adapter** `sendResendDigestOnce` (exactly one HTTP), rich result; invariant **HTTP calls == `action='attempt'` ledger rows** (§SEND) |
| 2 | Due `request_ready` has no normal claim; quiet hours not rechecked before send | Normal **due-claim of unlocked `request_ready`** (`next_attempt_at ≤ now`); **clear ownership** when scheduling a retry; **recheck `[09:00,20:00)` in `begin_digest_attempt`** (§P1, §P5) |
| 3 | Global-error path impossible; 429 kinds conflated | Classify by **Resend error name**; add post-HTTP **`global_config`** outcome + a durable **provider circuit breaker**; distinguish `rate_limit_exceeded` from `daily/monthly_quota_exceeded`; record the attempt but **don't burn the row's delivery budget** (§ERR, §CB) |
| 4 | Reservation reuse contradicts release | Each attempt **reuses an active held reservation OR acquires fresh current-bucket reservations**; `concurrent_idempotent_requests` (409) → **ambiguous/held**, not released (§CAPS, §ERR) |
| 5 | Terminal groups don't finalize member rows | **Atomic member-outbox finalization for every terminal** (`sent`/`no_work`/`failed_terminal`/`retry_stopped`/`delivery_unknown`/`superseded`) with reasons (§MEM) |
| 6 | Not self-contained | Full M1/M2/materialize/chunking/provider/ledger/pre-send/QH/TZ/ACL/index restored below |
| 7 | Scrub only removes attachments | Terminal scrub = **`frozen_request = NULL`** + retain only `request_hash` + an explicit safe-metadata allow-list (§SCRUB) |

Owner-approved params: **50 items**, **~90 KB** rendered ceiling, **academy→trainer→Amsterdam** tz,
**35-day** counter/reservation retention, **1 h** retry-deadline margin before Resend's 24 h key expiry.

## Authoritative state flow

```
pending → leased → prepared → request_ready → sending → terminal
```
- **claim** (P1): fresh `pending` (quiet-hours only) OR **due unlocked `request_ready`** (`next_attempt_at ≤ now`); crash reclaim of stale locked rows.
- **prepare** (P2): validate members once; none survive → `no_work`; else freeze member manifest → `prepared`.
- worker **renders**; oversize → **split** (P3, from `pending`/`prepared`).
- **store_digest_request** (P4): server-recompute+validate the exact request; store → `request_ready`.
- **begin_digest_attempt** (P5, the one pre-HTTP RPC for attempt 1 AND every retry): recheck stop
  conditions + quiet hours + circuit breaker; reuse-or-acquire capacity; `attempts++`; append the
  `attempt` ledger event; enforce backoff + bounds → `sending`.
- worker **POSTs** the STORED bytes with the frozen key via the single-shot adapter (exactly one HTTP).
- **record** (P6): `accepted`→`sent`; `retryable_definite`→`request_ready` (release caps, clear ownership,
  backoff); `ambiguous`→stays `sending`, held, bounded replay; `terminal`→`failed_terminal`;
  `global_config`→`request_ready`, refund budget, trip breaker. Member rows finalized atomically (§MEM).

## Data model (self-contained)

### M1 — immutable enqueue snapshot + canonical key

`enqueue_notification` writes, immutably, per `notification_outbox` row:
- **`delivery_mode text CHECK IN ('instant','digest')`** — decided ONCE from the event's
  `digest_engine_enabled` + resolved frequency at enqueue. A later flag flip affects **new** rows only →
  "exactly one path" is per-row immutable.
- `recipient_key` (`p:<person>|u:<user>|g:<guest>`), resolved `digest_frequency` (`daily|weekly` for
  digests), `group_locale`, `recipient_timezone` (§TZ), `digest_boundary_at`, `template_version`,
  **`destination_fingerprint`** (sha256 of the normalized destination), and a **service-role `digest_item`
  jsonb** `{v:1, occurred_at, summary_text, deep_link}` (NOT `public_summary`, which stays tenant-safe and
  token-free) with a **server-computed** `digest_item_bytes = octet_length(digest_item::text)`.
- `canonical_group_key = jsonb_build_array('v1', channel, recipient_key, destination_fingerprint,
  tenant_academy_profile_id, tenant_trainer_id, event_type, template_key, template_version, group_locale,
  digest_frequency, digest_boundary_at)` (typed jsonb, explicit nulls — no `||` NULL-collapse / delimiter
  collision). `group_key_hash = encode(digest(canonical_group_key::text,'sha256'),'hex')` — index +
  advisory-lock **hint** only, never the identity/privacy boundary.
- `digest_eligible(o) := coalesce(o.delivery_mode = 'digest', false)` — **strict boolean**; legacy NULL
  rows are instant-path. `claim_notification_outbox_batch` gains `AND NOT digest_eligible(o)`.

Outbox `status` gains `'delivery_unknown'`; adds `digest_group_id uuid REFERENCES notification_digest_groups(id)`, `skip_reason text`.

### M2 — durable group row + states

```sql
CREATE TABLE public.notification_digest_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_group_key jsonb NOT NULL, group_key_hash text NOT NULL, chunk_ordinal int NOT NULL DEFAULT 0,
  channel text NOT NULL, event_type text NOT NULL, recipient_key text NOT NULL,
  tenant_academy_profile_id uuid, tenant_trainer_id uuid, recipient_timezone text NOT NULL,
  digest_boundary_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'forming' CHECK (state IN
    ('forming','pending','leased','prepared','request_ready','sending',
     'sent','failed_terminal','delivery_unknown','retry_stopped','no_work','superseded')),
  item_count int NOT NULL DEFAULT 0, total_item_bytes int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5, next_attempt_at timestamptz,
  locked_by text, locked_at timestamptz, worker_run_id uuid,
  frozen_request jsonb, request_hash text, provider_idempotency_key text,
  first_send_at timestamptz, retry_deadline_at timestamptz,        -- first_send_at + 24h − 1h margin
  provider_message_id text, provider_status text NOT NULL DEFAULT 'none', provider_status_rank int NOT NULL DEFAULT 0,
  superseded_by uuid, terminal_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id));
```

All claim/prepare/store/attempt/record/reclaim paths `SELECT … FROM notification_digest_groups WHERE
id=… FOR UPDATE` — the row is the single lock + state authority.

## Phase A — MATERIALIZE (idempotent, bounded, continuation)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int`:
select due **ungrouped digest** members via the forming index (§IX); per `canonical_group_key`,
`pg_try_advisory_xact_lock(hashtextextended(group_key_hash,0))`, then create chunks with
`chunk_ordinal = coalesce(max(existing for this key), -1) + 1` **under the lock**, `INSERT … ON CONFLICT
(canonical_group_key, chunk_ordinal) DO NOTHING`. Assign members `ORDER BY created_at, id`, capped by
**50 items** AND cumulative `digest_item_bytes` (headroom below ~90 KB). Set `outbox.digest_group_id`,
group `item_count`/`total_item_bytes`, `state='pending'`. Bounded by **`p_max_members` AND `p_max_chunks`**
per call (a huge audience chunks across successive calls, never one giant txn).

## Phase B — the RPCs

**P1 · claim** `claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:
first check the **circuit breaker** (§CB) — if open and `now < circuit.retry_at`, return `none`. Select ONE
group `FOR UPDATE SKIP LOCKED`, ordered by `digest_boundary_at`, from:
- fresh `pending` (`digest_boundary_at ≤ p_now`) — apply **quiet-hours** (§QH): outside window → stay
  `pending`, bump `digest_boundary_at`, ledger `deferred`; else → `leased`, ledger `leased`.
- **due `request_ready`** (`next_attempt_at ≤ p_now AND locked_by IS NULL`) — a scheduled retry after a
  429/cap defer; → `leased_ready` (owned, ready to attempt). *(No stale wait: retries clear ownership at
  scheduling, §P6, so they are due-claimable.)*
- crash reclaim: stale locked group (`locked_at < p_now - stale`) in `leased|prepared|request_ready|sending`
  → re-owned; a stale `sending` within bounds → `request_ready` (ambiguous replay pending, reservation
  held), out of bounds → `delivery_unknown` (§BOUND).

**P2 · prepare** `prepare_digest_send(p_run_id, p_worker, p_digest_group_id)` (from `leased`, one txn,
ownership-gated): run **pre-send validation once** (§PS), drop failing members. None survive → `no_work`
(members finalized §MEM). Else freeze the member manifest → `prepared`, ledger `prepared`.

Worker **renders** the `prepared` manifest, hard-checks `octet_length(html) ≤ 90 KB`; oversize → P3.

**P3 · split** `split_digest_group(p_run_id, p_worker, p_digest_group_id) → int` — ownership-gated, valid
in `pending|prepared` only: child chunks (`max(chunk_ordinal)+1` under the key lock), move members,
original `superseded`/`superseded_by` (members re-enter via children, §MEM), ledger `superseded`.

**P4 · store request** `store_digest_request(p_run_id, p_worker, p_digest_group_id, p_frozen_request jsonb)
→ TABLE(request_hash text, outcome text)` (from `prepared`, one txn, ownership-gated): **recompute
`request_hash` server-side** from `p_frozen_request`; **validate** its destination == group
`destination_fingerprint`, its schema, and its size ≤ 90 KB (reject → error, no state change); store
`frozen_request`+`request_hash`; set `provider_idempotency_key = 'digest:v1:'||id||':'||chunk_ordinal`;
→ `request_ready`, `next_attempt_at = now()`, ledger `request_ready`.

**P5 · begin attempt** `begin_digest_attempt(p_run_id, p_worker, p_digest_group_id, p_now) →
TABLE(provider_idempotency_key text, outcome text)`, ownership-gated, from `request_ready` (or a stale
`sending` reclaimed to `request_ready`), one txn:
1. **Stop conditions:** opted-out & `first_send_at IS NULL` → `retry_stopped` (members §MEM; no capacity);
   opted-out & prior ambiguous attempt → `delivery_unknown` (`opted_out_after_ambiguous_attempt`, capacity
   retained). **Circuit breaker** open → stay `request_ready`, bump `next_attempt_at` to `circuit.retry_at`,
   clear ownership, no attempt.
2. **Quiet hours (recheck at attempt time, §QH):** `p_now AT TIME ZONE recipient_timezone` outside
   `[09:00,20:00)` → stay `request_ready`, bump `next_attempt_at` to next local 09:00, clear ownership,
   no attempt. *(A retry prepared at 19:59 that fires at 20:01 defers.)*
3. **Backoff/bounds:** require `p_now ≥ next_attempt_at`; if `attempts ≥ max_attempts` OR
   (`first_send_at IS NOT NULL AND p_now ≥ retry_deadline_at`) → `delivery_unknown` (never a same-key retry
   past the window).
4. **Capacity (§CAPS):** **reuse** an active held reservation if present and its buckets are current; else
   **acquire fresh** current hour+day reservations. Unavailable → stay `request_ready`, bump `next_attempt_at`,
   clear ownership, ledger `deferred_cap`, no attempt.
5. `attempts=attempts+1`; append **`attempt`** ledger event; set `first_send_at`/`retry_deadline_at` if
   unset; → `sending`; return the key.

Worker **POSTs** via **`sendResendDigestOnce`** (§SEND) — exactly one HTTP request.

**P6 · record** `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class,
p_provider_message_id, p_resend_error_name, p_retry_after_seconds) → text`, ownership-gated (`state='sending'
AND locked_by=p_worker AND worker_run_id=p_run_id`), one txn with the ledger + member finalization (§MEM):
- `accepted` → `sent`; `provider_message_id`; commit reservations; scrub (§SCRUB); ledger `sent`.
- `retryable_definite` (429 `rate_limit_exceeded`; 409 handled as ambiguous instead) → `request_ready`;
  **release** reservations; `next_attempt_at = now()+max(p_retry_after_seconds, backoff(attempts))`;
  **clear ownership**; ledger `retryable`.
- `ambiguous` (5xx/network/timeout, 409 `concurrent_idempotent_requests`) → stays `sending`; reservation
  **held**; stale-reclaim drives the bounded replay; window/attempt exhaustion → `delivery_unknown`; ledger `ambiguous`.
- `terminal` (validation/invalid payload) → `failed_terminal`; release reservations; scrub; ledger `terminal`.
- `global_config` (401/403 auth, `daily_quota_exceeded`, `monthly_quota_exceeded`, config) → **the attempt
  is recorded** (audit) but **`attempts = attempts - 1`** (refund the delivery budget — not the row's fault);
  release reservations; **trip the circuit breaker** (§CB); → `request_ready` (clear ownership, `next_attempt_at
  = circuit.retry_at`); ledger `global_config`.

### SEND — single-shot adapter (fixes #1)

`sendResendDigestOnce(apiKey, frozen_request, idempotencyKey) → { ok, provider_message_id?, http_status,
resend_error_name?, retry_after_seconds?, ambiguous }` performs **exactly one** HTTP request (no internal
loop; distinct from `_shared/resend-send.ts` `sendResendEmail` which loops ≤3). The worker maps its result
to a `p_outcome_class` via §ERR and calls `record` once. **Invariant (pinned by test):** count of HTTP
requests == count of `action='attempt'` ledger rows for the run.

### ERR — classify by Resend error NAME (fixes #3, #4-409)

| Provider result | class | budget | capacity |
|---|---|---|---|
| 2xx | `accepted` | — | commit |
| 429 `rate_limit_exceeded` | `retryable_definite` (honor Retry-After) | +1 | release |
| 429 `daily_quota_exceeded` / `monthly_quota_exceeded` | `global_config` | refund | release + breaker |
| 401/403 auth, config | `global_config` | refund | release + breaker |
| 5xx / network / timeout | `ambiguous` | +1 | held |
| 409 `concurrent_idempotent_requests` | `ambiguous` (original may still complete) | +1 | held |
| 422 / validation / invalid payload / invalid idempotent request | `terminal` | +1 | release |

### CB — provider circuit breaker (fixes #3)

`notification_provider_circuit(channel text PRIMARY KEY, state text CHECK IN ('closed','open'), reason text,
tripped_at timestamptz, retry_at timestamptz)`. `global_config` trips it (`open`, `retry_at = now()+cooldown`);
`claim` returns `none` while open and `now < retry_at`; at `retry_at` it half-opens (one probe group); an
`accepted` closes it. Config failures thus pause the channel instead of hammering, and never consume a
group's delivery budget.

### CAPS — reuse-or-acquire, release-once, retention (fixes #4)

`notification_send_counters(counter_key text PK, bucket_kind text CHECK IN ('hour','day'), bucket_start
timestamptz, used int NOT NULL DEFAULT 0 CHECK (used >= 0), cap int NOT NULL)`;
`notification_send_reservations(digest_group_id uuid, counter_key text, bucket_start timestamptz,
state text CHECK IN ('reserved','committed','released'), PRIMARY KEY(digest_group_id, counter_key))`.
In `begin_digest_attempt`: if the group holds an **active `reserved`** pair whose `bucket_start` matches
the current hour/day → **reuse**; else (post-release, or bucket rolled over) **acquire fresh** — ensure both
current bucket rows (`INSERT … ON CONFLICT DO NOTHING`), `SELECT … FOR UPDATE` **hour then day**
(deterministic), verify `used < cap` on both, then `used=used+1` on both and upsert reservations `reserved`.
**Commit** on `accepted` (`reserved→committed`). **Release-once** on `retryable_definite`/`terminal`/
`global_config`/pre-attempt `retry_stopped` (`reserved→released` AND `used=used-1` guarded `WHERE
state='reserved'`). **Never released** on `ambiguous`/`opted_out_after_ambiguous_attempt`. Retention: purge
counter rows with `bucket_start < now()-35 days` and terminal reservations older than 35 days.

### MEM — atomic member-outbox finalization for every terminal (fixes #5)

Every group terminal transition finalizes its member `notification_outbox` rows **in the same txn** (no
row is left `pending` under a terminal group):

| Group terminal | Member `status` | Member `skip_reason` |
|---|---|---|
| `sent` | `sent` | — |
| `no_work` | `cancelled` | the per-member validation reason (`preference_off`/`suppressed`/`contact_revoked`/`opted_out`) |
| `failed_terminal` | `failed` | `provider_terminal` |
| `retry_stopped` | `cancelled` | `opted_out_before_send` |
| `delivery_unknown` | `delivery_unknown` | reason (`ambiguous_window_expired`/`opted_out_after_ambiguous_attempt`) |
| `superseded` | (moved, `digest_group_id` = child) | not terminal — members continue in the child chunk |

### PV — provider events (append-only) + one suppression call per destination

Synchronous acceptance → the group row (`provider_message_id` UNIQUE, `first_send_at`, `provider_status='sent'`).
Callbacks → `notification_provider_events(resend_event_id text PK, provider_message_id text, digest_group_id
uuid, status text, occurred_at timestamptz, received_at timestamptz DEFAULT now())`, append-only (`ON CONFLICT
(resend_event_id) DO NOTHING`). The webhook advances the group's **monotonic** rollup (none 0 < sent 1 <
delivered 2 < bounced 3 < **complained 4**; a stale `sent` never regresses `delivered`) and calls
**`record_email_event` once per group destination** (a digest is one email to one destination; the webhook
event id is globally idempotent) so bounce/complaint suppression stays authoritative. Member timelines
resolve delivery via `digest_group_id → rollup`.

### LEDGER + REC — durable identity, honest metrics (self-contained)

`notification_digest_group_attempts(event_id uuid PK DEFAULT gen_random_uuid(), seq bigint GENERATED BY
DEFAULT AS IDENTITY, worker_run_id uuid, digest_group_id uuid, attempt_no int, action text, item_count int,
occurred_at timestamptz DEFAULT now())` — append-only, **written in the same transaction as every state
change**; repeated deferrals are distinct events (durable `event_id`/`seq`). `notification_worker_runs(run_id
uuid PK, worker text, channel text, phase text, status text, started_at timestamptz, ended_at timestamptz)`.
`start_notification_worker_run(p_worker, p_channel, p_phase) → run_id`;
**`finish_notification_worker_run(p_run_id, p_status)`** with `p_status ∈ ('succeeded','failed','abandoned')`
sets `ended_at`; an `abandoned` run's in-flight groups are recovered by the next run's reclaim.
`reconcile_notification_digest_run(p_run_id) → TABLE(family text, metric text, count int)` reports **two
families**: **event counts** (ledger rows: leases, deferrals, `attempt` [== HTTP calls], sends) and
**distinct-group** counts by current terminal state. Group invariant (distinct groups touched):
`groups_touched = sent + failed_terminal + no_work + retry_stopped + delivery_unknown + in_flight`. A
deferred-then-sent group = many events / one `sent` group.

### PS — generic fail-closed pre-send (once, at prepare) + event hook

At `prepare`, fail closed on: current **preference** (prefs_v2 off), **contact revoked/replaced**,
**destination mismatch**, `is_email_suppressed`. Required-delivery events are exempt from opt-out drop.
Event-specific eligibility (open-slot **"unfollowed"**) is a **versioned per-event pre-send policy hook**
registered by **10c-b**. Members failing validation are dropped **before** the manifest freezes; none
surviving → `no_work`.

### QH — quiet hours (at claim AND at attempt; fixes #2)

Window **`[09:00, 20:00)`** in `recipient_timezone` (DST-correct via `AT TIME ZONE`). Evaluated at claim
AND **again in `begin_digest_attempt` from `p_now`**; outside → defer to the next local 09:00 computed from
`p_now`. Only when `event_types.quiet_hours_respect`.

### TZ / SCRUB / MIG / ACL / IX

- **TZ:** `recipient_timezone` precedence **academy tz (tenant-academy-scoped) → trainer tz → `Europe/Amsterdam`**; no person tz until such a column exists.
- **SCRUB (fixes #7):** on `sent`/`failed_terminal`/`retry_stopped`/`delivery_unknown` set **`frozen_request = NULL`** (not the attachment-only policy); retain `request_hash` + an explicit safe-metadata allow-list: `recipient_key, item_count, total_item_bytes, provider_message_id, digest_boundary_at, terminal_reason`.
- **MIG:** legacy NULL `delivery_mode` → `digest_eligible=false` (strict) → instant-path; new columns nullable, no backfill. Catalog **`CHECK (NOT digest_engine_enabled OR supports_digest)`** on `notification_event_types` (+ test). Only a **test-fixture** event enables `digest_engine_enabled` — no live synthetic event (a prod diagnostic, if ever, carries `internal boolean` excluded from user-facing catalog queries).
- **ACL:** each of `notification_digest_groups`, `notification_digest_group_attempts`, `notification_worker_runs`, `notification_provider_events`, `notification_provider_circuit`, `notification_send_counters`, `notification_send_reservations`: **RLS on, no policy, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … service_role`**. Every RPC `SECURITY DEFINER`, `SET search_path=public`, service-role only. A **migration-wide ACL guard test** (statement-parsing, per `isCycleMemberGuestSafe.pglite.test.ts`) asserts none is granted to `PUBLIC/anon/authenticated`.
- **IX:** forming `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND digest_group_id IS NULL AND status='pending'`; due-work `notification_digest_groups (channel, digest_boundary_at) WHERE state='pending'`; due-retry `(channel, next_attempt_at) WHERE state='request_ready' AND locked_by IS NULL`; stale `(channel, locked_at) WHERE state IN ('leased','prepared','request_ready','sending')`; member `notification_outbox (digest_group_id)`; dedup `UNIQUE(canonical_group_key, chunk_ordinal)`, `UNIQUE(provider_message_id)`, `(group_key_hash)`.

## Crash-point → single recovery route (all state+ledger+member writes are one txn)

| Crash | State | Route |
|---|---|---|
| after materialize | `forming` | re-materialize (`ON CONFLICT DO NOTHING`) |
| after claim | `leased` | reclaim → prepare |
| after prepare | `prepared` | reclaim → render → (split?) → store_digest_request |
| after store_digest_request | `request_ready` (owned or due) | due/stale claim → begin_digest_attempt |
| after begin_digest_attempt, before HTTP | `sending` (request+key+first_send_at+reserved, attempts++) | reclaim within bounds → re-POST stored bytes+key; else `delivery_unknown` |
| after HTTP accept, before record | `sending` | reclaim re-POSTs same key (dedup <24h); out of bounds → `delivery_unknown`; capacity held |
| inside any RPC | atomic | all-or-nothing (state+members+reservation+provider+ledger) |
| webhook double-fire | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, `SET search_path=public`, service-role only)

`materialize_notification_digest_groups`, `claim_notification_digest_group`, `prepare_digest_send`,
`split_digest_group(p_run_id,p_worker,…)`, `store_digest_request`, `begin_digest_attempt`,
`record_notification_digest_result(…, p_resend_error_name, p_retry_after_seconds)`,
`record_notification_provider_event`, `start_notification_worker_run`, `finish_notification_worker_run`,
`reconcile_notification_digest_run`, and an amended `claim_notification_outbox_batch` (+ strict
`AND NOT digest_eligible(o)`). Types drift → CI artifact.

## Test plan

Real-Postgres: **one HTTP == one `attempt` ledger row** (a mock adapter counts calls); reclaim re-POSTs the
byte-identical STORED request (hash-equal) + same key; a template deploy between attempts changes nothing.
**Due-claim:** a 429/cap-deferred `request_ready` is picked up by the NEXT run's due path at `next_attempt_at`
(not the stale timeout); ownership cleared on scheduling. **Quiet-hours at attempt:** a retry due at 20:01
defers to 09:00. **ERR by name:** rate_limit→retryable+Retry-After; daily/monthly_quota + auth/config→
global_config (attempt recorded, budget refunded, breaker trips, channel pauses); 5xx/network + 409→
ambiguous/held; 422→terminal. **Reservations:** released-then-fresh on retryable; reused on ambiguous; never
released on ambiguous; release-once; `used>=0`; 35-day retention. **Member finalization:** every terminal
sets member status+reason; no member left `pending`; superseded members move to the child. **Bounds:**
attempts++ + backoff; stop at max_attempts and retry_deadline (24h−1h) → delivery_unknown. **Scrub:**
`frozen_request=NULL` on all terminals; hash + allow-list retained. **Store validation:** wrong destination/
schema/>90 KB rejected; hash recomputed server-side. **Provider:** append-only, idempotent on
resend_event_id, complained>bounced, `record_email_event` once per destination. **Reconcile:** event vs
distinct-group families; deferred-then-sent = many events / one sent group. **finish-run** succeeded/failed/
abandoned; abandoned recovered next run. ACL guard; catalog `digest_engine_enabled⇒supports_digest`; 100k
scale amid disabled/instant population on real PG; back-compat instant-path.

## Alternatives considered

- **`sendResendEmail` internal loop for digests** — rejected (#1): breaks one-HTTP-per-attempt + hides
  status/name/Retry-After; a single-shot adapter with a rich result.
- **`request_ready` recovered only by stale reclaim** — rejected (#2): a due-claim on `next_attempt_at`
  avoids waiting the stale timeout after a clean retry/defer; quiet-hours rechecked at attempt time.
- **Classify by HTTP status only; one 429 class** — rejected (#3): Resend names distinguish rate-limit vs
  quota vs auth; a post-HTTP `global_config` + circuit breaker + budget refund.
- **Release on every failure / reuse a released reservation** — rejected (#4): reuse held, else acquire
  fresh; 409 is ambiguous/held.
- **Finalize members only on `accepted`** — rejected (#5): every terminal finalizes members atomically.
- **Attachment-only terminal scrub** — rejected (#7): `frozen_request=NULL` + a metadata allow-list.

## Consequences

- The digest worker uses a single-shot adapter; `attempts`/ledger/HTTP are 1:1:1 per attempt; global
  config failures pause the channel via a breaker without burning a row's budget.
- `request_ready` + a due-claim + attempt-time quiet-hours make retries scheduled, cheap, and window-correct.
- Every terminal atomically finalizes member outbox rows — nothing is stranded.
- Terminal scrub nulls the request bytes; `request_hash` + a metadata allow-list preserve auditability.
- The ADR is now self-contained and intended as the implementation contract.
- Confirmations before implementation (all set per your decisions): **50 / ~90 KB / 09:00–20:00 /
  academy→trainer→Amsterdam / 35-day retention / 1 h retry-deadline margin**; and the circuit-breaker
  **cooldown** (proposed 15 min).
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
