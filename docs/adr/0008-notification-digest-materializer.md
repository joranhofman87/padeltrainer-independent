# ADR 0008 — v2 notification digest materializer (durable group + frozen rendered request) + reconciliation

Status: **Proposed — Rev 5** (addresses the Codex review of Rev 4; still design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert. Four-stage
> plan: 10c-a foundation · 10c-b open_slots→v2 (+ event pre-send policy, enables the first digest event)
> · 10c-c durability closure · 10c-d legacy retirement.

## The send flow (Rev 5 — the one authoritative sequence)

```
materialize → PENDING
claim/lease (quiet-hours only; NO caps, NO attempts)                     → LEASED
prepare      (validate members once; freeze surviving MEMBER manifest)    → PREPARED
worker renders the manifest to the exact provider request
 └─ if octet_length(html) > 90KB: split_digest_group (allowed in PREPARED, no send identity yet)
begin_digest_send (store EXACT rendered request + hash + idempotency key +
                   first_send_at; reserve hour+day caps; attempts++)       → SENDING
worker POSTs the STORED request with the idempotency key
record (outcome ∈ accepted | retryable_definite | terminal | ambiguous)   → terminal/retry
```

Every crash point maps to exactly one state; **`attempts` means an actual provider attempt**; the exact
bytes sent are frozen before `SENDING`, so a code/template deploy cannot change a retry's payload.

## Rev 5 review-response map

| # | Finding | Rev-5 fix |
|---|---|---|
| 1 | `prepare` freezes member/item hashes, but the worker renders HTML afterward → a template deploy changes retry bytes under the same key | **`begin_digest_send` persists the EXACT rendered provider request** (`to/from/subject/html/attachments_version`) + its hash BEFORE `SENDING`; retries re-send the stored bytes; terminal-scrub applies after (§P3, §T) |
| 2 | Oversize check is after `SENDING`, but split only accepts `pending` | New **`PREPARED`** state: validate+freeze members → render → **split from `PREPARED`** (before any send identity) → `begin_digest_send` (§FLOW, §CH) |
| 3 | Caps + `attempts++` at claim, but reservation at prepare → a cap race consumes an attempt with no HTTP | **Claim only leases + quiet-hours.** Caps reservation **and** `attempts++` happen together in **`begin_digest_send`**, immediately before the HTTP attempt (§P1, §P4, §CAPS) |
| 4 | No terminal transitions for 4xx / post-attempt opt-out | Four outcomes **`accepted` / `retryable_definite` / `terminal` / `ambiguous`**; a post-`first_send_at` opt-out → terminal **`retry_stopped`** (frozen request preserved for audit) (§P5, §T) |
| 5 | `UNIQUE(group, attempt_no, action)` collides on repeated deferrals; missing no-work outcome | Ledger rows get a **durable `event_id` + monotonic `seq`** (repeated deferrals are distinct events); reconcile adds **`groups_no_work` / `groups_cancelled` / `groups_retry_stopped`** (§LEDGER) |
| c1 | `record_email_event` per member | **Once per group destination** (a digest is one email to one destination; the webhook event id is globally idempotent) (§PV) |
| c2 | Materialize continuation collides on `chunk_ordinal` | New chunks use **`max(existing chunk_ordinal)+1` under the group-key advisory lock** (§M-A) |
| c3 | `digest_engine_enabled` without `supports_digest` | Catalog CHECK/test **`digest_engine_enabled ⇒ supports_digest`** (§MIG) |
| c4 | Retention | **35 days** for counters/reservations (approved) (§CAPS) |

Owner params (approved): **50 items**, **~90 KB** rendered ceiling, **academy→trainer→Amsterdam** tz.

## Decision

Enqueue snapshots immutable identity; a durable group row carries lifecycle; the exact rendered request
is frozen before `SENDING`; a same-transaction ledger is the reconciliation authority.

### M1 — immutable snapshot + canonical key (unchanged from Rev 4)

`enqueue_notification` writes immutably per row: `delivery_mode ('instant'|'digest')` (decided once from
`digest_engine_enabled` + resolved frequency at enqueue — a later flag flip affects **new** rows only),
`recipient_key` (`p:/u:/g:`), `digest_frequency`, `group_locale`, `recipient_timezone` (§TZ),
`digest_boundary_at`, `template_version`, `destination_fingerprint` (normalized-destination sha256), and a
service-role `digest_item` payload with a **server-computed** `digest_item_bytes` (`octet_length`, never
caller-supplied). `canonical_group_key = jsonb_build_array('v1', channel, recipient_key,
destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, event_type, template_key,
template_version, group_locale, digest_frequency, digest_boundary_at)` (typed, explicit nulls);
`group_key_hash` = its sha256 (index/advisory-lock **hint** only). `digest_eligible(o) :=
coalesce(o.delivery_mode='digest', false)` (strict boolean); `claim_notification_outbox_batch` gains
`AND NOT digest_eligible(o)`.

### M2 — durable group row + states

`notification_digest_groups`: `id` (=digest_group_id), `canonical_group_key jsonb`, `group_key_hash`,
`chunk_ordinal`, denormalized `channel/event_type/recipient_key/tenant_*`, `digest_boundary_at`,
`item_count`, `total_item_bytes`, `attempts`, `max_attempts`, `next_attempt_at`, `locked_by`,
`locked_at`, `worker_run_id`, `first_send_at`, **`frozen_request jsonb`** (the exact provider request;
service-role; scrubbed on terminal), **`request_hash text`**, `provider_idempotency_key text`,
`provider_message_id text UNIQUE`, `provider_status text` + `provider_status_rank int`
(none 0<sent 1<delivered 2<bounced 3<**complained 4**), `superseded_by uuid`, timestamps.

`state ∈ ('forming','pending','leased','prepared','sending','sent','failed','failed_terminal',
'delivery_unknown','retry_stopped','no_work','superseded')`. `UNIQUE(canonical_group_key, chunk_ordinal)`.
Members: `notification_outbox.digest_group_id → notification_digest_groups(id)`. All claim/retry/reclaim
paths `SELECT … FOR UPDATE` this one row.

### M-A — MATERIALIZE (idempotent; bounded; continuation) (fixes c2)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks)`: select
due **ungrouped digest** members via the forming partial index (§IX); per `canonical_group_key`,
`pg_try_advisory_xact_lock(group_key_hash)`, then create chunks with
`chunk_ordinal = coalesce(max(existing chunk_ordinal for this key),-1)+1` **under the lock** (so a later
bounded invocation continues rather than colliding on ordinal 0), `INSERT … ON CONFLICT (canonical_group_key,
chunk_ordinal) DO NOTHING`. Assign members `ORDER BY created_at,id` capped by **50 items** and cumulative
`digest_item_bytes`; set `state='pending'`. Bounded by **`p_max_members` AND `p_max_chunks`** per call.

### Phase B — the send flow RPCs

**P1 · claim (lease only) — `claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:**
one due group via the due-work index, `FOR UPDATE SKIP LOCKED`; apply **quiet-hours** only (§QH) — if
deferred → `state='pending'`, bump `digest_boundary_at`, **no caps, no `attempts`**, ledger `deferred`;
else `state='leased'`, `locked_by/at`, `worker_run_id`, ledger `leased`. Returns the member set.

**P2 · prepare (validate + freeze members) — `prepare_digest_send(p_run_id, p_worker, p_digest_group_id)`:**
from `leased`, in one txn: run **pre-send validation once** (§PS), drop failing members. If **no members
survive** → `state='no_work'`, ledger `no_work`, return. Else freeze the surviving **member manifest**
(ordered ids + their `digest_item`s), `state='prepared'`, ledger `prepared`. No caps, no attempts, no
send identity yet.

**Worker renders** the `prepared` manifest to the exact provider request and **hard-checks
`octet_length(html) ≤ 90 KB`** (§CH).

**P3 · split (oversize, pre-send only) — `split_digest_group(p_digest_group_id)`:** valid only in
`state IN ('pending','prepared')` (never once a send identity exists). Lock `FOR UPDATE`; create
deterministic child chunks (`max(chunk_ordinal)+1` under the key lock), move members, original
`state='superseded'`, `superseded_by`, ledger `superseded`. Children re-enter at `pending`.

**P4 · begin send (freeze exact request + caps + attempts) — `begin_digest_send(p_run_id, p_worker,
p_digest_group_id, p_frozen_request jsonb, p_request_hash text)`:** from `prepared`, in ONE txn: store
`frozen_request` + `request_hash`; set `provider_idempotency_key = 'digest:v1:'||id||':'||chunk_ordinal`
and `first_send_at=now()`; **reserve hour+day capacity** (§CAPS) — if either cap is unavailable →
`state='pending'`, bump `digest_boundary_at`, release any partial reservation, **no `attempts`**, ledger
`deferred_cap`, return `deferred`; else **`attempts=attempts+1`**, `state='sending'`, ledger `sending`.

**Worker POSTs** the STORED `frozen_request` with `provider_idempotency_key` (re-renders nothing on
retry — it re-sends the stored bytes).

**P5 · record (four outcomes) — `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id,
p_outcome_class, p_provider_message_id, p_error, p_max_backoff_minutes)`**, ownership-gated (`state='sending'
AND locked_by=p_worker AND worker_run_id=p_run_id`), one txn with the ledger:
- **`accepted`** → `state='sent'`, `provider_message_id`, members `sent`, reservations `committed`, one
  `email_delivery_events` per member (audit), ledger `sent`. Payload scrub per the existing terminal policy.
- **`retryable_definite`** (429 / clean transient 5xx) → `state='failed'`, `next_attempt_at=now()+backoff`,
  reservations `released`, ledger `failed`; re-send the SAME `frozen_request`/key when due (`attempts<max`).
- **`terminal`** (4xx bad request / non-retryable) → `state='failed_terminal'`, reservations `released`,
  ledger `terminal`. No retry.
- **`ambiguous`** (timeout/network) → stays `sending`; stale-reclaim re-sends the SAME key (Resend dedups
  <24h); if `now()-first_send_at > 24h` → `state='delivery_unknown'`, reservations stay committed, ledger `unknown`.

**Post-attempt opt-out:** once `first_send_at` is set, an opt-out cannot rewrite the frozen request. A
still-retrying group flips to terminal **`retry_stopped`** (reservations released, `frozen_request`
retained for audit, ledger `retry_stopped`) — future retries cease; an already-accepted send is unaffected.

### CH — chunking, digest_item, size ceiling (owner caps; fixes #1/#2 timing)

`digest_item` (service-role; `public_summary` stays tenant-safe) with server-verified `digest_item_bytes`.
Chunk ≤ **50 items** and cumulative bytes under a budget leaving headroom below **~90 KB** rendered. The
90 KB hard-check runs on the **`prepared`** render; a trip → `split_digest_group` (still pre-send) →
re-dispatch. No provider identity exists until `begin_digest_send`, so splitting is always safe.

### PV — acceptance vs append-only callbacks; one suppression call per destination (fixes c1)

Synchronous acceptance → the group row (`provider_message_id` UNIQUE, `first_send_at`, `provider_status='sent'`).
Callbacks → `notification_provider_events(resend_event_id PK, provider_message_id, digest_group_id, status,
occurred_at, received_at)`, append-only (`ON CONFLICT (resend_event_id) DO NOTHING`). The webhook advances
the group's **monotonic** rollup (complained 4 > bounced 3; a stale `sent` never regresses `delivered`) and
calls **`record_email_event` once per group destination** (a digest is one email to one destination; the
webhook event id is globally idempotent) so suppression stays authoritative. Member timelines resolve via
`digest_group_id → rollup`.

### LEDGER + REC — durable event identity, honest invariants (fixes #5)

`notification_digest_group_attempts(event_id uuid PK DEFAULT gen_random_uuid(), seq bigint GENERATED BY
DEFAULT AS IDENTITY, worker_run_id uuid, digest_group_id uuid, attempt_no int, action text, item_count int,
occurred_at timestamptz DEFAULT now())` — **append-only**, one row per state-changing RPC **in the same
transaction** (never best-effort). Repeated deferrals are distinct events (durable `event_id`/`seq`, no
`(group,attempt,action)` uniqueness). `notification_worker_runs(run_id PK, worker, channel, phase,
started_at, ended_at)`. `reconcile_notification_digest_run(p_run_id)` reads the ledger (immutable) with
**dimensionally separate** counters:
- `groups_examined = groups_leased + groups_deferred` (a deferred group was examined, never leased-to-send).
- `groups_terminal = groups_sent + groups_failed_terminal + groups_no_work + groups_retry_stopped + groups_unknown`.
- `groups_in_flight` = leased/prepared/sending/failed-awaiting-retry.
- `items_sent = Σ item_count over sent groups`; `provider_sends = count(distinct provider_message_id)`.
A 50-item email = **1 group / 50 items / 1 provider-send**, never conflated.

### CAPS — CAS in `begin_digest_send`, release-once, retention (fixes #3, #7; c4)

`notification_send_counters(counter_key PK, bucket_kind CHECK('hour','day'), bucket_start, used int CHECK(used>=0),
cap int)`; `notification_send_reservations(digest_group_id, counter_key, state CHECK('reserved','committed','released'),
PRIMARY KEY(digest_group_id,counter_key))`. In `begin_digest_send` (one txn): ensure both bucket rows
(`INSERT … ON CONFLICT DO NOTHING`), `SELECT … FOR UPDATE` **hour then day** (deterministic), verify
`hour.used<cap AND day.used<cap`; only if both hold, `used=used+1` on both **and** insert both reservations
`reserved` — else defer (no increment, no attempt). **Commit** (`reserved→committed`, no counter change).
**Release** (`reserved→released` **and** `used=used-1` **exactly once**, `WHERE state='reserved'`). A crash
after acceptance leaves reservations `reserved`, group `sending` → stale-reclaim resolves then commits/releases;
capacity never released by a crash. **Retention: 35 days** for counter rows and terminal reservations.

### PS — generic fail-closed validation (once, at prepare) + event hook

At `prepare`, fail closed on: current **preference** (prefs_v2 off), **contact revoked/replaced**,
**destination mismatch**, `is_email_suppressed`. Required-delivery events are exempt from opt-out drop.
Event-specific eligibility (open-slot **"unfollowed"**) is a **versioned per-event pre-send policy hook**
registered by **10c-b**. Members failing validation are dropped **before** the manifest freezes; if none
survive → `no_work`. After freeze, nothing mutates the manifest.

### QH — quiet hours from `p_now` (fixes #10 from Rev 4)

At claim, local wall-clock `p_now AT TIME ZONE recipient_timezone` (DST-correct); window `[09:00, 20:00)`;
if outside, defer to the next local **09:00** computed **from `p_now`** (a 19:50 boundary processed at 20:10
defers to tomorrow 09:00). Only when `event_types.quiet_hours_respect`.

### TZ / MIG / ACL / IX

- **TZ:** `recipient_timezone` precedence academy → trainer → `Europe/Amsterdam` (no person tz yet).
- **MIG:** legacy NULL `delivery_mode` → `digest_eligible=false` → instant-path; new columns nullable, no
  backfill. Catalog constraint **`CHECK (NOT digest_engine_enabled OR supports_digest)`** on
  `notification_event_types` (+ a test); only a test-fixture event enables `digest_engine_enabled` (§C10).
- **ACL:** each of `notification_digest_groups`, `notification_digest_group_attempts`, `notification_worker_runs`,
  `notification_provider_events`, `notification_send_counters`, `notification_send_reservations` → **RLS on,
  no policy, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … service_role`**. All RPCs `SECURITY DEFINER`,
  `SET search_path=public`, service-role only. A **migration-wide ACL guard test** (the statement-parsing
  pattern from `isCycleMemberGuestSafe.pglite.test.ts`) asserts none is ever granted to `PUBLIC/anon/authenticated`.
- **IX:** forming `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND
  digest_group_id IS NULL AND status='pending'`; due-work `notification_digest_groups (channel, digest_boundary_at)
  WHERE state='pending'`; retry `(channel, next_attempt_at) WHERE state='failed'`; stale `(channel, locked_at)
  WHERE state IN ('leased','prepared','sending')`; member `notification_outbox (digest_group_id)`; dedup
  `UNIQUE(canonical_group_key, chunk_ordinal)`, `UNIQUE(provider_message_id)`, `(group_key_hash)`.

## State-transition table (group)

| From | Event | To | Same-txn side effects |
|---|---|---|---|
| — | materialize | `forming`→`pending` | members assigned |
| `pending` | claim, in-window | `leased` | lock, worker_run_id, ledger `leased` |
| `pending` | claim, quiet-hours | `pending` | boundary bumped; **no attempt/cap**; ledger `deferred` |
| `pending`/`prepared` | oversize split | `superseded` | children created (`max(ord)+1`); ledger `superseded` |
| `leased` | prepare, ≥1 member survives | `prepared` | member manifest frozen; ledger `prepared` |
| `leased` | prepare, none survive | `no_work` | ledger `no_work` (terminal) |
| `prepared` | begin_digest_send, caps ok | `sending` | store frozen_request + key + first_send_at; reserve caps; **attempts++**; ledger `sending` |
| `prepared` | begin_digest_send, cap full | `pending` | boundary bumped; **no attempt**; ledger `deferred_cap` |
| `sending` | record `accepted` | `sent` | provider_message_id; members sent; reservations committed; ledger `sent` |
| `sending` | record `retryable_definite`, attempts<max | `failed` | next_attempt_at; reservations released; ledger `failed` |
| `sending` | record `retryable_definite`, attempts≥max | `failed_terminal` | reservations released; ledger `terminal` |
| `sending` | record `terminal` | `failed_terminal` | reservations released; ledger `terminal` |
| `sending` | record `ambiguous` | `sending` | unchanged; retry same stored request+key |
| `sending` | ambiguous & now-first_send_at>24h | `delivery_unknown` | reservations committed; ledger `unknown` |
| `sending`/`failed` | opt-out after first_send_at | `retry_stopped` | reservations released; frozen_request retained; ledger `retry_stopped` |
| `failed` | next_attempt_at≤now | `sending` | re-send SAME stored request+key; **attempts++** |
| `leased`/`prepared`/`sending` | stale `locked_at` | same (reclaim) | re-lock SAME group; same manifest/request/key |

## Crash-point → single recovery route (all state+ledger writes are one txn)

| Crash point | State | Single route |
|---|---|---|
| after materialize INSERT | `forming` | re-materialize resumes (`ON CONFLICT DO NOTHING`) |
| after claim | `leased` | stale-reclaim → prepare |
| after prepare | `prepared` | stale-reclaim → render → (split?) → begin_digest_send |
| after begin_digest_send, before HTTP | `sending` (frozen_request + key + first_send_at + reserved) | stale-reclaim re-POSTs the stored request + key |
| after HTTP accept, before record | `sending` | stale-reclaim re-POSTs same key (dedup <24h); >24h→`delivery_unknown`; capacity held |
| inside record | atomic | all-or-nothing (state+members+reservation+provider+ledger) |
| webhook double-fire | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, `SET search_path=public`, service-role only)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int` ·
`claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes) → TABLE(member…, outcome)` ·
`prepare_digest_send(p_run_id, p_worker, p_digest_group_id) → TABLE(member…, outcome)` ·
`split_digest_group(p_digest_group_id) → int` ·
`begin_digest_send(p_run_id, p_worker, p_digest_group_id, p_frozen_request jsonb, p_request_hash text) → TABLE(provider_idempotency_key text, outcome text)` ·
`record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class text, p_provider_message_id text, p_error text, p_max_backoff_minutes int) → text` ·
`record_notification_provider_event(p_resend_event_id, p_provider_message_id, p_status, p_occurred_at) → text` ·
`start_notification_worker_run(p_worker, p_channel, p_phase) → uuid` ·
`reconcile_notification_digest_run(p_run_id) → TABLE(dimension, metric, count)`.
Amended `claim_notification_outbox_batch` (+ strict `AND NOT digest_eligible(o)`). Types drift → CI artifact.

## Test plan

Real-Postgres: two-worker concurrency (no split; materialize idempotent + continuation `max(ord)+1`);
each crash-point row → its single route; a reclaim from `sending` re-POSTs the byte-identical stored
`frozen_request` (hash-equal) with the same key; a template deploy between attempts does NOT change the
sent bytes (they're stored, not re-rendered). Oversize: split only in `pending`/`prepared`; deterministic
children; original `superseded`. Outcomes: `accepted`→sent, `retryable_definite`→failed→retry,
`terminal`→failed_terminal (no retry), `ambiguous`→sending→(>24h) delivery_unknown; post-attempt opt-out→
`retry_stopped`; no-survivor prepare→`no_work`. Caps: CAS + `attempts++` only in `begin_digest_send`; a
cap race never consumes an attempt; release-once; `used>=0`; 35-day retention. Provider: `record_email_event`
once per group destination; append-only + idempotent on `resend_event_id`; complained>bounced. Ledger:
same-txn, repeated deferrals are distinct events, dimensional invariants hold, `no_work`/`retry_stopped`
reconciled. ACL guard proves service-role-only. Catalog: `digest_engine_enabled ⇒ supports_digest`. Scale:
100k due digest rows amid a large disabled/instant population → forming partial index on
`delivery_mode='digest'` drives selection; `EXPLAIN` on real PG. Back-compat: legacy rows stay instant-path.

## Alternatives considered

- **Freeze only member/item hashes (Rev 4)** — rejected (#1): the rendered bytes must be stored, or a
  template deploy diverges a retry; `begin_digest_send` persists the exact request.
- **Caps + attempts at claim (Rev 4)** — rejected (#3): a cap race consumes an attempt with no HTTP;
  both move into `begin_digest_send`, immediately before the attempt.
- **Two states (processing→sending) (Rev 4)** — rejected (#2): oversize split needs a pre-identity state;
  `PREPARED` sits between so split precedes any send identity.
- **Two record outcomes (Rev 4)** — rejected (#4): 4xx must be terminal, and post-attempt opt-out needs a
  named terminal; four outcomes + `retry_stopped`.
- **`UNIQUE(group,attempt,action)` ledger (Rev 4)** — rejected (#5): repeated deferrals collide; durable
  `event_id`/`seq`.

## Consequences

- The flow is `claim/lease → prepare → render → (split?) → begin_digest_send → HTTP → record`; every crash
  has one state, `attempts` = real provider attempts, and retries re-send stored bytes.
- Two extra RPC round-trips per group send (prepare, begin) at digest cadence — acceptable.
- All new tables service-role-only with a migration-wide ACL guard; `record_email_event` keeps digest
  suppression identical to 1:1.
- Owner confirmations before implementation: **50 / ~90 KB / 09:00–20:00 / academy→trainer→Amsterdam /
  35-day retention** — all set per your decisions.
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
