# ADR 0008 — v2 notification digest materializer (durable group + frozen manifest) + reconciliation

Status: **Proposed — Rev 4** (addresses the Codex review of Rev 3; still design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert. Four-stage
> plan: 10c-a foundation · 10c-b open_slots→v2 (+ event pre-send policy, enables the first digest event)
> · 10c-c durability closure · 10c-d legacy retirement.

## Rev 4 review-response map

Rev 3 introduced the durable group row; Rev 4 closes the state-machine contradictions it created. The
central addition is a **prepare-before-provider** transition that freezes the exact request, so the
manifest, idempotency key, `first_send_at`, and reservation all exist **before** the HTTP call.

| # | Finding | Rev-4 fix |
|---|---|---|
| 1 | Dispatch identity incomplete/mutable (no destination in key; live flag can move rows) | Snapshot **immutable `delivery_mode`** (`instant\|digest`) + **`destination_fingerprint`** at enqueue; the claim predicate + canonical key use these, never the live event flag (§M1) |
| 2 | `first_send_at` written too late (crash after accept, before result RPC) | New **`prepare_digest_send`** RPC (txn) BEFORE the HTTP request freezes `manifest_hash`, `provider_idempotency_key`, `first_send_at`, and the reservation; group → `sending` (§P) |
| 3 | Revalidation can mutate an "idempotent" request | Validation runs **once, at prepare** (before the first attempt); the manifest is then **frozen**; a later opt-out **stops further retries**, never rewrites the request; explicit definitive-vs-ambiguous transitions (§P, §PS, §T-group) |
| 4 | Ledger "best effort" contradicts "authoritative" | Group/member/reservation/provider + **ledger write commit in ONE RPC transaction**; ledger event idempotency `UNIQUE(digest_group_id, attempt_no, action)`; corrected invariant — a **deferred** group was examined, never claimed (§LEDGER) |
| 5 | Oversize recovery impossible under "never churn" | Pre-send-**only** `split_digest_group` RPC: lock the unsent group, create deterministic child chunks, move members, mark original **`superseded`**, preserve uniqueness; `digest_item_bytes` is **server-verified** (`octet_length`), never caller-supplied (§CH) |
| 6 | Acceptance vs webhook need separate identities | Synchronous **acceptance → the group row** (`provider_message_id` UNIQUE + `first_send_at`); the append-only table holds **callbacks only** (`resend_event_id`); rank `complained > bounced` (§PV) |
| 7 | Counter CAS underspecified | Exact CAS: ensure both bucket rows, lock **hour then day**, verify both caps, then increment both + insert reservations in one txn; release is `reserved→released` decrementing **exactly once**; `CHECK(used>=0)`; retention defined (§CAPS) |
| 8 | ACLs unspecified for new tables/RPCs | Every new table: **RLS on, no policy, REVOKE PUBLIC/anon/authenticated, service-role only**; RPCs `SET search_path`; a migration-wide ACL guard test (§ACL) |
| 9 | Forming scans disabled rows / unbounded txn | Forming **partial index on immutable `delivery_mode='digest'`** (excludes disabled/instant rows); materialization bounded by **members AND chunks**, not only groups (§IX, §M-A) |
| 10 | Quiet-hours uses the wrong clock | Evaluate **`p_now AT TIME ZONE recipient_timezone`** (not the boundary); window `[09:00, 20:00)`; next local 09:00 from `p_now`, DST-aware (§QH) |

Owner params (approved, unchanged): **50 items**, **~90 KB** rendered ceiling, **academy→trainer→Amsterdam** tz.

## Decision

Enqueue snapshots immutable identity; a durable group row carries lifecycle; a **prepare** step freezes
the exact request before the provider call; a same-transaction ledger is the reconciliation authority.

### M1 — immutable snapshot + canonical key (fixes #1)

`enqueue_notification` writes, immutably, per outbox row:
- `delivery_mode text CHECK IN ('instant','digest')` — decided **once** from the event's
  `digest_engine_enabled` **at enqueue** and the resolved frequency. A later flag flip affects **new**
  enqueues only; existing rows keep their mode → "exactly one path" is immutable per row.
- `recipient_key` (`p:/u:/g:`), `digest_frequency`, `group_locale`, `recipient_timezone` (§TZ),
  `digest_boundary_at`, `template_version`, `destination_fingerprint` (normalized-destination sha256 —
  so a contact whose address changes cannot share a group with its old address), and a service-role
  `digest_item` payload with a **server-computed** `digest_item_bytes` (§CH).

```sql
canonical_group_key = jsonb_build_array('v1', channel, recipient_key, destination_fingerprint,
  tenant_academy_profile_id, tenant_trainer_id, event_type, template_key, template_version,
  group_locale, digest_frequency, digest_boundary_at)     -- typed, explicit nulls; no || collapse
group_key_hash = encode(digest(canonical_group_key::text,'sha256'),'hex')   -- index/advisory-lock HINT only
```

`digest_eligible(o) := coalesce(o.delivery_mode = 'digest', false)` — **strict boolean**, purely the
immutable snapshot (no live join). `claim_notification_outbox_batch` gains `AND NOT digest_eligible(o)`;
legacy NULL `delivery_mode` rows are `false` → instant-path (§MIG).

### M2 — durable group row (adds `sending`, `superseded`; fixes #6 identity)

`notification_digest_groups`: as Rev 3 plus — `state ∈
('forming','pending','processing','sending','sent','failed','cancelled','delivery_unknown','superseded')`;
`manifest_hash text`; `provider_idempotency_key text`; `provider_message_id text` with
`UNIQUE(provider_message_id)`; `provider_status text` + `provider_status_rank int`
(none 0 < sent 1 < delivered 2 < bounced 3 < **complained 4**); `first_send_at timestamptz`;
`superseded_by uuid`; `UNIQUE(canonical_group_key, chunk_ordinal)`. Members:
`notification_outbox.digest_group_id → notification_digest_groups(id)`. Every claim/retry/reclaim
`SELECT … FOR UPDATE` this one row.

### Phase A — MATERIALIZE (form groups; idempotent; bounded — fixes #9)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks)`:
select due **ungrouped digest** members via the forming partial index (§IX); per `canonical_group_key`
take `pg_try_advisory_xact_lock(group_key_hash)`, then `INSERT … ON CONFLICT (canonical_group_key,
chunk_ordinal) DO NOTHING` (idempotent allocator); assign members `ORDER BY created_at, id` into chunks
capped by **50 items** and cumulative **server-verified `digest_item_bytes`** under the byte budget;
set `outbox.digest_group_id`, group `item_count`/`total_item_bytes`, `state='pending'`. **Bounded by
`p_max_members` AND `p_max_chunks` per call** — a huge single-recipient audience is chunked across
successive materialize calls (deterministic continuation), never thousands of chunks in one txn.

### Phase B — DISPATCH: claim → prepare → send → record

**Claim** `claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:
one due group via the due-work index (§IX), `FOR UPDATE SKIP LOCKED`; **quiet-hours (§QH) + caps (§CAPS)**
first — if deferred → `state='pending'`, bump `digest_boundary_at`, **no `attempts`**, ledger
`action='deferred'` (examined, not claimed); else `state='processing'`, `attempts++`, `locked_by/at`,
`worker_run_id`, ledger `action='claimed'`; return the member set.

**Prepare (freeze — fixes #2, #3)** `prepare_digest_send(p_run_id, p_worker, p_digest_group_id)` in ONE
txn, only from `processing`: run **pre-send validation once** (§PS) and drop cancelled members; compute
the frozen **`manifest_hash`** (sha256 of the ordered surviving member ids + rendered digest_item set) and
**`provider_idempotency_key = 'digest:v1:'||id||':'||chunk_ordinal`**; set **`first_send_at=now()`**;
**reserve caps** (§CAPS); `state='sending'`; ledger `action='prepared'`. After this, the manifest is
**immutable** — retries re-send the identical frozen request.

**Send:** the worker renders the frozen manifest, **hard-checks `octet_length(html) ≤ 90 KB`** (§CH),
and POSTs to Resend with `provider_idempotency_key`.

**Record** `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class,
p_provider_message_id, p_error, p_max_backoff_minutes)`, ownership-gated (`state='sending' AND
locked_by=p_worker AND worker_run_id=p_run_id`), in ONE txn with the ledger:
- `p_outcome_class='accepted'`: `state='sent'`, `provider_message_id` (UNIQUE), members `sent`,
  reservations `committed`, one `email_delivery_events` row/member (audit), ledger `action='sent'`.
- `p_outcome_class='definitive_failure'` (e.g. 4xx bad request): `state='failed'` (retry with the SAME
  frozen manifest if `attempts<max`, else terminal), reservations `released`, ledger `action='failed'`.
- `p_outcome_class='ambiguous'` (timeout/5xx/network): stays `sending`; a stale reclaim re-sends the
  SAME key (Resend dedups <24h); if `now()-first_send_at > 24h` → `state='delivery_unknown'`,
  reservations stay committed, ledger `action='unknown'`.

**A later opt-out after `sending`** never mutates the frozen manifest; it only prevents future *new*
groups and, for a still-retrying group, flips it to stop retries (terminal `cancelled` is disallowed
once `first_send_at` is set — an ambiguous send may already have delivered).

### CH — chunking, digest_item, size ceiling, oversize split (fixes #5; owner caps)

`digest_item` (service-role only; `public_summary` stays tenant-safe, token-free) = `{v:1, occurred_at,
summary_text, deep_link}`; `digest_item_bytes = octet_length(digest_item::text)` is **generated/verified
server-side** at enqueue, never trusted from the caller. Chunk ≤ **50 items** and cumulative bytes under
a budget leaving headroom below **~90 KB** rendered. **Oversize split** (pre-send only):
`split_digest_group(p_digest_group_id)` — valid only while `state='pending'` (never sent/sending): lock
the group `FOR UPDATE`, create deterministic child chunks (`chunk_ordinal` k+1, k+2 under the same
`canonical_group_key`; `UNIQUE` preserved), move members deterministically, mark the original
`state='superseded'`, `superseded_by`. Safe because no `provider_idempotency_key` was ever used. The
90 KB hard-check at send is the backstop; a trip fails the group for `split` + re-dispatch.

### PV — acceptance vs append-only callbacks (fixes #6)

Synchronous **acceptance** (Resend returns `resend_email_id`, no event id) lands on the **group row**
(`provider_message_id` UNIQUE, `first_send_at`, `provider_status='sent'`). **Callbacks** are append-only:

```sql
CREATE TABLE public.notification_provider_events (
  resend_event_id text PRIMARY KEY,                    -- webhook idempotency
  provider_message_id text NOT NULL,
  digest_group_id uuid REFERENCES notification_digest_groups(id),
  status text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
```

`record_notification_provider_event`: `INSERT … ON CONFLICT (resend_event_id) DO NOTHING`; resolve
`provider_message_id → digest_group_id`; advance the group's **monotonic** rollup only (rank above;
complained 4 > bounced 3, so a later complaint updates a bounced group; a stale `sent` never regresses
`delivered`); and **continue calling `record_email_event`** for each member destination so
bounce/complaint suppression (`email_address_state`/`is_email_suppressed`) stays authoritative. Member
timelines resolve delivery via `digest_group_id → rollup`.

### LEDGER + REC — one transaction, event idempotency, honest invariant (fixes #4)

`notification_digest_group_attempts(id, worker_run_id, digest_group_id, attempt_no, action, item_count,
occurred_at, UNIQUE(digest_group_id, attempt_no, action))` — **append-only**, written **in the same
transaction** as every state change (never best-effort). `notification_worker_runs(run_id, worker,
channel, phase, started_at, ended_at)`. `reconcile_notification_digest_run(p_run_id)` reads the ledger
(immutable — a later run's re-claim cannot erase this run's participation) with **dimensionally separate**
counters. Corrected invariants:
- **`groups_examined = groups_claimed + groups_deferred`** (a deferred group was examined, not claimed).
- **`groups_claimed = groups_sent + groups_failed + groups_unknown + groups_still_in_flight`**.
- `items_sent = Σ item_count over sent groups`; `provider_sends = count(distinct provider_message_id)`.
A 50-item email is **1 group / 50 items / 1 provider-send** — never conflated.

### CAPS — exact CAS + release-once + retention (fixes #7)

`notification_send_counters(counter_key text PK, bucket_kind text CHECK IN ('hour','day'), bucket_start
timestamptz, used int NOT NULL DEFAULT 0 CHECK (used >= 0), cap int NOT NULL)`;
`notification_send_reservations(digest_group_id uuid, counter_key text, state text CHECK IN
('reserved','committed','released'), PRIMARY KEY(digest_group_id, counter_key))`. **Acquire (in prepare,
one txn):** ensure both bucket rows (`INSERT … ON CONFLICT DO NOTHING`), `SELECT … FOR UPDATE` **hour
then day** (deterministic → no deadlock), verify `hour.used<hour.cap AND day.used<day.cap`; only if both
hold, `used=used+1` on both **and** insert both reservations `reserved` — else no increment, defer.
**Commit:** `reserved→committed` (no counter change; capacity stays consumed). **Release:**
`reserved→released` **and** `used=used-1` **exactly once**, guarded by the reservation state
(`WHERE state='reserved'`) so a double-release cannot double-decrement. A **crash after acceptance**
leaves reservations `reserved` + group `sending` → the stale-reclaim path resolves the outcome and only
then commits/releases; **capacity is never released by a crash**. Retention: a cleanup deletes counter
rows with `bucket_start < now()-35 days` and terminal reservations older than 35 days.

### PS — generic fail-closed pre-send + event policy hook (fixes #3, #9-scope)

Validation runs **once at prepare**. The generic engine fails closed on: current **preference**
(prefs_v2 off), **contact revoked/replaced** (snapshot destination no longer the current contact),
**destination mismatch**, `is_email_suppressed`. Required-delivery events are exempt from opt-out
cancellation. Event-specific eligibility (e.g. open-slot **"unfollowed"**) is a **versioned per-event
pre-send policy hook** registered by **10c-b**, not in the generic engine. Members failing validation are
dropped from the manifest *before* it freezes; after freeze, nothing changes the manifest.

### QH — quiet hours from `p_now` (fixes #10)

At dispatch, compute local wall-clock `p_now AT TIME ZONE recipient_timezone` (DST-correct). Window
**`[09:00, 20:00)`**. If the local hour is outside it, **defer** to the next local **09:00** computed
**from `p_now`** (so a 19:50 boundary processed at 20:10 defers to tomorrow 09:00). Only when
`event_types.quiet_hours_respect`.

### TZ — precedence (owner-decided)

`recipient_timezone` snapshot: **academy tz (tenant-academy-scoped) → trainer tz → `Europe/Amsterdam`**.
No person-tz until such a column exists.

### MIG — back-compat (fixes #8-strictness)

`delivery_mode` NULL on legacy rows → `digest_eligible=false` → instant-path (strict boolean, no NULL
strand). New columns nullable, no backfill; `digest_engine_enabled` default false; only a **test-fixture**
event enables it. Amended `claim_notification_outbox_batch` predicate is strict-boolean.

### ACL — every new table + RPC (fixes #8)

For **each** of `notification_digest_groups`, `notification_digest_group_attempts`,
`notification_worker_runs`, `notification_provider_events`, `notification_send_counters`,
`notification_send_reservations`: `ENABLE ROW LEVEL SECURITY`; **no policy** (so no anon/authenticated
reach); `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `GRANT … TO service_role` only. Every new RPC:
`SECURITY DEFINER`, `SET search_path = public`, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT …
TO service_role`. A **migration-wide ACL guard test** (the statement-parsing pattern from
`isCycleMemberGuestSafe.pglite.test.ts`) asserts none of these tables/functions is ever granted to
`PUBLIC/anon/authenticated`.

### IX — indexes (fixes #7, #9)

- Forming (immutable digest, ungrouped): `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND digest_group_id IS NULL AND status='pending'`.
- Dispatch due-work (**leads with boundary**): `notification_digest_groups (channel, digest_boundary_at) WHERE state='pending'`.
- Retry: `(channel, next_attempt_at) WHERE state='failed'`. Stale reclaim: `(channel, locked_at) WHERE state IN ('processing','sending')`.
- Member fetch: `notification_outbox (digest_group_id)`. Dedup/hint: `UNIQUE(canonical_group_key, chunk_ordinal)`, `(group_key_hash)`, `UNIQUE(provider_message_id)`.

## State-transition table (group)

| From | Event | To | Same-txn side effects |
|---|---|---|---|
| — | materialize | `forming`→`pending` | members assigned; item_count/bytes set |
| `pending` | claim, in-window, caps ok | `processing` | attempts++, lock, ledger `claimed` |
| `pending` | claim, quiet-hours/cap | `pending` | boundary bumped; **no attempt**; ledger `deferred` (examined) |
| `pending` | oversize | `superseded` | child chunks created; members moved; `superseded_by`; ledger `superseded` |
| `processing` | `prepare_digest_send` | `sending` | validate-once + drop cancelled; freeze manifest/key; `first_send_at`; reserve caps; ledger `prepared` |
| `sending` | record `accepted` | `sent` | provider_message_id; members sent; reservations committed; ledger `sent` |
| `sending` | record `definitive_failure`, attempts<max | `failed` | next_attempt_at; reservations released; ledger `failed` |
| `sending` | record `definitive_failure`, attempts≥max | `failed` (terminal) | reservations released; ledger `failed` |
| `sending` | ambiguous | `sending` | (unchanged; retry same key) |
| `sending` | ambiguous & now-first_send_at>24h | `delivery_unknown` | reservations stay committed; ledger `unknown` |
| `sending`/`processing` | stale `locked_at` | same (reclaim) | re-lock SAME group; same manifest/key |
| `failed` | next_attempt_at≤now | `sending` | re-send SAME frozen manifest; attempts++ |

## Crash-point → single recovery route (all state+ledger writes are one txn — no "best effort")

| Crash point | State left | Single route |
|---|---|---|
| after materialize INSERT, before assign | `forming` | re-materialize: `ON CONFLICT DO NOTHING` resumes (idempotent) |
| after `prepare` (`sending`, first_send_at set, reserved), before HTTP | `sending` | stale-reclaim renders the frozen manifest, sends same key |
| after HTTP accept, before `record` | `sending`, reserved | stale-reclaim re-sends same key (dedup <24h); >24h→`delivery_unknown`; capacity held |
| inside `record` | atomic | txn commits state+members+reservation+provider+ledger together or not at all |
| webhook double-fire | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, `SET search_path=public`, service-role only)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int` ·
`claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes) → TABLE(...)` ·
`prepare_digest_send(p_run_id, p_worker, p_digest_group_id) → TABLE(provider_idempotency_key text, member cols…, outcome text)` ·
`record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_outcome_class text, p_provider_message_id text, p_error text, p_max_backoff_minutes int) → text` ·
`split_digest_group(p_digest_group_id) → int` ·
`record_notification_provider_event(p_resend_event_id, p_provider_message_id, p_status, p_occurred_at) → text` ·
`start_notification_worker_run(p_worker, p_channel, p_phase) → uuid` ·
`reconcile_notification_digest_run(p_run_id) → TABLE(dimension text, metric text, count int)`.
Amended `claim_notification_outbox_batch` (+strict `AND NOT digest_eligible(o)`). Types drift → CI artifact.

## Test plan

Real-Postgres: two-worker concurrency (no split; materialize idempotent); each crash-point row → its
single route (reclaim yields same manifest_hash + provider_idempotency_key, byte-equal); >24h →
`delivery_unknown`; capacity never released by crash. Manifest immutability: an opt-out after `sending`
does not change the rendered bytes; retry re-sends identical. Oversize: `split_digest_group` only
pre-send, deterministic children, uniqueness preserved, original `superseded`. Provider: acceptance on
the group, callbacks append-only + idempotent on `resend_event_id`, complained>bounced, `record_email_event`
still suppresses. Caps: CAS hour-then-day atomic under two workers, release-once, `used>=0`, retention.
Quiet-hours: 19:50 boundary at 20:10 defers to next 09:00 local (DST cases). Ledger: same-txn, dimensional
invariants (`groups_examined=claimed+deferred`, `claimed=sent+failed+unknown+in_flight`). ACL: the
migration-wide guard proves service-role-only. Scale: 100k due digest rows amid a large disabled/instant
population → forming partial index (on `delivery_mode='digest'`) drives selection; `EXPLAIN` on real PG.
Back-compat: legacy NULL-`delivery_mode` rows stay instant-path.

## Alternatives considered

- **Group state on member rows / re-mint on retry (Rev 2/3)** — rejected: durable group + frozen manifest.
- **Set `first_send_at` in the result RPC (Rev 3)** — rejected (#2): the ambiguous window has no timestamp; `prepare` freezes it before the HTTP call.
- **Re-validate at each retry (Rev 3)** — rejected (#3): mutates an idempotent request; validate once at prepare, freeze, opt-out stops retries.
- **One mutable provider row + acceptance in the event table (Rev 3)** — rejected (#6): acceptance has no `resend_event_id`; acceptance→group row, callbacks→append-only.
- **Reservation rows as cap authority (Rev 3)** — rejected (#7): locked counters are the authority; reservations are idempotency records with a release-once guard.
- **Live flag as the path selector** — rejected (#1): immutable `delivery_mode` snapshot; the flag only affects new enqueues.

## Consequences

- The `prepare→send→record` split + frozen manifest is the crux: every crash has one route and no retry
  can diverge the request. It adds one RPC round-trip per group send (acceptable at digest cadence).
- All new tables are service-role-only with a migration-wide ACL guard, matching the default-privilege
  doctrine.
- `reconcile_notification_digest_run` + the same-txn ledger give dimensionally-honest run-level proof.
- Open confirmations for the owner before implementation: the **50 / ~90 KB** caps, the **09:00–20:00**
  window, the **academy→trainer→Amsterdam** precedence, and the retention window (**35 days**) for
  counters/reservations.
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
