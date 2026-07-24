# ADR 0008 — v2 notification digest materializer (durable group state) + run-level reconciliation

Status: **Proposed — Rev 3** (addresses the Codex review of Rev 2; still design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. Migrates **no live route** and ships
> **structurally inert**. Four-stage plan: **10c-a** foundation+observability · **10c-b** open_slots→v2
> (adds the event-specific pre-send policy + enables the first real digest event) · **10c-c** durability
> closure · **10c-d** legacy retirement.

## Rev 3 review-response map

Rev 2 stored group state across member rows and defined stability only for stale `processing` reclaim.
Rev 3 makes the **digest group a durable first-class row** (`notification_digest_groups`) that every
fresh claim, ordinary retry, and stale reclaim LOCKS; adds an immutable attempt ledger; keeps provider
events append-only through the existing suppression path; and uses locked counters.

| # | Finding | Rev-3 fix |
|---|---|---|
| 1 | Frozen groups lack durable state; ordinary retries can re-mint `digest_group_id`; no chunk allocator | **`notification_digest_groups`** durable row is the unit of state/lock/chunk-allocation/attempts/backoff/`first_send_at`/provider-id; `UNIQUE(canonical_group_key, chunk_ordinal)` is the allocator; ALL paths `SELECT … FOR UPDATE` this row (§M2, §T-group) |
| 2 | Hash can be NULL/ambiguous | **`canonical_group_key jsonb`** via `jsonb_build_array('v1', … explicit nulls …)`; persisted + `UNIQUE`; `group_key_hash` (sha256 of its text) is only an index/advisory-lock **hint**, never a boundary (§M1) |
| 3 | Chunk sizing doesn't prove the email fits; `public_summary` must not carry tokens | Service-role-only versioned **`digest_item`** payload (NOT `public_summary`) with a stored validated byte size; chunk by cumulative bytes + row count; **hard-check rendered HTML ≤ ceiling before send** (§CH) |
| 4 | One mutable provider row loses history / allows status regression | **`notification_provider_events` append-only** keyed by `resend_event_id`; a separate **monotonic** status rollup on the group; **webhook still calls `record_email_event`** so bounce/complaint suppression stays authoritative (§PV) |
| 5 | Run reconciliation on mutable ownership; dimensional conflation | **Immutable `notification_digest_group_attempts` ledger**; reconciliation reads the ledger; **dimensionally separate counters** (groups / items / provider-sends / member-outcomes) — never conflate (§LEDGER, §REC) |
| 6 | Reservation rows don't make caps atomic | **Locked counter rows** `notification_send_counters` keyed by channel/event/recipient/window; lock **hour then day** in deterministic order; idempotent reservations; capacity **held until reconciled** (§CAPS) |
| 7 | Candidate index has the wrong leading column | Due-work indexes **lead with `digest_boundary_at`** on the groups table; separate member, retry, and stale-reclaim indexes + selection paths; scale test uses **realistic enabled/disabled cardinality** (§IX, §E) |
| 8 | Migration compatibility undefined | `digest_eligible` returns a **strict boolean** (`coalesce(…,false)`); NULL-snapshot legacy rows stay **instant-path**; explicit defaults/backfill/CHECKs (§MIG) |
| 9 | Pre-send validation needs a generic contract | Generic engine fails closed on **current preference / revoked-replaced contact / destination mismatch / `is_email_suppressed`**; event-specific "unfollowed" is a **versioned policy hook** added with open_slots in **10c-b** (§PS) |
| 10 | Synthetic event could leak to settings UI | The engine is exercised by **test fixtures only**; if a prod diagnostic event is ever needed it carries an `internal`/hidden flag excluded from every user-facing catalog query (§C10) |
| tz | Timezone precedence | **academy tz (when academy-scoped) → trainer tz → `Europe/Amsterdam`**; no person-tz claim until that column exists (§TZ) |
| caps | Defaults | **50 items** max, validated service-only item payload, **~90 KB rendered-HTML ceiling**; tune up only from prod measurement (§CH) |
| qh | Quiet hours | Exact window, DST computation, deferral semantics specified (§QH) |

## Context (unchanged)

The v2 worker sends 1:1; the outbox has `collapse_key`/`scheduled_for` but nothing collapses; legacy
collapse lives in `notification_queue`+`send-digest-emails`. 10c-a builds the engine + observability,
inert until 10c-b enables one real event.

## Decision

The digest lifecycle has **two phases** over a **durable group row**, plus an **append-only ledger**.
A row is instant or digest via a strict-boolean predicate; the two never overlap.

### M1 — canonical group key (null-safe) + hash hint

The resolver (`enqueue_notification`) snapshots onto each outbox row (immutable): `recipient_key`
(`p:<person>|u:<user>|g:<guest>`), effective `digest_frequency` (`instant|daily|weekly`, resolved from
prefs_v2 → event default), `group_locale`, `recipient_timezone` (§TZ), `digest_boundary_at`,
`template_version`, and a service-role `digest_item` payload (§CH). The **canonical group key** is
computed null-safely:

```sql
canonical_group_key = jsonb_build_array(
  'v1', channel, recipient_key, contact_id, tenant_academy_profile_id, tenant_trainer_id,
  event_type, template_key, template_version, group_locale, digest_frequency, digest_boundary_at)
-- jsonb encodes NULL explicitly and is typed → no `||` NULL-collapse, no delimiter-collision.
group_key_hash = encode(digest(canonical_group_key::text, 'sha256'), 'hex')  -- INDEX + advisory-lock HINT only
```

Grouping/uniqueness is on `canonical_group_key`; a hash collision is resolved by canonical-key equality.

### M2 — durable group row (fixes #1)

```sql
CREATE TABLE public.notification_digest_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = digest_group_id
  canonical_group_key jsonb NOT NULL,
  group_key_hash     text  NOT NULL,
  chunk_ordinal      int   NOT NULL DEFAULT 0,
  channel            text  NOT NULL,
  event_type         text  NOT NULL,
  recipient_key      text  NOT NULL,
  tenant_academy_profile_id uuid,
  tenant_trainer_id  uuid,
  digest_boundary_at timestamptz NOT NULL,
  state              text  NOT NULL DEFAULT 'forming'
      CHECK (state IN ('forming','pending','processing','sent','failed','cancelled','delivery_unknown')),
  item_count         int   NOT NULL DEFAULT 0,
  total_item_bytes   int   NOT NULL DEFAULT 0,
  attempts           int   NOT NULL DEFAULT 0,
  max_attempts       int   NOT NULL DEFAULT 5,
  next_attempt_at    timestamptz,
  locked_by          text,
  locked_at          timestamptz,
  worker_run_id      uuid,                                          -- CURRENT owner (mutable); the LEDGER is the history
  first_send_at      timestamptz,
  provider_message_id text,                                         -- resend_email_id
  provider_status    text NOT NULL DEFAULT 'none'
      CHECK (provider_status IN ('none','sent','delivered','bounced','complained')),
  provider_status_rank int NOT NULL DEFAULT 0,                      -- monotonic guard (§PV)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group_key_chunk UNIQUE (canonical_group_key, chunk_ordinal)   -- durable allocator
);
```

Members reference the group: `notification_outbox.digest_group_id uuid REFERENCES notification_digest_groups(id)`.
**All** fresh claims, retries, and reclaims operate by `SELECT … FROM notification_digest_groups WHERE id=… FOR UPDATE` — the row is the single lock + state authority, so an ordinary retry re-locks the same group (same `id`, same members, same idempotency key). Members never churn back to `pending` once grouped.

### Phase A — MATERIALIZE (form groups; idempotent)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_groups)`:
1. Select **due, ungrouped** members via the forming index (§IX): `status='pending' AND digest_group_id IS NULL AND digest_eligible(row) AND digest_boundary_at <= p_now`, earliest boundary first.
2. For each distinct `canonical_group_key`: `pg_try_advisory_xact_lock(hashtextextended(group_key_hash,0))` (serialize forming); then `INSERT INTO notification_digest_groups(canonical_group_key, chunk_ordinal, …) VALUES (…, 0) ON CONFLICT (canonical_group_key, chunk_ordinal) DO NOTHING RETURNING id` — the unique constraint makes group+chunk creation **idempotent** and is the durable chunk allocator.
3. Assign members deterministically (`ORDER BY created_at, id`) into chunks capped by **row count (50)** and **cumulative validated `digest_item` bytes** (§CH), creating additional `chunk_ordinal` rows as needed. Set `outbox.digest_group_id`, group `item_count`/`total_item_bytes`, group `state='pending'`.
Late arrivals (`created_at` after this pass, or a later `digest_boundary_at`) form the **next** group in a future window. Materialize is safe to re-run (idempotent on the unique key).

### Phase B — DISPATCH (send groups; retries reuse the durable row)

`claim_notification_digest_group(p_run_id, p_worker, p_channel, p_now, p_stale_after_minutes)`:
1. Select ONE due group via the **due-work index** (§IX, leads with `digest_boundary_at`): a `pending` group with `digest_boundary_at <= p_now`, OR a `failed` group with `next_attempt_at <= p_now`, OR a stale `processing` group (`locked_at < p_now - stale`), `ORDER BY digest_boundary_at` — `FOR UPDATE SKIP LOCKED` on the group row.
2. **Quiet-hours** (§QH) + **caps** (§CAPS): if deferred → set `state='pending'`, bump `digest_boundary_at` to the next allowed boundary, **do not touch `attempts`**, ledger `action='deferred'`, return.
3. Else `state='processing'`, `locked_by`, `locked_at=now()`, `worker_run_id=p_run_id`, `attempts=attempts+1`; append a ledger row (§LEDGER); return the frozen member set (`WHERE digest_group_id = id`) ordered deterministically.

`record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_status, p_provider_message_id, p_error, p_terminal, p_max_backoff_minutes)`:
- Ownership gate: `state='processing' AND locked_by=p_worker AND worker_run_id=p_run_id` else `'stale'`.
- `sent`: group `state='sent'`, members `sent`; set `provider_message_id`, `first_send_at` if null; **commit** the cap reservation (§CAPS); one `email_delivery_events` row per member (audit) linked by `digest_group_id`; ledger `action='sent', items=item_count`.
- `failed`: `state='failed'`, `next_attempt_at = now()+backoff(attempts)`, `attempts` already counted at claim; **release** reservation; ledger `action='failed'`. When `attempts>=max_attempts` → terminal `failed`. When ambiguous and `now()-first_send_at > 24h` → `state='delivery_unknown'` (§DU), reservation stays committed.

### CH — chunking, digest_item, rendered-size ceiling (fixes #3; owner caps)

- **`digest_item`** is a **service-role-only, versioned** payload on the outbox row (never `public_summary`, which stays tenant-safe and token-free): `{ v:1, occurred_at, summary_text, deep_link (tokenized) }`. The resolver computes + stores each item's **validated byte size** (`digest_item_bytes`).
- Chunk membership is bounded by **≤ 50 items** AND cumulative `digest_item_bytes` under a conservative budget that leaves headroom for HTML/template/escaping below the **~90 KB rendered ceiling**.
- **Hard check before send:** the worker renders the chunk's HTML and asserts `octet_length(html) ≤ 90 KB`; if exceeded it does NOT send — it fails the group for re-materialization at a smaller cap (a bounded, logged path), never a truncated/oversized email. Row count 50 + byte budget makes this effectively unreachable; the check is the backstop.

### PV — append-only provider events + monotonic rollup + suppression (fixes #4)

```sql
CREATE TABLE public.notification_provider_events (
  resend_event_id  text PRIMARY KEY,            -- webhook idempotency (append-only)
  resend_email_id  text NOT NULL,
  digest_group_id  uuid REFERENCES notification_digest_groups(id),
  status           text NOT NULL,               -- sent|delivered|bounced|complained|…
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now());
```

The Resend webhook: (a) `INSERT … ON CONFLICT (resend_event_id) DO NOTHING` (append-only, idempotent);
(b) resolve `resend_email_id → digest_group_id` and advance the group's **monotonic** rollup only
(`provider_status_rank`: sent=1 < delivered=2, bounced=3/complained=3 terminal; never regress — a late
`sent` cannot overwrite `delivered`); (c) **continue calling the existing `record_email_event`** so
bounce/complaint suppression (`email_address_state`/`is_email_suppressed`) stays authoritative for
every member destination. Member timelines resolve delivery THROUGH `digest_group_id → provider rollup`.

### LEDGER + REC — immutable ledger, dimensional counters (fixes #5)

```sql
CREATE TABLE public.notification_digest_group_attempts (   -- append-only; never updated
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_run_id uuid NOT NULL, digest_group_id uuid NOT NULL,
  attempt_no int NOT NULL, action text NOT NULL,           -- claimed|deferred|sent|failed|unknown
  item_count int NOT NULL DEFAULT 0, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notification_worker_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker text NOT NULL, channel text NOT NULL, phase text NOT NULL,   -- materialize|dispatch
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
```

`reconcile_notification_digest_run(p_run_id)` reads the **ledger** (immutable — a later run's re-claim
never erases this run's participation) and returns **dimensionally separate** counts:
`groups_claimed`, `groups_sent`, `groups_failed`, `groups_deferred`, `groups_unknown`,
`items_sent` (Σ item_count of sent groups), `provider_sends`, `member_outcomes`. A 50-item email counts
as **1 group / 50 items / 1 provider-send** — never 1≡50 in one invariant. Invariant:
`groups_claimed = groups_sent + groups_failed + groups_deferred + groups_unknown + groups_still_processing`.

### CAPS — locked counters + reservations held-until-reconciled (fixes #6)

```sql
CREATE TABLE public.notification_send_counters (              -- the atomic authority
  counter_key text PRIMARY KEY,                              -- channel:event:recipient_key:bucket_kind:bucket_start
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start timestamptz NOT NULL, used int NOT NULL DEFAULT 0);
CREATE TABLE public.notification_send_reservations (          -- idempotent per group
  digest_group_id uuid NOT NULL, counter_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','committed','released')),
  PRIMARY KEY (digest_group_id, counter_key));
```

At dispatch, reserve the **hour** counter row then the **day** counter row **in that deterministic
order** (avoids deadlock) via `UPDATE notification_send_counters SET used=used+1 WHERE counter_key=…
AND used < cap RETURNING` (atomic; two workers can't both pass). Both must succeed or the group defers
(and any partial reservation is released). Reservations are idempotent per `(digest_group_id,
counter_key)`. On `record` sent → reservations `committed` (capacity stays consumed). On `failed` →
`released`. **A crash after provider acceptance leaves reservations `reserved` and the group
`processing`; the stale-reclaim path re-sends under the same idempotency key and only then
commits/releases — capacity is never released by a crash.**

### PS — generic fail-closed pre-send + event policy hook (fixes #9)

At dispatch the generic engine re-validates and **fails closed** (→ member `cancelled` /
`skip_reason`, or defer if transient) on: current **preference** (prefs_v2 says off), **contact
revoked/replaced** (the snapshot contact no longer current), **destination mismatch**, and
`is_email_suppressed`. Event-specific eligibility (e.g. **"unfollowed"** for open-slot) is a
**versioned pre-send policy hook** keyed by `event_type`, registered by **10c-b** — not hardcoded in
the generic engine. Required-delivery events are exempt from opt-out cancellation (existing semantics).

### QH — quiet hours (exact; fixes owner ask)

Quiet hours = **outside 09:00–20:00 in the recipient's timezone** (matches `send-window.ts`
`SEND_START_HOUR=9`, `SEND_END_HOUR=20`). Local wall-clock is `digest_boundary_at AT TIME ZONE
recipient_timezone` (Postgres, DST-correct). If the boundary falls in quiet hours, **defer** to the
next **09:00 local** (computed in `recipient_timezone`, DST-aware) — bump `digest_boundary_at`, no
attempt consumed. Only applies when `event_types.quiet_hours_respect`.

### TZ — timezone precedence (owner-decided)

`recipient_timezone` snapshot precedence: **academy timezone (when tenant-academy-scoped) → trainer
timezone → `Europe/Amsterdam`**. No person-timezone source is claimed until such a column exists;
adding it later is a precedence change only — group identity (which includes the snapshot tz) is
unaffected in shape.

### MIG — migration / back-compat (fixes #8)

- `digest_eligible(o) := coalesce(o.digest_frequency IN ('daily','weekly'), false) AND coalesce((SELECT digest_engine_enabled FROM notification_event_types WHERE key=o.event_type), false)` — **strict boolean**; a legacy row with NULL `digest_frequency` is `false` → stays instant.
- New snapshot columns are nullable with no backfill required; existing rows remain instant-path claimable. `claim_notification_outbox_batch` gains `AND NOT digest_eligible(o)` (strict-boolean, so never NULL-strands).
- `digest_engine_enabled` defaults false on all rows; only the test fixture enables it.

### C10 — no synthetic event in the live catalog (fixes #10)

10c-a exercises the engine via **test fixtures only** (pglite + a real-Postgres plan test). No synthetic
event is inserted into the live `notification_event_types`. If a production diagnostic is ever needed it
must carry an `internal boolean DEFAULT false` flag and every user-facing catalog query
(`NotificationSettings.tsx`, tenant reads) must filter `WHERE NOT internal`.

### IX — indexes + selection paths (fixes #7)

- Forming (ungrouped due members): `notification_outbox (channel, digest_boundary_at) WHERE status='pending' AND digest_group_id IS NULL AND digest_frequency IN ('daily','weekly')`.
- Dispatch due-work (**leads with boundary**): `notification_digest_groups (channel, digest_boundary_at) WHERE state='pending'`.
- Retry: `notification_digest_groups (channel, next_attempt_at) WHERE state='failed'`.
- Stale reclaim: `notification_digest_groups (channel, locked_at) WHERE state='processing'`.
- Member fetch: `notification_outbox (digest_group_id)`.
- Group hint/dedup: `UNIQUE (canonical_group_key, chunk_ordinal)` + `(group_key_hash)`.

## State-transition tables

**Group** (`notification_digest_groups.state`):

| From | Event | To | Side effects |
|---|---|---|---|
| — | materialize INSERT | `forming`→`pending` | members assigned; `item_count`/bytes set |
| `pending` | dispatch claim, in-window, caps ok | `processing` | `attempts++`, `locked_by/at`, `worker_run_id`, ledger `claimed` |
| `pending` | dispatch claim, quiet-hours/cap | `pending` | `digest_boundary_at` bumped; **no attempt**; ledger `deferred` |
| `processing` | record `sent` | `sent` | members sent; reservation `committed`; provider row; ledger `sent` |
| `processing` | record `failed`, `attempts<max` | `failed` | `next_attempt_at`; reservation `released`; ledger `failed` |
| `processing` | record `failed`, `attempts≥max` | `failed` (terminal) | reservation released; ledger `failed` |
| `processing` | `locked_at` stale | `processing` (reclaim) | re-locked SAME group; same id/key |
| `processing` | ambiguous & `now-first_send_at>24h` | `delivery_unknown` | reservation stays committed; surfaced in reconcile |
| `failed` | `next_attempt_at≤now`, re-claim | `processing` | SAME group/members/key; `attempts++` |

**Member** (`notification_outbox.status`): `pending`(ungrouped) → `processing`(grouped, group owns it) → `sent`/`cancelled`(opt-out §PS)/`failed`(group terminal). Late arrivals stay `pending`.

## Crash-point → single recovery route

| Crash point | State left | Unambiguous recovery |
|---|---|---|
| after materialize INSERT, before member-assign | group `forming` | re-materialize: `ON CONFLICT DO NOTHING` finds it, resumes assignment (idempotent) |
| after claim (`processing`), before send | group `processing`, `locked_at` set | stale-reclaim re-locks SAME group → send (same idempotency key) |
| after provider accept, before `record` | `processing`, `first_send_at` set, reservation `reserved` | stale-reclaim re-sends same key (Resend dedups <24h); >24h → `delivery_unknown`; capacity not released |
| after `record sent`, before ledger | group `sent`, ledger missing one row | ledger is append-only + best-effort; reconcile uses group terminal state as truth when a ledger row is absent (documented) |
| webhook double-delivery | — | `ON CONFLICT (resend_event_id) DO NOTHING`; rollup monotonic |

## RPC contracts (all SECURITY DEFINER, service-role only)

`materialize_notification_digest_groups(p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int) RETURNS int` ·
`claim_notification_digest_group(p_run_id uuid, p_worker text, p_channel text, p_now timestamptz, p_stale_after_minutes int) RETURNS TABLE(digest_group_id uuid, chunk_ordinal int, member cols…, outcome text)` ·
`record_notification_digest_result(p_run_id uuid, p_worker text, p_digest_group_id uuid, p_status text, p_provider_message_id text, p_error text, p_terminal boolean, p_max_backoff_minutes int) RETURNS text` ·
`record_notification_provider_event(p_resend_event_id text, p_resend_email_id text, p_status text, p_occurred_at timestamptz) RETURNS text` (append-only + monotonic rollup + calls `record_email_event`) ·
`start_notification_worker_run(p_worker text, p_channel text, p_phase text) RETURNS uuid` ·
`reconcile_notification_digest_run(p_run_id uuid) RETURNS TABLE(dimension text, metric text, count int)`.
Amended: `claim_notification_outbox_batch` `+ AND NOT digest_eligible(o)`. Types drift → CI-generated `types.ts`.

## Test plan

- **Concurrency (real PG):** two dispatch claims race on one group → `FOR UPDATE SKIP LOCKED` + advisory-lock forming → exactly one owner; no split; no double-send. Materialize idempotent under two runners (unique constraint).
- **Crash-point (real PG):** each row of the crash table above → the single documented route; reclaim yields SAME `digest_group_id` + members + idempotency key (byte-equal); >24h → `delivery_unknown`; capacity never released by a crash.
- **Scale (real Postgres, realistic cardinality):** e.g. 100k due digest rows **mixed with a large disabled-event population** → `EXPLAIN (ANALYZE, BUFFERS)` shows the due-work index (leading `digest_boundary_at`) drives selection; bounded member fetch. Not PGlite.
- **Caps:** hour+day locked-counter atomicity under two workers; deterministic hour-then-day order (no deadlock); deferral consumes no attempt; reservation committed on send, released on fail, held on crash.
- **Provider/suppression:** append-only on `resend_event_id`; monotonic rollup (late `sent` can't regress `delivered`); a bounce still suppresses via `record_email_event`; bounce visible on every member timeline via `digest_group_id`.
- **Rendered-size:** a crafted oversized chunk trips the 90 KB hard-check → not sent, re-materialized smaller.
- **Reconcile:** dimensional invariant holds; deferred/retried rows keep first-run participation via the ledger.
- **Pre-send:** preference-off / suppressed / revoked-contact / destination-mismatch → fail closed; required events exempt.
- **Back-compat:** legacy NULL-snapshot rows stay instant-path; `digest_eligible` never returns NULL.

## Alternatives considered

- **Group state on member rows (Rev 2)** — rejected (#1): ordinary retries returning members to `pending` re-mint the group; a durable group row + immutable ledger is required.
- **String-concatenated group key / hash as identity (Rev 2)** — rejected (#2): NULL-collapse + delimiter collisions; canonical jsonb key with hash-as-hint.
- **One mutable provider row (Rev 2)** — rejected (#4): loses history + allows regression; append-only + monotonic rollup + keep `record_email_event`.
- **Reservation rows as the cap authority (Rev 2)** — rejected (#6): locked counter rows are the atomic authority; reservations are idempotency records.
- **`public_summary` as digest content** — rejected (#3): tenant-readable; a service-role `digest_item` carries tokenized deep links.
- **Live synthetic catalog event** — rejected (#10): test fixtures / internal-hidden only.

## Consequences

- The resolver + a durable group table + an immutable ledger are the new correctness spine; 10c-a ships
  them exercised only by fixtures, inert in prod.
- `reconcile_notification_digest_run` + the ledger give run-level, dimensionally-honest proof for the
  digest path and a template for the instant path.
- Keeping `record_email_event` in the webhook means digest bounces suppress exactly like 1:1 sends.
- Open params for the owner to confirm before implementation: the **50-item / ~90 KB** caps, the
  **09:00–20:00** quiet window, and the **academy→trainer→Amsterdam** precedence (all set above per your
  decisions — confirming they're what you intend).
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
