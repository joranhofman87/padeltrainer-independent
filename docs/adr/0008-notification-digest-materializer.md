# ADR 0008 — v2 notification digest materializer (attempt-aware reservations, evidence-gated terminals)

Status: **Proposed — Rev 11** (self-contained; addresses the Codex review of Rev 10; design-only, PR 10c-a)
Date: 2026-07-24

> **Rev 11 (narrow) — five corrections only, no other section redesigned:**
> **(1)** add `group.current_attempt_id`; the breaker binds `probe_group_id` at CAS and
> `probe_attempt_id` only when `begin_digest_attempt` creates the attempt (§CB, §M2, §P6).
> **(2)** an executable no-send age-out: `awaiting_evidence AND available_at ≤ now → delivery_unknown`
> in `claim` (§AE, §P1). **(3)** provider callbacks are monotonic against a later HTTP `accepted`
> (rank-guarded); `email.sent` is positive **acceptance** evidence; all seven callbacks call
> `record_email_event` once — 10c-a extends the webhook map + delivery-event constraint +
> `record_email_event` for `email.suppressed` (§PV). **(4)** `retryable_definite`/`global_config` stay
> **retryable** (`request_ready`) under sticky uncertainty; only `terminal`/stop/budget-exhaustion while
> uncertain → `awaiting_evidence`; the reservation's originating `attempt_id` is immutable (§P6, §CAPS).
> **(5)** `worker_runs` allows only unfinished→finished; ledger→group/run/attempt FKs + cascades; the
> outbox→group FK is `ON DELETE SET NULL` (row + timeline survive a 90-day group purge); `superseded`
> parents are excluded from `groups_touched` (§AUDIT, §RET, §LEDGER).

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert. Four-stage
> plan: 10c-a foundation · 10c-b open_slots→v2 (+ event pre-send policy hook; enables the first digest
> event) · 10c-c durability closure · 10c-d legacy retirement. Intended **implementation contract**.

## Core model (Rev 9 preserved + Rev 10 corrections)

Preserved: **durable attempt rows** (fresh `attempt_id` per HTTP dispatch, one **frozen** provider key
`dg:v1:<group_id>` reused), **SQL-idempotent record**, **late `accepted` monotonically completes the group**,
**sticky uncertainty**, **immutable `digest_boundary_at`** vs mutable **`available_at`**. Rev 10 adds:
**attempt-aware reservations that are never released while uncertain** (+ an explicit **`awaiting_evidence`**
state), a **durable half-open probe identity**, the **restored worker-run/ledger/reconciliation contracts**,
a **transport+status+name error taxonomy** (unknown 4xx = definite global hold, not ambiguous), a
**rendered single-item oversize** terminal, an **exact provider-callback table**, and **precise
persistence/retention/scrub/scheduling** rules.

## Rev 10 review-response map

| # | Finding | Fix |
|---|---|---|
| 1 | Sticky uncertainty still releases capacity; "instead ages" undefined | Reservations carry **`attempt_id`**; **never release while `uncertain_since` is set** (ambiguous → reservation `committed`); a definite outcome received while uncertain → explicit **`awaiting_evidence`** state (capacity committed, `available_at = uncertain_deadline_at`) (§CAPS, §AE) |
| 2 | Half-open has no durable identity; `available_at` can't be NULL | Persist **`probe_group_id` + `probe_attempt_id`**; only that attempt transitions half-open; the **breaker gate** holds the row — `available_at` is never set to a NULL `retry_at` (§CB) |
| 3 | Observability contract regressed | **Restored** `notification_worker_runs`, ledger `notification_digest_group_attempts`, `reconcile_notification_digest_run`, dimensional invariants; Phase A **hard 50-item cap** (not `p_max_members`) (§LEDGER, §MAT) |
| 4 | Unknown errors mis-classified as ambiguous | Classify by **transport + HTTP status + error name**: timeout/no-response/5xx/409 → ambiguous; **unknown 4xx → definite `global_config` (hold+alert), never ambiguous/row-terminal**; known-terminal allow-list only; `invalid_idempotent_request` → invariant-breach/manual hold (§ERR) |
| 5 | Rendered single item can dead-end | The **render-time** 90 KB check: multi-item → split; **single-item oversize → terminal `oversize_failed`** (finalize/scrub member, alert) (§CH) |
| 6 | Provider callbacks underspecified | Exact per-callback transition table for `sent`/`delivery_delayed`/`delivered`/`bounced`/`failed`/`suppressed`/`complained` — group state, member status, reservation, suppression call, late-evidence override; **delivered/complained prove delivery**, bounced/failed/suppressed do not (§PV) |
| 7 | Persistence imprecise | Attempt-row **trigger** (only NULL→recorded; identity/request immutable); retention = **purge** with FK `ON DELETE CASCADE` + deletion order; **scrub = set whole `payload`/`digest_item`/`frozen_request` to NULL**; **weekly = fixed Monday** (§AUDIT, §RET, §SCRUB, §BND) |

Owner params: 50 items / ~90 KB / academy→trainer→Amsterdam / 35-day counter + 90-day audit retention /
23 h uncertainty / breaker timings / weekly = Monday.

## Data model (self-contained)

### M1 — immutable snapshot, canonical key, idempotency key (unchanged)

`enqueue_notification` snapshots immutably: `delivery_mode ('instant'|'digest')`, `recipient_key`
(`p:/u:/g:`), `digest_frequency`, `group_locale`, `recipient_timezone`, **`digest_boundary_at`** (§BND,
immutable), `template_version`, `destination_fingerprint`, service-role `digest_item` + server-computed
`digest_item_bytes`. `canonical_group_key = jsonb_build_array('v1', channel, recipient_key,
destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, event_type, template_key,
template_version, group_locale, digest_frequency, digest_boundary_at)`; `group_key_hash` = its sha256 (hint).
`provider_idempotency_key = 'dg:v1:'||digest_group_id` (set at `store`, reused). `digest_eligible(o) :=
coalesce(o.delivery_mode='digest', false)`. Outbox gains `status='delivery_unknown'`, `digest_group_id`,
`skip_reason`.

### M2 — group (adds `awaiting_evidence`; `available_at`; lineage)

`notification_digest_groups` as Rev 9, with `state ∈ ('pending','leased','prepared','request_ready',
'sending','awaiting_evidence','sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped',
'no_work','superseded')`, `parent_group_id`, immutable `digest_boundary_at`, mutable `available_at NOT NULL`,
`provider_attempts_started` (monotonic), `delivery_budget_used`/`max_delivery_budget`, `uncertain_since`/
`uncertain_deadline_at`, `frozen_request`/`request_hash`/`provider_idempotency_key`, **`current_attempt_id
uuid`** (the group's live attempt — P6 distinguishes current from stale by it), `provider_message_id
UNIQUE`, `provider_status`/`provider_status_rank`, `terminal_reason`, `UNIQUE(canonical_group_key,
chunk_ordinal)`.

### ATT — attempt rows + append-only trigger (fixes #7)

```sql
CREATE TABLE public.notification_digest_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id) ON DELETE CASCADE,
  worker_run_id uuid NOT NULL, provider_idempotency_key text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
  outcome_class text, resend_error_name text, http_status int, provider_message_id text, recorded_at timestamptz);
```

A `BEFORE UPDATE` trigger permits **only** the transition `recorded_at IS NULL → recorded_at set` (writing
`outcome_class/resend_error_name/http_status/provider_message_id/recorded_at`) and **rejects** any change to
`attempt_id/digest_group_id/provider_idempotency_key/started_at`; a `BEFORE DELETE` trigger raises (rows go
only by retention cascade). Record is idempotent (`WHERE recorded_at IS NULL`).

### LEDGER — worker runs, event ledger, reconciliation (restored; fixes #3)

```sql
CREATE TABLE public.notification_worker_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), worker text NOT NULL, channel text NOT NULL,
  phase text NOT NULL, status text, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
CREATE TABLE public.notification_digest_group_attempts (            -- the event ledger (append-only)
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED BY DEFAULT AS IDENTITY,
  worker_run_id uuid NOT NULL, digest_group_id uuid NOT NULL, attempt_id uuid, action text NOT NULL,
  item_count int NOT NULL DEFAULT 0, occurred_at timestamptz NOT NULL DEFAULT now());
```

`start_notification_worker_run(worker, channel, phase) → run_id`;
`finish_notification_worker_run(run_id, status)` with `status ∈ ('succeeded','failed','abandoned')`. Every
state-changing RPC appends one ledger row **in the same transaction**; `action` ∈
`materialized|leased|deferred|prepared|no_work|superseded|request_ready|attempt|sent|retryable|ambiguous|
terminal|global_config|awaiting_evidence|delivery_unknown|retry_stopped|oversize_failed`. Repeated deferrals
are distinct events. `reconcile_notification_digest_run(run_id) → TABLE(family text, metric text, count int)`
returns two **families**: **event counts** (ledger rows; `attempt` == `provider_attempts_started` deltas)
and **distinct-group** terminal counts. Invariant (distinct **deliverable** groups touched, **superseded parents excluded** — their members moved
to children and are counted there): `groups_touched = sent + failed_terminal + oversize_failed + no_work +
retry_stopped + delivery_unknown + awaiting_evidence + in_flight`, with `groups_superseded` reported as a
separate lineage count. A 50-item email = **1 group / 50 items / 1 provider-send** — never conflated. HTTP
calls ≤ `attempt` rows (crash gap permitted).

### CB — breaker with durable probe identity (fixes #2)

`notification_provider_circuit(channel PK, state CHECK('closed','open','half_open'), reason, tripped_at,
retry_at, probe_group_id uuid, probe_attempt_id uuid, probe_locked_at timestamptz)`. Trip → `open` +
reason-aware `retry_at` (auth/config +15m; daily quota +coalesce(Retry-After,24h); monthly quota /
invariant-breach `retry_at=NULL` manual hold). **Claim gate:** `open` (with `retry_at NULL OR now<retry_at`)
OR `half_open` → non-probe workers get `none`. At `now≥retry_at`, the two-stage bind: (i) one worker CAS
`open→half_open` **records only `probe_group_id`** (+ `probe_locked_at`) — the attempt does not exist yet;
(ii) when that group's `begin_digest_attempt` creates the attempt, it **atomically sets both
`group.current_attempt_id` AND `circuit.probe_attempt_id`** to the new id (guarded `WHERE
probe_group_id=this AND probe_attempt_id IS NULL`). **Only `probe_attempt_id`'s record may transition the
breaker** (accepted→`closed`; rate-limit/validation→`closed`; global_config→re-`open`; ambiguous→re-`open`
short; stale `probe_locked_at` before an attempt binds → re-CAS). The breaker never writes `available_at`;
a group behind an open breaker keeps its `available_at` and is simply not claimable — no NULL assignment.

## Phase A — MATERIALIZE (atomic per group; deterministic 50-item cap; fixes #3)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_groups, p_max_members_per_call) →
int`: per `canonical_group_key`, advisory-lock on `group_key_hash`, `chunk_ordinal =
coalesce(max(existing),-1)+1`; **create group + assign members in one txn** (no persisted `forming`).
Members: `ORDER BY created_at, id`, **hard cap 50 items per group** AND cumulative `digest_item_bytes` under
budget — a 51st member starts a new `chunk_ordinal`. The call is bounded by `p_max_groups` and
`p_max_members_per_call` (work per invocation), but the **per-group 50-item cap is invariant**. `available_at
= digest_boundary_at`. **Raw single-item oversize** (`digest_item_bytes` alone > budget) → group created
`oversize_failed` (member `failed`/`single_item_oversize`, alert). (Rendered oversize is caught later, §CH.)

## Phase B — the RPCs

**P1 · claim** (breaker-gated §CB): ONE group `FOR UPDATE SKIP LOCKED`, `ORDER BY available_at`, from fresh
`pending` (quiet-hours §QH bumps `available_at`), **due owned `request_ready`** (`available_at ≤ p_now AND
locked_by IS NULL`), **due `awaiting_evidence` age-out** (`state='awaiting_evidence' AND available_at ≤ p_now`
→ a **no-send** transition to `delivery_unknown`: finalize members (§MEM) + reservations (`committed`, §CAPS)
atomically, ledger `delivery_unknown`, then continue to the next group), or **crash reclaim** (stale-locked;
a stale `sending` → set `uncertain_since` if null → owned `request_ready`, reservation retained). *(The
age-out is also exposed as a standalone `reconcile`-time sweep for operators.)*

**P2 · prepare** (from `leased`): validation §PS; finalize rejected members immediately (§MEM); survivors →
`prepared` else `no_work`.

Worker **renders**; **§CH** 90 KB check → split or `oversize_failed`.

**P3 · split** (ownership-gated, `pending|prepared`): children with `parent_group_id`, move members, original
`superseded`.

**P4 · store** (from `prepared`): recompute+validate request; set `provider_idempotency_key='dg:v1:'||id`;
→ `request_ready`, `available_at=now()`.

**P5 · begin attempt** (ownership-gated, `request_ready`): stop-only re-checks §PS; uncertainty age-out
(→`delivery_unknown`); breaker gate; quiet-hours (bump `available_at`); budget bound; **reserve** (attempt-aware,
§CAPS); **INSERT attempt row** (fresh `attempt_id`, frozen key); `provider_attempts_started++`;
`delivery_budget_used++`; ledger `attempt`; → `sending`; return `attempt_id`+key. Worker POSTs via
`sendResendDigestOnce` (Resend tag `digest_group_id`) — one HTTP.

**P6 · record** (idempotent by `attempt_id`, §ERR mapping): write the attempt-row outcome; then the group:
- **`accepted`** → positive **acceptance** evidence; monotonic completion, **rank-guarded (§PV, fixes #3):**
  it sets `provider_status=sent` and `state=sent` **only if `provider_status_rank < 3`** — if a stronger
  provider callback (`delivered`/`bounced`/`complained`/`failed`/`suppressed`) already landed, the group
  keeps THAT delivery outcome and `accepted` merely confirms API acceptance (clears uncertainty). Applies
  even if a newer attempt owns the group; commit reservations; scrub; members per the resolved outcome.
- stale attempt & non-accepted → **annotate the attempt row only** (no group change).
- **`retryable_definite`** (429) → **stays retryable: `request_ready`**, `available_at=now()+max(Retry-After,
  backoff)`, clear ownership. Sticky uncertainty: **if `uncertain_since` set, do NOT release** (reservation
  stays `committed`); else release this attempt's reservation.
- **`ambiguous`** → `request_ready`; **set/keep `uncertain_since`**; this attempt's reservation → **committed**
  (never released); clear ownership; `available_at=now()+backoff`.
- **`global_config`** → record attempt; `delivery_budget_used--`; trip breaker (§CB); **stays retryable:
  `request_ready`** behind the breaker hold, clear ownership. Sticky uncertainty: **if uncertain, keep
  `committed`**; else release. *(429 and global_config are recoverable and keep retrying inside the 23 h
  window — they never force `awaiting_evidence`.)*
- **`terminal`** (definite un-retryable) → **if `uncertain_since` set: `awaiting_evidence`** (reservations →
  `committed`, `available_at=uncertain_deadline_at`); else `failed_terminal`, release reservation, scrub,
  members `failed`.
- **Stop / budget-exhaustion while uncertain** (from §P5/§PS) → `awaiting_evidence` (reservations →
  `committed`). *(`awaiting_evidence` is reserved for terminal/stop/budget cases only.)*

### AE — awaiting_evidence (fixes #1)

A group with `uncertain_since` set that reaches an **un-retryable** definite state — a **`terminal`**
provider outcome, a **stop** condition, or **budget exhaustion** (Rev 11 #4: `429`/`global_config` are
recoverable and stay `request_ready`, NOT here) → **`awaiting_evidence`**: capacity **committed** (held),
`available_at = uncertain_deadline_at`. It resolves by: a positive provider event (`delivered`/`complained`
→ `sent`; `bounced`/`failed`/`suppressed` → not-delivered outcome, §PV), operator reconciliation, or the
`claim` age-out at `uncertain_deadline_at` → `delivery_unknown` (§P1). It is never re-sent (an un-retryable
outcome exists) and capacity is never released.

### CAPS — attempt-aware, never-release-while-uncertain (fixes #1)

`notification_send_counters(counter_key PK, bucket_kind CHECK('hour','day'), bucket_start, used int CHECK(used>=0), cap int)`;
`notification_send_reservations(digest_group_id, counter_key, attempt_id uuid, bucket_start, state
CHECK('reserved','committed','released'), created_at DEFAULT now(), updated_at DEFAULT now(),
PRIMARY KEY(digest_group_id, counter_key))`. `counter_key = channel||':'||event_type||':'||destination_fingerprint
||':'||bucket_kind||':'||bucket_start::text` (per destination). `begin` **reuses** an active reservation
(`reserved`/`committed`) on current buckets **without overwriting its originating `attempt_id`** (immutable),
else **acquires fresh** (ensure rows; `FOR UPDATE` hour then day; `used<cap`; `used++`; insert `reserved`
stamped with this `attempt_id`). **Transitions:** `accepted`/`ambiguous` →
`committed` (capacity consumed / possibly consumed). **Release-once** (`reserved→released`, `used=used-1`)
**only** for a definite outcome **while `uncertain_since IS NULL`** (`retryable_definite`/`terminal`/`global_config`).
**Never release while uncertain** (already `committed`). Retention: counters `bucket_start<now()-35d`, terminal
reservations `updated_at<now()-35d`.

### ERR — transport + status + name taxonomy (fixes #4)

| Transport / status / name | class |
|---|---|
| no response / timeout / network | `ambiguous` |
| 5xx / `application_error` | `ambiguous` |
| 409 `concurrent_idempotent_requests` | `ambiguous` |
| 429 `rate_limit_exceeded` | `retryable_definite` (Retry-After) |
| 429 `daily_quota_exceeded` / `monthly_quota_exceeded` | `global_config` |
| 401/403 `invalid_api_key`/`restricted_api_key` | `global_config` |
| 4xx **known-terminal allow-list** (`validation_error`, `invalid_from_address`, `invalid_attachment`, `missing_required_field`) | `terminal` |
| **4xx unknown name (definite HTTP response)** | **`global_config`** — hold + alert (definite rejection, NOT ambiguous, NOT row-terminal) |
| `invalid_idempotent_request` | **invariant breach** — alert + manual-hold breaker |

Rationale: a completed 4xx is a **definite** answer (no uncertainty); an unknown 4xx pauses the channel for
operator review rather than terminal-failing a row or holding false ambiguity. Only transport/5xx/409 are
genuinely ambiguous.

### CH — chunking + rendered single-item oversize (fixes #5)

`digest_item` service-role, server-verified bytes; per-group **≤ 50 items** + cumulative byte budget under
~90 KB. At **render time**, `octet_length(html)`: **> 90 KB & item_count > 1 → `split_digest_group`**; **>
90 KB & item_count = 1 → terminal `oversize_failed`** (member `failed`/`single_item_oversize`, scrub, alert)
— a single item can't be split, so it dead-ends explicitly here (covering post-render overhead a raw check
misses).

### PV — provider callback transition table (fixes #6)

Tag `digest_group_id` on send; `notification_provider_events(resend_event_id PK, provider_message_id,
digest_group_id, status, occurred_at, received_at)` append-only, orphan-then-link, at-least-once/unordered
safe; monotonic `provider_status_rank`. Per callback (correlate via tag or `provider_message_id`):

| callback | provider_status | group (from `sending`/`awaiting_evidence`/`delivery_unknown`) | member | reservation | `record_email_event` |
|---|---|---|---|---|---|
| `sent` | sent (rank 1) | **positive ACCEPTANCE evidence** — resolves acceptance uncertainty (crash before HTTP record → confirms the API accepted); awaits delivery | — | commit | **yes** |
| `delivery_delayed` | delivery_delayed (2) | acceptance-confirmed; still in flight | — | commit | **yes** |
| `delivered` | delivered (3) | **resolve → `sent`** (proves delivery) | `sent` | commit | **yes** |
| `complained` | complained (5) | **resolve → `sent`** + complaint flag (proves delivery) | `sent` | commit | **yes** (suppress) |
| `bounced` | bounced (4) | **resolve → not-delivered** (`→ failed_terminal`, reason `bounced`) | `failed` | commit | **yes** (suppress) |
| `failed` | failed (4) | **resolve → not-delivered** (`→ failed_terminal`) | `failed` | commit | **yes** |
| `suppressed` | suppressed (4) | **resolve → not-delivered** | `cancelled`/`suppressed` | commit | **yes** (suppress) |

`email.sent` is **positive acceptance evidence** (the API request succeeded), so a `sent` callback after a
worker crash resolves acceptance uncertainty. `delivered`/`complained` additionally **prove delivery**
(override `delivery_unknown`/`awaiting_evidence` → `sent`); `bounced`/`failed`/`suppressed` prove
**non-delivery** and resolve the group as not-sent — distinct outcomes, not a rank-only tie. A lower-rank
late event never regresses a higher one. **All seven callbacks call `record_email_event` exactly once** (per
group destination; the webhook event id is globally idempotent). **10c-a explicitly extends** the current
`supabase/functions/resend-webhook/index.ts` status map, the `email_delivery_events` status CHECK
constraint, and `record_email_event` to support the currently-unhandled **`email.suppressed`**.

### MEM / PS / QH / TZ / BND / SCRUB / AUDIT / RET / MIG / ACL / IX

- **MEM:** finalize each rejected member at `prepare` (mixed groups) and all members at every terminal — no member left `pending` (`sent`/`cancelled`/`failed`/`delivery_unknown` with reasons; `superseded` → moved to child).
- **PS:** stop-only checks (preference / current contact / destination / `is_email_suppressed` / event policy hook [10c-b]) at prepare (drop members) AND before every attempt (whole-group stop, no rewrite). Required-delivery exempt.
- **QH:** `[09:00,20:00)` in `recipient_timezone` at claim AND `begin`; bumps `available_at` only.
- **TZ:** academy → trainer → `Europe/Amsterdam`.
- **BND (fixes #7-weekly):** `digest_boundary_at` at enqueue in `recipient_timezone`, DST-correct: **daily** = next 09:00 local ≥ enqueue; **weekly** = next **Monday** 09:00 local ≥ enqueue (**Monday is fixed** — no per-event weekday column in 10c-a). Immutable.
- **SCRUB (fixes #7-scrub):** on every terminal (`sent`/`failed_terminal`/`oversize_failed`/`retry_stopped`/`delivery_unknown`): set the group `frozen_request = NULL` **and** each member's `notification_outbox.payload = NULL` **and** `digest_item = NULL` (whole columns, not enumerated fields); retain `request_hash` + safe-metadata allow-list.
- **AUDIT (fixes #7, #5):** `notification_digest_group_attempts` (ledger) and `notification_provider_events`
  are strictly append-only — `GRANT INSERT, SELECT` service_role only, a `BEFORE UPDATE/DELETE` trigger
  raises. `notification_digest_attempts` permits **only** the `recorded_at IS NULL → recorded_at set`
  transition (its trigger, §ATT); identity/request columns immutable. `notification_worker_runs` is **not**
  strictly append-only (`finish_notification_worker_run` writes it) — its trigger permits **only** the
  `ended_at IS NULL → ended_at/status set` transition and rejects any other update or delete. Rows leave
  only via retention (§RET).
- **RET (fixes #7-ret, #5):** retention = **purge** (not archive). FKs + cascade: `notification_digest_attempts.digest_group_id`
  and `notification_provider_events.digest_group_id` → `notification_digest_groups(id)` **ON DELETE CASCADE**;
  the **ledger** `notification_digest_group_attempts`: `digest_group_id → groups ON DELETE CASCADE`,
  `attempt_id → notification_digest_attempts ON DELETE SET NULL`, `worker_run_id → notification_worker_runs
  ON DELETE SET NULL`; **`notification_outbox.digest_group_id → notification_digest_groups(id) ON DELETE SET
  NULL`** — so after a group is purged the member outbox row **survives** (its terminal `status`/`skip_reason`
  and `email_delivery_events` timeline remain; `digest_group_id` becomes NULL). A retention job deletes
  **terminal groups** older than **90 days** (cascading attempts + provider events + ledger group-refs; the
  ledger's `attempt_id`/`worker_run_id` null out), then finished `worker_runs` older than 90 days, then
  counters/reservations at 35 days. Deletion order: groups → worker_runs → counters/reservations.
- **MIG:** legacy NULL `delivery_mode` → instant-path (strict boolean). Catalog `CHECK (NOT digest_engine_enabled OR supports_digest)`. Test-fixture event only.
- **ACL:** each of the 8 new tables: RLS on, no policy, `REVOKE … FROM PUBLIC, anon, authenticated`, service-role grants only (append-only tables INSERT/SELECT only). RPCs `SECURITY DEFINER`, `SET search_path=public`, service-role only. Migration-wide ACL guard test.
- **IX:** forming `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND digest_group_id IS NULL AND status='pending'`; due `notification_digest_groups (channel, available_at) WHERE state IN ('pending','request_ready') AND locked_by IS NULL`; awaiting-age `(available_at) WHERE state='awaiting_evidence'`; stale `(channel, locked_at) WHERE state IN ('leased','prepared','request_ready','sending')`; attempts `(digest_group_id)`; provider-event orphans `(provider_message_id) WHERE digest_group_id IS NULL`; member `notification_outbox (digest_group_id)`.

## Crash / race → single recovery route

| Event | State | Route |
|---|---|---|
| crash mid-materialize | (rolled back) | re-materialize; `UNIQUE` no-ops a completed group |
| crash after begin, before HTTP | `sending`, attempt unrecorded | reclaim → `uncertain_since` set → new attempt row, same key → re-POST (dedup) |
| crash after accept, before record | `sending` | reclaim re-POSTs same key; accepted idempotent replay completes; >23h → `delivery_unknown` |
| definite outcome while uncertain | `awaiting_evidence` | capacity committed; resolves on provider event / operator / age-out |
| callback before record | `sending`/`awaiting_evidence` | orphan event linked on `provider_message_id`; delivered/complained → `sent` |
| late `accepted` after reclaim | any non-terminal | monotonically completes; stale non-accepted annotates only |
| half-open probe crash | breaker `half_open` | stale `probe_locked_at` → re-CAS by another worker |
| webhook double/unordered | — | `ON CONFLICT DO NOTHING`; monotonic rank; lower never regresses higher |

## Test plan (named race/mutation cases)

Real-Postgres: attempt rows (fresh id/replay, one frozen key, idempotent record, late-accepted monotonic
completion, stale-non-accepted annotate-only); **capacity while uncertain never released** across
`timeout→429`, `timeout→terminal`, `timeout→global_config` (each → `awaiting_evidence`, reservation
`committed`, resolves only on evidence/age-out); attempt-aware reservation (a later attempt's release can't
touch an ambiguous attempt's committed reservation). Breaker: durable `probe_group_id`/`probe_attempt_id` —
only that attempt transitions; concurrent workers denied; every half-open outcome; stale-probe re-CAS;
monthly-quota manual hold; `available_at` never NULL. Observability: worker-run lifecycle; ledger same-txn;
reconcile event-vs-group families + invariant; deferred-then-sent = many events/one sent group. Errors:
transport/status/name taxonomy — timeout/5xx/409 ambiguous; **unknown 4xx → global_config hold+alert (not
ambiguous)**; known-terminal allow-list; `invalid_idempotent_request` → invariant breach. Render oversize:
single-item post-render >90 KB → `oversize_failed` (pin the rendered-overhead case); multi → split. Provider
callbacks: each of the 7 → its exact group/member/reservation/suppression/late-override row; delivered/
complained resolve delivery_unknown→sent; bounced/failed/suppressed → not-delivered; unordered/at-least-once.
Persistence: attempt-row trigger allows only NULL→recorded, blocks identity/DELETE; ledger/events/runs
UPDATE/DELETE blocked by grants; retention cascade + order; scrub nulls payload/digest_item/frozen_request.
Scheduling: daily next-09:00-local + weekly next-Monday-09:00-local incl DST. Two-worker concurrency; ACL
guard; catalog constraint; 100k scale on real PG amid disabled/instant; back-compat instant-path.
**Rev-11 pins:** (1) breaker two-stage — CAS binds `probe_group_id`, `begin` binds `current_attempt_id`
+ `probe_attempt_id`, only that attempt transitions. (2) `awaiting_evidence AND available_at ≤ now`
age-out → `delivery_unknown` (members + reservations finalized). (3) callback `bounced` **before** HTTP
record then `accepted` → group stays `failed_terminal`/bounced (rank-guard); `complained` before record →
delivered+complained; `sent` after a worker crash → resolves acceptance uncertainty; all seven callbacks
call `record_email_event` once; `email.suppressed` end-to-end (webhook + constraint + record_email_event).
(4) after uncertainty: `retryable_definite`/`global_config` stay retryable (`request_ready`, reservation
`committed`, retry within 23 h); only `terminal`/stop/budget → `awaiting_evidence`; reservation
originating `attempt_id` immutable across reuse. (5) `worker_runs` allows only unfinished→finished;
ledger→group/run/attempt FK cascades; `outbox.digest_group_id` nulls on group purge while the row +
timeline survive; `superseded` excluded from `groups_touched`.

## Alternatives considered

- **Group-keyed reservation release (Rev 9)** — rejected (#1): a retry could release an ambiguous send's
  capacity; attempt-aware + never-release-while-uncertain + `awaiting_evidence`.
- **`probe_locked_by` only (Rev 9)** — rejected (#2): no durable probe identity; `probe_group_id/attempt_id`.
- **Compressed observability "as prose" (Rev 9)** — rejected (#3): full worker-run/ledger/reconcile restored.
- **Unknown → ambiguous (Rev 9)** — rejected (#4): a completed 4xx is definite; transport/status/name taxonomy.
- **Raw-only oversize check (Rev 9)** — rejected (#5): render-time single-item terminal.
- **Rank-only callbacks (Rev 9)** — rejected (#6): delivered/complained prove delivery; bounced/failed/suppressed don't.
- **"purge/archive", enumerated scrub, configurable weekday (Rev 9)** — rejected (#7): purge+cascade, whole-column NULL, Monday fixed.

## Consequences

- Capacity accounting is now attempt-correct and evidence-gated: an ambiguous send's capacity is held until
  proven, and `awaiting_evidence` is the explicit home for "definite-failure-after-possible-acceptance".
- The breaker's single probe is durably identified; observability (runs/ledger/reconcile) is fully specified.
- The error taxonomy no longer manufactures false ambiguity; single-item render oversize can't dead-end;
  every provider callback has one transition; persistence/retention/scrub/scheduling are exact.
- Confirmations before implementation (all set): 50 / ~90 KB / 09:00–20:00 / academy→trainer→Amsterdam /
  35-day counter + 90-day audit retention / 23 h uncertainty / breaker timings / weekly = Monday.
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
