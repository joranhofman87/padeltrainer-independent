# ADR 0008 — v2 notification digest materializer (attempt-aware reservations, evidence-gated terminals)

Status: **Accepted** (Rev 12; self-contained implementation contract for PR 10c-a — being implemented in
the 10c-a1/2/3 slices)
Date: 2026-07-24

> **Rev 12 (surgical) — five corrections only, no other section redesigned:**
> **(1)** EVERY `begin_digest_attempt` (not only probes) atomically sets `group.current_attempt_id`;
> probe attempts additionally bind `circuit.probe_attempt_id` in that txn (§P5).
> **(2)** executable half-open recovery **after** `probe_attempt_id` binds — a lease + `half_open→open`
> re-arm + replacement re-bind, so a crash before/after HTTP can't leave the breaker permanently
> half-open (§CB). **(3)** dispatch completion is **separate** from the provider-status rollup:
> `accepted`/`email.sent`/`delivery_delayed` finalize dispatch (`→ sent`, members, reservation, scrub,
> uncertainty), while `provider_status` advances **only on strictly-higher rank** (so `delivery_delayed`
> then a later `accepted` keeps `provider_status=delivery_delayed`; bounced/delivered/complained
> preserved) (§P6, §PV). **(4)** the stale test-plan line corrected: `timeout→429/global_config` stay
> `request_ready`; only `terminal`/stop/budget → `awaiting_evidence`. **(5)** retention corrected: a
> group delete **cascades** its attempts + provider events + ledger rows (they do not survive); the
> outbox row + timeline survive with `digest_group_id` nulled (§RET).
>
> *Rev 11's five corrections (current_attempt_id column, awaiting_evidence age-out, callback/accepted
> monotonicity, retryable-under-uncertainty, worker-run/FK/superseded) remain in force below.*

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
short). **Half-open recovery (both before AND after `probe_attempt_id` binds):** `probe_locked_at` carries a
lease; if the probe group makes no breaker-transitioning record within the lease, another worker CAS
`half_open→open` (re-arm, clear `probe_group_id`/`probe_attempt_id`) then re-probes — so a crash before HTTP
or after-HTTP-before-record cannot leave the breaker permanently half-open. When the probe group's stale
attempt is reclaimed and a **replacement** attempt is created, `begin_digest_attempt` **re-binds
`probe_attempt_id` to the replacement** (§P5), so the live attempt is always the one that may transition.
A late record from the *superseded* probe attempt: a **late `accepted`** still **completes the digest group
and its members and clears uncertainty per §P6** (acceptance is monotonic evidence, valid even when a newer
attempt owns the group), but **does not transition the breaker** (the re-armed breaker only advances for
`circuit.probe_attempt_id`); a **late non-accepted** result only annotates its attempt row (no group change,
no breaker transition). "Only annotates" thus governs **breaker-transition authority and non-accepted
outcomes**, never a late acceptance's §P6 completion. The breaker never writes `available_at`; a group behind an open breaker keeps
its `available_at` and is simply not claimable — no NULL assignment.

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
§CAPS); **INSERT attempt row** (fresh `attempt_id`, frozen key); **atomically set
`group.current_attempt_id = attempt_id`** (EVERY attempt — normal, first, and replacement retry; P6
distinguishes current from stale by this); **if this group is the breaker probe** (`circuit.probe_group_id
= this`) **also bind `circuit.probe_attempt_id = attempt_id`** in the same txn (guarded `WHERE
probe_group_id=this`, re-binding a stale probe's replacement, §CB); `provider_attempts_started++`;
`delivery_budget_used++`; ledger `attempt`; → `sending`; return `attempt_id`+key. Worker POSTs via
`sendResendDigestOnce` (Resend tag `digest_group_id`) — one HTTP.

**P6 · record** (idempotent by `attempt_id`, §ERR mapping): write the attempt-row outcome; then the group:
- **`accepted`** → positive **acceptance** evidence. **Dispatch completion and the provider-status rollup
  are separate (fixes #3):** (a) **dispatch** — set `state='sent'`, commit reservations, scrub, clear
  uncertainty, members `sent`, **unless** a stronger provider outcome already resolved the group
  (`provider_status_rank ≥ 3`: `delivered`/`bounced`/`complained`/`failed`/`suppressed`), in which case the
  group keeps THAT resolved outcome and `accepted` only records API acceptance (clears uncertainty);
  (b) **`provider_status`** advances **only if the incoming rank is strictly higher** — `accepted` maps to
  `sent` (rank 1) and therefore never regresses an already-`delivery_delayed` (2) rollup. Applies even if a
  newer attempt owns the group.
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
| `sent` | sent (1)† | **finalize dispatch → `sent`** (positive acceptance; resolves acceptance uncertainty after a crash), unless already resolved by a rank≥3 outcome | `sent` | commit | **yes** |
| `delivery_delayed` | delivery_delayed (2)† | **finalize dispatch → `sent`** (acceptance-confirmed; still in flight), unless already resolved by a rank≥3 outcome | `sent` | commit | **yes** |
| `delivered` | delivered (3) | **resolve → `sent`** (proves delivery) | `sent` | commit | **yes** |
| `complained` | complained (5) | **resolve → `sent`** + complaint flag (proves delivery) | `sent` | commit | **yes** (suppress) |
| `bounced` | bounced (4) | **resolve → not-delivered** (`→ failed_terminal`, reason `bounced`) | `failed` | commit | **yes** (suppress) |
| `failed` | failed (4) | **resolve → not-delivered** (`→ failed_terminal`) | `failed` | commit | **yes** |
| `suppressed` | suppressed (4) | **resolve → not-delivered** | `cancelled`/`suppressed` | commit | **yes** (suppress) |

**†Dispatch vs rollup are separate:** the "group" column finalizes the **dispatch/lifecycle** state
(`sent` = accepted; `failed_terminal` = not-delivered), while `provider_status` (the rank) advances **only
when the incoming rank is strictly higher** — so a late lower-rank event never regresses it. `email.sent`
is **positive acceptance evidence** (the API request succeeded) and so, like `accepted`/`delivery_delayed`,
finalizes dispatch (a `sent` callback after a crash resolves acceptance uncertainty and stops needless
retries). **Pin `delivery_delayed → later HTTP accepted`:** `provider_status` stays `delivery_delayed`
(rank 2 > accepted's `sent` rank 1), while the group/member are finalized `sent`. `delivered`/`complained`
additionally **prove delivery** (override `delivery_unknown`/`awaiting_evidence` → `sent`);
`bounced`/`failed`/`suppressed` prove **non-delivery** and override the group to `failed_terminal` (not
merely a rank tie) — these stronger outcomes are preserved against a later `accepted`/`sent`. **All seven callbacks call `record_email_event` exactly once** (per
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
  the **ledger** `notification_digest_group_attempts.digest_group_id → groups ON DELETE CASCADE` (its
  `attempt_id → notification_digest_attempts` and `worker_run_id → notification_worker_runs` are `ON DELETE
  SET NULL` — relevant only if an attempt/run were deleted independently, which retention never does); and
  **`notification_outbox.digest_group_id → notification_digest_groups(id) ON DELETE SET NULL`**. So deleting
  a purged group **cascades and removes its attempts, provider events, AND ledger rows together** (they do
  **not** survive), while the member **outbox row survives** (terminal `status`/`skip_reason` +
  `email_delivery_events` timeline remain; `digest_group_id` becomes NULL). A retention job deletes
  **terminal groups** older than **90 days** (cascading their attempts + provider events + ledger rows),
  then finished `worker_runs` older than 90 days, then counters/reservations at 35 days. Deletion order:
  groups (cascade) → worker_runs → counters/reservations.
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
completion, stale-non-accepted annotate-only); **capacity while uncertain never released**: `timeout→429`
and `timeout→global_config` stay **`request_ready`** (sticky uncertainty, reservation `committed`,
retry within 23 h); only `timeout→terminal` (or stop/budget exhaustion) enters `awaiting_evidence`; each
resolves only on evidence/age-out; attempt-aware reservation (a later attempt's release can't touch an
ambiguous attempt's committed reservation). Breaker: durable `probe_group_id`/`probe_attempt_id` —
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
+ `probe_attempt_id`, only that attempt transitions. **(Rev-12 acceptance pin) after a bound probe crashes
and the breaker is re-armed, a late old-probe `accepted` result finalizes the group/members and clears
uncertainty (§P6) but does NOT alter the re-armed breaker; a late non-accepted old-probe result only
annotates its attempt.** (2) `awaiting_evidence AND available_at ≤ now`
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

## 10c-a2 implementation clarifications (accepted contract, discovered while building the SQL state machine)

These clarify — never change — the accepted design:

- **Canonical destination fingerprint** = `notif_digest_destination_fingerprint(dest) = sha256(lower(btrim(dest)))`
  (hex). `store` PROVES the frozen request's `to` fingerprints to the group's immutable
  `destination_fingerprint`, and the §PS live re-check proves the CURRENT contact/account destination still
  does. The 10c-b resolver MUST snapshot `outbox.destination_fingerprint` with this same function.
- **`outbox.digest_group_hash`** (immutable, trigger-stamped at enqueue) = sha256 of the canonical key; the
  member scan is `(digest_group_hash, created_at, id)`-indexed (partial on forming rows) — the same-key
  lookup is O(index), never a computed-key scan/sort. Exact-field equality checks are retained beside the
  hash (collision safety). Materialization serializes per key with a NONBLOCKING advisory lock (a busy key
  is skipped, resumed next call) — blocking multi-key acquisition could deadlock two materializers.
- **§PS precision:** `required_delivery` bypasses ONLY `preference_off`. A missing/revoked contact
  (`revoked_at`/`opted_out`/deleted), a CHANGED destination (live fingerprint ≠ frozen), and
  `is_email_suppressed` always stop the member/group, required or not.
- **Correlation gates (§PV/§P6):** a tagged early callback may bind the group's write-once
  `provider_message_id` ONLY when `provider_attempts_started > 0` (a live send exists) — otherwise it stays
  an orphan. `accepted` REQUIRES a non-blank provider id; an accepted id that conflicts with the bound one
  is an invariant breach → attempt annotated + channel manual-hold (`correlation_mismatch`). Orphan→link
  APPLIES the stored outcome exactly once (rank-guarded).
- **Breaker (§CB):** `begin` re-validates the circuit under `FOR UPDATE` (a concurrent re-arm/trip cannot
  race the attempt insert) and count-checks the probe bind. `claim` PREFLIGHTS the circuit before scanning:
  a held/not-due open circuit returns immediately with zero group writes (`available_at` is only ever
  changed by genuine scheduling: quiet-hours/backoff/cap). Reason-aware trips: auth/config +15 m; daily
  quota +coalesce(Retry-After, 24 h); monthly quota / `invalid_idempotent_request` → `retry_at NULL`
  manual hold.
- **Observability:** a lower/equal-rank provider callback is a rank-guarded no-op and writes NO transition
  ledger row (the provider_events row is the audit). Every state-changing RPC asserts its worker run
  (exists, unfinished, right phase + channel); `reconcile` is causal — the LAST ledger action per group per
  run, `superseded` reported as a separate lineage metric.

### Round-4 refinements (same clarifying scope)

- **Breaker linearization point:** send authorization linearizes on the ACQUIRED ROW LOCK of the (always
  ensured) `notification_provider_circuit` row — `begin` first `INSERT … ON CONFLICT DO NOTHING` a `closed`
  row, THEN `SELECT … FOR UPDATE` (a `FOR UPDATE` on a missing row locks nothing, so the first-ever trip
  could otherwise race the attempt insert). Every trip/re-arm serializes through that row.
- **Canonical key = v2, session-independent:** `['v2', channel, recipient_key, destination_fingerprint,
  tenant_academy, tenant_trainer, event_type, template_key, template_version, group_locale,
  digest_frequency, recipient_timezone, epoch_seconds(digest_boundary_at)]`. `recipient_timezone` IS
  identity; the boundary (and counter-key buckets) are epoch-normalized — `timestamptz::text`/jsonb
  serialization depends on the session `TimeZone` and would mint divergent keys. `digest_group_hash` is
  ALWAYS server-derived (caller values overwritten); every canonical input is frozen on digest rows.
- **§PS is resolver-faithful:** the live check RE-RUNS the resolver's email lookup verbatim (ownership by
  person/user/guest + revocation + opt-out + tenant consent scope + global-only-for-account-holders), then
  requires the live destination to fingerprint to the frozen `destination_fingerprint`. `outbox.contact_id`
  is never trusted (its FK is `ON DELETE SET NULL`); frozen data is never a live-deliverability substitute —
  a guest with no live in-scope owned contact stops.
- **One correlation predicate:** `notif_digest_bind_provider_message` gates BOTH the direct callback path
  and orphan linking — a provider message correlates only to a group already bound to that exact id, or an
  unbound group with a LIVE send (`provider_attempts_started > 0`). Never-sent groups reject through every
  path.
- **Run linkage is exact:** group-scoped RPCs require `group.worker_run_id = p_run_id` (+ `locked_by`), and
  `record` requires `attempt.worker_run_id = p_run_id` — the worker that made the HTTP call is the only one
  holding its outcome; crash recovery begins a NEW attempt, never records an old one. `assert_run` holds the
  run row `FOR UPDATE`, so a transition in flight blocks a concurrent `finish` (and vice versa).
- **Frozen request allow-list:** exactly `to/subject/html` — any other key (bcc/cc/headers/attachments/
  unknown) is rejected at `store`, since the worker dispatches the stored request verbatim.

### Round-5 refinements (same clarifying scope)

- **Cap buckets are fixed-zone:** hour/day buckets are `date_trunc(..., p_now AT TIME ZONE 'UTC') AT TIME
  ZONE 'UTC'` — `date_trunc` on a `timestamptz` truncates in the SESSION `TimeZone`, so differently-zoned
  workers would otherwise mint different day buckets and split the cap. One instant → one counter key,
  session-independent.
- **Breaker result transitions are CAS:** `record` decides probe-ness UNDER the circuit row lock and every
  probe transition is a compare-and-swap on the exact `state='half_open' AND probe_attempt_id=<attempt>`.
  A superseded probe result (a replacement bound, or the breaker re-armed) only annotates its attempt —
  it can never close/trip/re-arm the replacement breaker.
- **Correlation = capable-of-acceptance:** an unbound group may correlate a provider message ONLY while an
  attempt exists that is unrecorded (in flight / crashed pre-record) or recorded `ambiguous`. Definitive
  non-accepted outcomes (`terminal`/429/`global_config`) never produced a message id — cumulative
  `provider_attempts_started` is NOT evidence. Applied identically to direct callbacks and orphan links.
- **Uncertainty clocks are atomic:** every path that sets `uncertain_since` sets `uncertain_deadline_at`
  (= now + 23 h) in the same statement — including the stale-`sending` reclaim; `awaiting_evidence` can
  never be minted with a NULL deadline (which a `coalesce(NULL, now)` would age out instantly).
- **Identity is fully schema-owned:** `digest_group_hash` is re-derived whenever a row IS or BECOMES
  digest (caller values overwritten on promotion too); the timezone is normalized
  (`coalesce(recipient_timezone,'Europe/Amsterdam')`) before hashing so NULL and the explicit default mint
  one identity; a digest row missing `recipient_key`/`destination_fingerprint`/`digest_frequency`/
  `digest_boundary_at` is rejected; and the live-recipient identity (`recipient_person_id`/`recipient_user_id`/
  `recipient_guest_player_id`/`destination_normalized`) is frozen alongside the canonical inputs.

### Round-6 refinements (same clarifying scope)

- **Structural freeze:** once a row IS digest, every canonical + live-recipient field is frozen under plain
  `IS DISTINCT FROM` — NULL→value and value→NULL included (an `OLD IS NOT NULL` qualifier let a NULL
  timezone or recipient id be added after the hash was derived).
- **The uncertainty window anchors to the FIRST HTTP dispatch:** `uncertain_deadline_at =
  coalesce(existing, first_send_at + 23 h)` everywhere (the frozen provider idempotency key's dedup window
  starts at first use, not at crash discovery). Recovery at/after that deadline finalizes
  `delivery_unknown` — the group is never handed back sendable, so a re-POST can never fall outside the
  provider's dedup window and duplicate delivery.
- **Split ordinal allocation linearizes on the SAME canonical-key advisory lock as materialization**
  (`pg_advisory_xact_lock(hashtext(group_key_hash))`) before `max(chunk_ordinal)+1`; `p_max_items_per_child`
  is validated 1..50.
- **Promotion exception:** on the null→digest promotion the hash-stamp trigger rewrites
  `digest_group_hash` server-side; the write-once guard permits exactly that schema-owned rewrite (the
  stamp runs first, so what lands is always derived) — every caller mutation, before or after promotion,
  stays forbidden.
- **Every terminal transition clears `current_attempt_id`** (the shared finalizer + the awaiting_evidence
  paths) — a completed group holds no attempt ownership.
- **Breaker precedence:** positive CORRELATED provider evidence that already completed the group's dispatch
  dominates a late probe transport failure — the probe's send demonstrably reached the provider, so a late
  timeout CAS-closes the breaker instead of re-opening it. Stale non-positive results still annotate only.

### Round-7 refinements (same clarifying scope)

- **The 23-hour uncertainty window is an INVARIANT, not a tunable.** `p_uncertainty_hours` is removed from
  every RPC; the deadline is always `notif_digest_uncertainty_deadline(first_send_at, existing) =
  least(existing, first_send_at + interval '23 hours')` — it can never widen, and it FAILS CLOSED (raises)
  if a post-dispatch group lacks `first_send_at` rather than starting a fresh window at recovery time.
- **Table write model: the eight state-machine tables are `service_role` SELECT-only.** Every write goes
  through the SECURITY DEFINER RPCs (which run as the table owner); `INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/
  REFERENCES` are revoked from `service_role`. 10c-a3's worker + webhook must drive the machine through the
  RPCs — no direct table writes. Belt-and-braces, an owner-effective `notification_digest_send_identity_guard`
  freezes the duplicate-send-safety fields even against a buggy internal caller: `first_send_at` set once
  then immutable; `provider_idempotency_key`/`request_hash` immutable once set; `frozen_request` only
  NULL→value (store) or value→NULL (scrub); `uncertain_deadline_at` never beyond `first_send_at + 23h` and
  never moves later.
- **Any correlated provider callback dominates a late probe transport timeout.** A callback of ANY status —
  sent/delivery_delayed/delivered/complained OR bounced/failed/suppressed — proves Resend accepted and
  processed the request (`provider_status_rank >= 1`), as does an HTTP-accepted rollup. A late ambiguous
  probe result therefore CAS-closes the exact probe (state='half_open' AND probe_attempt_id) instead of
  re-opening the breaker, preserving the callback-derived group/member outcome (sent OR failed_terminal).
- **Every operational bound is a server-enforced maximum, validated NULL-safely** via
  `notif_digest_require_range` (NULL / below-min / above-max all raise): split items 1..50, materialize
  groups 1..1000 + members 1..10000, claim stale-minutes 1..1440, begin hour-cap 1..1e6 + day-cap 1..1e7,
  sweep probe-lease 1..1440 + limit 1..10000. "Bounded" means a hard server ceiling, not a caller LIMIT.

### Round-8 refinements (same clarifying scope)

- **RPC allowlist:** EXECUTE is granted to `service_role` ONLY on the operational entrypoints
  (start/finish_worker_run, materialize, claim, prepare, split, store, begin, record,
  reconcile_run/reconcile_stale, apply_provider_event, link_provider_event). Every `notif_digest_%` helper
  and the trigger functions are EXECUTE-revoked from PUBLIC/anon/authenticated/**service_role** — the
  top-level SECURITY DEFINER RPCs invoke them as the owner, so a forged direct call (e.g. `SET ROLE
  service_role; SELECT notif_digest_trip_breaker(...)`) that would bypass run/ownership/attempt/ledger
  invariants is denied.
- **Digest content is server-owned:** `digest_item_bytes` is derived in the DB (`octet_length(digest_item::
  text)`) on every digest insert/promotion — a caller count is silently corrected. `digest_item` is
  write-once (scrub to NULL only, at terminal member finalize) and the count is immutable once derived, so
  the 50-item/90 KB budget can't be gamed and content can't change after grouping.
- **Send-identity INITIALIZATION is transition-scoped, not just mutation:** `provider_idempotency_key`
  (= `dg:v1:<id>`) / `request_hash` (= sha256(frozen_request)) / `frozen_request` may go NULL→value ONLY
  during `prepared→request_ready`; `first_send_at` NULL→value ONLY during `request_ready→sending` with a
  bound `current_attempt_id`; `frozen_request` value→NULL ONLY during a terminal transition. A one-statement
  forged populate on a pending/leased group is rejected.
- **Retry-After is clamped:** `notif_digest_retry_after_interval(secs)` returns the interval only for
  0..604800 (7 days), else NULL → the caller's documented fallback (24 h for daily quota; the exponential
  backoff floor for a plain retryable). A negative value can never set `retry_at` in the past, and an
  extreme value can never pause delivery for years.

### Round-9 refinements (same clarifying scope)

- **digest_item is an immutable enqueue-time snapshot.** A digest row (insert or promotion) MUST carry a
  non-null `digest_item` (the hash-stamp trigger enforces it alongside the other snapshot fields);
  `digest_item` can NEVER be attached (NULL→value) or rewritten (value→different value) afterward; it may be
  scrubbed (value→NULL) ONLY when the member is atomically entering a documented terminal outbox status
  (`sent`/`delivered`/`failed`/`skipped`/`cancelled`/`delivery_unknown`). `digest_item_bytes` stays derived
  and immutable (retained after scrub).
- **Uncertainty age-out is an INDEPENDENT no-send reconciliation transition.** `reconcile_notification_
  digest_stale` ages out ANY uncertain group (`request_ready | sending | awaiting_evidence`) at/after
  `least(uncertain_deadline_at, first_send_at + 23 h)` → `delivery_unknown`, committing its reservations and
  creating no attempt, and NEVER reading or writing the breaker. So a manual channel hold / quiet hours /
  caps / retry-ineligibility can no longer keep an uncertain group (and its committed capacity) alive past
  the deadline. Backed by a partial index `idx_digest_groups_uncertain_ageout (channel, first_send_at)
  WHERE uncertain_since IS NOT NULL AND state IN (request_ready, sending, awaiting_evidence)`.
- **All uncertain scheduling is capped at the deadline.** Every uncertain `available_at` computation
  (retryable, ambiguous, global_config, quiet-hours, breaker defer) is `least(computed,
  coalesce(uncertain_deadline_at, 'infinity'))` — a valid seven-day `Retry-After` can never push a retry
  past `first_send_at + 23 h`; reaching the deadline ages out (via the independent sweep) instead of sending.
- **The `prepared → request_ready` transition enforces request-tuple completeness atomically** — non-null
  `frozen_request`, `provider_idempotency_key = dg:v1:<id>`, and `request_hash = sha256(frozen_request)` are
  checked on the transition itself (not field-by-field), so a state-only move that would strand a malformed
  group is rejected.

### Round-10 refinements (same clarifying scope)

- **One shared request validator.** `notif_digest_validate_frozen_request(frozen, destination_fingerprint)`
  enforces the exact `to/subject/html` allow-list, non-empty strings, the ≤92160-byte ceiling, and
  `to`↔fingerprint equality. It is invoked by BOTH `store_notification_digest_request` AND the send-identity
  guard's `prepared → request_ready` transition — so a direct owner-context update carrying a complete
  tuple (matching key + hash) but a wrong recipient or an extra `bcc` is rejected at the trigger, not just
  in the store RPC.
- **The age-out scan is work-bounded.** The uncertainty clocks are a structural PAIR — enforced at both
  INSERT and UPDATE by a table CHECK (round-11): either both NULL, or both set with `first_send_at` present —
  so `uncertain_deadline_at` alone is
  the canonical due field. The partial index is `idx_digest_groups_uncertain_ageout (channel,
  uncertain_deadline_at) WHERE uncertain_since IS NOT NULL AND state IN ('request_ready','sending',
  'awaiting_evidence')`, and the sweep scans `uncertain_deadline_at <= p_now ORDER BY uncertain_deadline_at
  LIMIT p_limit`. At 100k future-only uncertain groups the index range bound scans/filters ~0 rows (not a
  full O(N) filter).
- **`claim_notification_digest_group`'s quiet-hours defer is capped too.** Its `available_at` is
  `least(v_bump, coalesce(uncertain_deadline_at, 'infinity'))`, so an uncertain group whose next allowed
  send window is after its 23-hour deadline is scheduled to the deadline (then aged out by the independent
  sweep), matching the "every scheduling branch is capped" contract.

### Round-11 refinements (same clarifying scope)

- **No deadline hot-loop.** `claim_notification_digest_group` ages out ANY selected uncertain group whose
  deadline is already past (`uncertain_since IS NOT NULL AND p_now >= uncertain_deadline_at`) → finalize
  `delivery_unknown`, commit reservations, one outcome ledger event, continue — BEFORE the quiet-hours /
  breaker deferral branches. Otherwise a deadline-past uncertain group in quiet hours would be deferred to
  `least(bump, deadline)` = the already-due deadline, re-selected, and loop until the `v_iter` cap (one call
  emitting 200 `deferred` rows). This age-out is the same one the independent sweep performs, now reachable
  from the send path too.
- **The uncertainty-clock pair is an owner-effective table CHECK** (not just the UPDATE trigger):
  `notification_digest_groups_uncertainty_pair_check` = `(both clocks NULL) OR (both set AND first_send_at
  IS NOT NULL)`. It covers direct INSERTs (which a `BEFORE UPDATE` trigger cannot), so a half-pair or a
  clocks-without-first-send row can never enter the age-out index and leak.

### Round-12 (test-only)

- The 100k age-out scale test EXPLAINs the RPC's OWN candidate query: it extracts the `FOR g IN SELECT …
  FOR UPDATE SKIP LOCKED` block from `pg_get_functiondef(reconcile_notification_digest_stale)`, parameter-
  substitutes it, and EXPLAINs that exact SQL (not a hand-copy). The fixture seeds 50 DUE + 100k FUTURE
  uncertain groups, so the assertion pins the named index node's deadline `Index Cond`, `Actual Rows` = the
  due count (50), and nested `Rows Removed by Filter` < 100 — a filtering-predicate/order/index change to the
  deployed RPC drops the due-row count and fails the test. The trigger disable/enable around the bulk seed is
  wrapped in try/finally so a failed seed can never leave the guards disabled for later tests. No production
  SQL behavior changed.

## 10c-a3 — the WORKER (edge function + adapter), still INERT

The state machine (10c-a2) is a set of SQL RPCs; 10c-a3 adds the thin, bounded driver that calls them, plus the
single-shot Resend adapter and the render. **Nothing here enables a send:** the `notification-digest-worker`
edge function returns immediately unless `DIGEST_SEND_ENABLED === "true"` AND it is configured, no cron is
scheduled, and no `digest_engine_enabled` event exists. Enabling is a later, separately-reviewed, owner-gated
10c-b step. The following is the AUTHORITATIVE contract (it supersedes any earlier draft description).

- **STATE-AWARE dispatch (`_shared/digest-worker-core.ts`), RPC-only.** `claim` does NOT normalise groups to
  `leased` — it hands a group back in its DUE state, and each RPC accepts exactly one input state
  (`prepare`←`leased`, `store`←`prepared`, `begin`←`request_ready`). So after claim the worker reads the owned
  group's state and drives the right step:
  - `leased` → `prepare` → render surviving members → (split | terminalize-oversize | `store`) → `begin` → send
  - `prepared` → render → (…) → `store` → `begin` → send  (crash recovery: prepared but never stored)
  - `request_ready` → `begin` → send the PERSISTED frozen request, **NO re-render / re-store**  (a RETRY: 429 /
    ambiguous / stale-sending recovery / half-open probe all return here; `begin` mints a fresh `attempt_id` but
    reuses the immutable `frozen_request` + `dg:v1:<group>` key, so every retry re-POSTs the identical request
    under one idempotency key → provider-side dedup)
  - any other claimed state is impossible for an owned group → treated as a group error.
  Exactly ONE `sendResendEmailOnce` per attempt; the worker issues NO direct writes to any digest table (every
  transition is an RPC) and is bounded by explicit limits (materialize groups/members, max claim iterations,
  sweep limit) + a wall-clock budget. One dispatch run wraps it: sweep (`reconcile_notification_digest_stale`)
  → `materialize` (its own run/phase) → the claim loop → reconcile → finish.
- **The COMPLETE provider request is frozen: `{from,to,subject,html}`.** `from` (sender identity) is frozen
  alongside the body so a deploy that changes the platform default cannot alter an already-stored request
  within its 23-hour idempotency window; `request_hash` covers all four fields. The one validator is split:
  `notif_digest_validate_frozen_request_shape` (object + `{from,to,subject,html}` allow-list + non-empty +
  `to`↔fingerprint, no byte cap) and the byte-bounded `notif_digest_validate_frozen_request` (= shape + ≤90 KB),
  both invoked by `store` and the send-identity guard.
- **Every provider request carries the `digest_group_id` tag (§PV/§P5)** — `tags:[{name:digest_group_id,
  value:<group_id>}]` — so a delivery/bounce callback arriving BEFORE `record` can still correlate an in-flight
  send. The adapter makes the tag mandatory (a required arg), so no send path can omit it.
- **`finalize_notification_digest_render_oversize`** (migration `20261005100000`) terminalizes a RENDERED
  single-item group over budget as `oversize_failed` / `render_oversize`. It takes the authoritative rendered
  request and PROVES oversize server-side: exactly `prepared` (NOT `request_ready` — a retried group can hold
  reservations that terminalizing would strand), exactly one surviving member, valid shape+destination, and
  `octet_length(jsonb::text) > 92160`. Small / wrong-destination / multi-item / non-`prepared` calls all RAISE.
  service_role EXECUTE only.
- **Truthful runs + reconciliation.** A per-group failure — including a `record` failure that lands AFTER the
  send, or an impossible missing-frozen / zero-member / unexpected-state — is caught and counted, and the group
  is left to the state machine's crash/stale recovery (the live-but-unrecorded attempt is reclaimed next tick →
  uncertainty); it is never re-sent inside the worker. But it makes the run unhealthy: a run with ANY group
  error finishes the dispatch run `failed` → status `error` → HTTP 500 (a failed group is never reported as a
  healthy 200), while independent groups keep processing. EVERY started run — materialize AND dispatch, on both
  success and failure paths — is reconciled via `reconcile_notification_digest_run` **best-effort** (reconcile
  never throws, so it can't mask the original error, and never recurses); run IDs + dimensional
  `(family,metric,count)` metrics are logged. But reconciliation is what makes a run **operationally provable**,
  so a reconcile OUTAGE is not a silent no-op either: it is counted (`reconcileErrors`), fails the affected run
  (a materialize whose reconcile fails is finished `failed`), and fails the invocation (`status error` → HTTP
  500 + the one alert) — a reconcile failure never reads as a healthy 200. A run-level throw is wrapped in a
  `DigestWorkerError` that preserves the original exception (message + an own `originalError` field — not the
  ES2022 `Error.cause`, which is absent from the app's tsc lib target) and carries a PII-free partial summary,
  so the proactive alert keeps the run IDs + counts even on a thrown failure. A true process death leaves the
  run unfinished for crash recovery.
- **Endpoint contract (auth is fail-closed and runs FIRST).** `requireServiceRole` gates the request BEFORE any
  config read or DB access, so the status matrix is: **401** (no/invalid service-role auth — including a missing
  `SUPABASE_SERVICE_ROLE_KEY`, which cannot be validated) → **200 `disabled`** (switch off, zero DB) → **500
  `misconfigured`** (switch on but `RESEND_API_KEY`/`SUPABASE_URL` missing, zero DB) → **200 `ok` / 500 `error`**
  (ran). A misconfiguration and every unhealthy run fire ONE best-effort Slack alert per invocation with safe
  IDs/counts only (never per group). **Backstop:** the in-worker Slack alert itself needs the service-role key,
  and a totally-unconfigured function 401s before it runs — so the durable safety net for "the function is
  broken/misconfigured" is EXTERNAL cron/uptime monitoring on the scheduled invocation (a non-200, or no
  invocation at all), NOT the in-worker alert. This must be wired when the cron is scheduled in 10c-b.
- **PII-safe logs.** Logs carry only IDs / states / counts / redacted error labels. Thrown-error labels pass
  through `redactDetail` (strips emails / tokens / JWTs / ids / URL queries, length-bounded), so even an error
  message that echoes a recipient address cannot reach the logs. The adapter's `error_name` is a machine-name
  allow-list → `http_<status>` otherwise; the free-text provider `message` (which can contain a recipient
  address) is never surfaced.
- **No session-scoped cron lock.** The old `try_lock_cron_job`/`unlock_cron_job` pair (session-level
  `pg_try_advisory_lock`) spanned two pooled PostgREST requests with no session affinity, so the unlock could
  land on a different backend and wedge the lock indefinitely. This worker does not use it — the atomic `claim`
  (`FOR UPDATE SKIP LOCKED` + ownership stamp) is the concurrency boundary. The four v1 workers that still use
  that lock are tracked as a separate hardening item (see below); it must move to an atomic-claim or durable
  owner-token/expiry lease before 10c-b enables the digest cron.
- **Correctness fix (migration `20261005110000`) — `expr::text::bytea` → `convert_to(expr::text,'UTF8')`.**
  Every request/canonical-key hash in the deployed (inert) `20261004100000` cast text to `bytea`, which runs
  the bytea INPUT function and INTERPRETS backslash escapes. A jsonb `::text` of any real frozen request
  contains `\"` (HTML has quoted attributes), so `sha256(frozen_request::text::bytea)` raised `invalid input
  syntax for type bytea` — store/guard would have rejected EVERY genuine email. The 10c-a2 suite only stored
  `<p>x</p>` (no quotes), so it never surfaced. Fixed as a CLASS across all hash sites (hash-stamp trigger,
  materialize fallback, store, send-identity guard, destination fingerprint); `convert_to(…,'UTF8')` takes the
  text's raw UTF-8 bytes with no escape interpretation, byte-identical to the old cast for all backslash-free
  text, so every existing hash VALUE is preserved. Forward-only CREATE OR REPLACE; privileges/triggers persist.

## 10c-a3 deployment runbook + credential contract

**Credential contract (as verified in production).** The worker self-authenticates in `requireServiceRole` with
a byte-for-byte compare of the request's `Authorization: Bearer <token>` (or `apikey`) against the function's
injected `SUPABASE_SERVICE_ROLE_KEY` — which is the **LEGACY service-role JWT** (`eyJ…`), NOT a new `sb_secret_`
key. The cron sends exactly that legacy JWT, read from Vault (`vault.decrypted_secrets.service_role_key`) at
tick time as the Bearer, identical to `20260722100000_rebook_crons_use_vault.sql`. The NEW `sb_secret_` keys
live in `SUPABASE_SECRET_KEYS` and are transmitted via the `apikey` header (per the Supabase new-API-keys docs);
they do **not** replace `SUPABASE_SERVICE_ROLE_KEY` and are not what this function checks. `verify_jwt=false` so
the request always reaches the function's own guard (and stays correct if auth is ever moved to a non-JWT
`apikey` path). **Recommendation:** retain this verified legacy-JWT Vault path for the initial cron enablement;
any move to a named secret-key / custom worker-secret path should be a separate, reviewed migration, not folded
into enablement.

**Authenticated "disabled" smoke test — for the INITIAL INERT rollout only** (switch off, no cron, no digest
rows). It proves the freshly-deployed worker is callable and writes nothing, BEFORE anything is enabled. Invoke
through the exact Vault/pg_net path — no cron, secret never leaves the server:

```sql
-- fire it (returns a pg_net request_id)
SELECT net.http_post(
  url := 'https://<project>.supabase.co/functions/v1/notification-digest-worker',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')
  ),
  body := '{}'::jsonb
) AS request_id;

-- read the response (status + body only — never select request headers)
SELECT status_code, content FROM net._http_response WHERE id = <request_id>;
```

Acceptance (initial inert rollout) = **HTTP 200** with body exactly `{"status":"disabled","reason":"disabled"}`,
followed by **zero** new rows in `notification_worker_runs`, `notification_digest_groups`, and
`notification_outbox WHERE delivery_mode='digest'` — absolute-zero is valid ONLY because production has no
digest history yet. If it returns **401**, STOP: the function's `SUPABASE_SERVICE_ROLE_KEY` and the Vault
`service_role_key` have diverged (e.g. a key rotation) — check whether the existing Vault-backed rebook / email /
WhatsApp crons are also 401ing, and fix the credential source; do not rotate or modify any credential without
owner approval. Never print the secret, its hash, prefix, or length.

**Future LIVE redeploys (once the cron is scheduled / an event is enabled) — do NOT use the absolute-zero test
above.** By then the tables hold real digest history, so absolute-zero is meaningless. The 10c-b enablement
runbook (to be written when the cron lands) must instead:
1. **Pause the cron reversibly** with `cron.alter_job(jobid, active := false)` — **never** `cron.unschedule`,
   which DELETES the stored Vault-backed command + schedule (this repo's established reversible mechanism is
   `alter_job`). If sending is on, also set `DIGEST_SEND_ENABLED=false`.
2. **Confirm quiescence of the ACTIVE invocation only:** the digest job exists exactly once with `active=false`,
   and no `cron.job_run_details` row is currently `running`. Wait only for the active worker invocation to
   finish, bounded by the worker/network runtime — do **NOT** wait for uncertain groups to "age out": an
   uncertain persisted group is durable state-machine state, not a running process, and must survive the deploy
   unchanged (it does not block deployment).
3. **Capture baseline counts**, then deploy.
4. **Invoke through the Vault/pg_net path** and — because `DIGEST_SEND_ENABLED` is off — require **exactly**
   `HTTP 200 {"status":"disabled","reason":"disabled"}` with **zero count deltas** vs baseline. Do **not** call
   `reconcile_notification_digest_run` for this disabled smoke test: a disabled invocation creates no worker
   run, so there is no run id to reconcile. (Only after a SEPARATELY-approved re-enable / canary does reconcile
   apply — and then against the ACTUAL run ids the enabled worker returns, never as a before/after snapshot.)
5. **Re-enable (a separate, ordered step — not "after post-enable verification", which is circular).** With the
   cron still **inactive**: (a) obtain explicit **owner approval**; (b) enable the switch (`DIGEST_SEND_ENABLED
   =true`); (c) run **one controlled canary** manually (a single Vault/pg_net invocation, cron still off);
   (d) **reconcile that canary's ACTUAL returned run id(s)** and verify the outcome; (e) resume the cron with
   `cron.alter_job(jobid, active := true)` **only after the canary succeeds**. On any failure: set the switch
   **off** and leave the cron **inactive**.
Never assert absolute-zero tables against a live system, and never delete the Vault-backed job to "pause" it.

## 10c-b D — the notify-followers cutover: deploy ORDER is part of the design

`notify-followers` moved from "POST send-email per follower, dedup in `notification_sends`" to
"`enqueue_notification('open_slots_player')` per follower, dedup on the resolver's
`<event>:<subject>:<recipient>` key". The two versions therefore keep their bookkeeping in two
different ledgers, and the frontend and the edge function do not deploy at the same instant. Three
consequences follow, and two of them cannot be closed by code alone.

**Deploy order (required).** Migrations → **frontend** → wait out the bundle-cache window →
**edge function**. Pushing the edge function first is the one order that leaves cached pages
sending a request shape the new handler must interpret rather than trust.

1. **Cross-version dedup — ONE-WAY, and that asymmetry is the design.** The new handler RECORDS
   the pre-cutover key in `notification_sends` for every recipient it handled, so a ROLLBACK to
   the old handler usually finds the key claimed and does not send a second copy. A `failed`
   recipient is never recorded — it still needs notifying.

   That rollback protection is **best-effort, not a guarantee**, and the ordering says why: the
   marker is a second statement, not part of the enqueue. If the enqueue succeeds and the marker
   write fails — or a rollback routes a retry into the window between them — the old handler can
   claim and send while the durable v2 row also sends. So the residual runs in BOTH directions,
   and a rollback of the edge function is an operator action that must observe the same quiesce as
   the roll-forward.

   The marker is therefore repaired **in the run that created the row, or not at all**: the write
   is retried up to three times on the spot, because no later pass can fix it — a re-run answers
   `no_row` for an already-enqueued recipient, and `no_row` is not markable. What survives that is
   counted, returned as `legacy_marker_failed`, and logged by the caller. It is deliberately NOT
   treated as incompleteness: that would send the caller into a retry that provably cannot help.

   It deliberately does **not** read that ledger to skip anyone. A legacy row is a claim taken
   BEFORE the pre-cutover send, and the old handler deleted it again when the send failed, so a
   surviving claim means "sent" *or* "the invocation died between claiming and sending" — and a
   deploy is precisely what kills an in-flight invocation. There is no send ledger to corroborate
   against (`send-email` records nothing durable for these types; only `notification_queue`, for
   daily/weekly). Honouring an unconfirmed claim would drop a follower AND report the run
   successful, which is the failure class this slice exists to remove. The residual is therefore a
   DUPLICATE in either direction — an old-handler send followed by a retry of the same batch that
   lands on the new handler, or (when the marker write did not land) a v2 enqueue followed by a
   rollback — bounded in both cases by the deploy order above. A duplicate is the failure we
   carry; a silent miss is not. The recording half is transition-only and is removed with the rest
   of the compatibility branch.
2. **The legacy display range is ambiguous for multi-year batches (closed operationally).** The
   pre-cutover format printed the year only on the right: `Jan 1 - Jan 2, 2027` is what BOTH
   2027-01-01..2027-01-02 and 2026-01-01..2027-01-02 print, and the bulk-slot form can produce
   either (several entries, each recurring up to 52 weeks, with unrelated start dates). Current
   bundles now print **both** years whenever they differ, so nothing this app emits is ambiguous.
   A CACHED pre-cutover bundle can still emit the old shape; it is parsed to the shortest
   non-negative span, which is exact for every sub-year range (including a same-month 52-week
   series such as `Jan 10 - Jan 2, 2027`, which the previous month-only rollover test rejected
   outright) and short for a multi-year one. Waiting out the cache window before deploying the
   edge function is what removes that last case.
3. **A cached bundle ignores an incomplete run (closed in code, server-side).** The pre-cutover
   caller never inspected the response, and the pre-cutover HANDLER answers 200 even when it
   deferred recipients or hit send errors. So the run drains its own tail: on a deferred tail it
   chains a bounded continuation of itself carrying a keyset cursor, forwarding the caller's own
   Authorization header so the hop re-derives the same trainer and gains no privilege.

   The cursor measures DISCOVERY and nothing else. A recipient whose enqueue failed is owed a
   retry, and that is carried as an explicit, capped set of ids rather than by holding the cursor
   back — holding it back conflated the two jobs, cost a hop or two per failure, and let enough
   failures exhaust the hop cap before the undiscovered tail was ever reached. Only a FRESH
   failure is carried, and the retry is bound to an identity rather than a position, so a
   recipient cannot have someone else's attempt spent for it. Retries are processed LAST, after
   discovery, so the one chunk a hop is guaranteed to run always advances the cursor.

   TERMINATION is the cursor's, not the retry set's. A hop whose discovery work fills the budget
   carries the same retry set on unchanged — what it cannot do is stand still. Once discovery is
   exhausted the hops are all retries and the set drains; if the hop cap arrives first, the
   survivors are reported as `deferred`. The tail and the retry set are bounded by the same cap,
   so neither starves the other.

   A recipient therefore gets **at most** two attempts, and the exceptions are named rather than
   implied: more simultaneous failures than the carry cap (`retries_not_carried` in the response),
   and a chain that reaches the hop cap with retries still owed (`deferred` in the response). Both
   are reported; neither is silent. Retry ids are also authorised on every hop against the
   trainer's currently enabled follower rows, so the set can carry no authority of its own. The
   current caller ALSO judges completeness from the response body (`remaining` / `errors` on the
   old shape, `incomplete` / `failed` / `deferred` on the new one) and retries, so client retry
   and server continuation are independent lines of defence.

**Preference bridge.** `notification_preferences.open_slots_digest` mirrors forward into
`notification_preferences_v2(open_slots_player)` for as long as the v1 column exists. The trigger
is created in the SAME migration as the one-time backfill and BEFORE it: `CREATE TRIGGER` holds a
lock on the table until the migration commits, so there is no instant at which a v1 write is
recorded by neither. The mirror is one-way (v1 → v2).

An UPDATE applies only when the column actually changed, so an unrelated write cannot resurrect a
stale cadence. An INSERT is resolved by VALUE, because the two cases it covers pull in opposite
directions: the settings page upserts a partial row in which `open_slots_digest` takes its column
default of `weekly`, which must never overwrite an explicit v2 `off`; but a user can also hold a
v2 row and no v1 row at all, in which case a cached page's genuine opt-out arrives as an INSERT
and must apply. `weekly` is exactly the column default and therefore ambiguous, so it only ever
SEEDS; `off` / `instant` / `daily` cannot be produced by the default and therefore apply.

The residual is a genuine `weekly` choice made on a cached page being lost when a v2 row already
exists — and over an existing `instant` or `daily` that leaves MORE mail than the user asked for,
not less. It is accepted deliberately: the alternative differs in kind rather than degree, because
a `DO UPDATE` here would let the incidental default overwrite an explicit `off` and resume mail
after an opt-out. A wrong cadence is still consented mail; mail after an opt-out is not.

## 10c-b J — the bridge is TWO-way, because the deploy order opens the other direction too

One-way was not enough, and the gap is manufactured by the deploy order documented immediately
above. `Migrations → frontend → wait out the bundle cache → edge function` puts the NEW settings
page live first and then waits on purpose. That page no longer carries an `open_slots_digest`
control at all, so a player changing their open-slots cadence in that window writes **only**
`notification_preferences_v2` — while the still-deployed OLD `notify-followers` keeps POSTing
`send-email`, which maps `new_availability`/`slot_reopened` onto the v1 column and enforces it
(`off` suppresses, `daily`/`weekly` queue). The player sees "Saved" and keeps receiving mail.

(`notify-followers` never read `open_slots_digest` itself. Its own filter read
`notification_preferences.email_new_availability`, a column dropped in `20260210090026` whose
error was discarded, so that filter was silently inert. The live v1 reader in the window is
`send-email`, reached *through* the old `notify-followers`.)

So `20261013100000` adds the reverse mirror. Scope is exactly one event key onto exactly one legacy
column, email only — `whatsapp_frequency`/`push_frequency` have no v1 counterpart.

**The INSERT ambiguity is mirror-imaged, not absent — and it has TWO sources, not one.** The
forward direction defends against a partial legacy row whose `open_slots_digest` took its COLUMN
default. On the v2 side the platform can supply an unchosen `email_frequency` two ways:

1. the **catalog** default — `saveEvent()` always writes both channel columns, computing the one the
   user did not touch from `effective()`, which falls back to `default_email_frequency`; and
2. the v2 **column** default — `notification_preferences_v2` is granted INSERT to `authenticated`
   with an own-rows policy, so a row can be created through the table API without naming
   `email_frequency` at all.

`notif_pref_open_slots_incidental_values()` derives both (never hard-coded, or the rule would
silently invert the day a default moved) and a reverse ARRIVAL only ever SEEDS a value in that set.

Two refinements the review forced, both about **provenance**, and both resolved the same way — when
you cannot prove a value was chosen, seed rather than apply:

* **A RETARGET carries no reconstructable provenance at all.** Moving a row onto this event brings a
  value stored under another event's default; reading that default *as it is now* is wrong, because
  an admin may have changed it since. There is no provenance column to reconstruct it from. So a
  retarget treats **everything except `off`** as incidental. `off` needs no provenance: applying it
  suppresses mail, which is safe whatever its origin.
* **An UNPARSEABLE column default fails SAFE.** `pg_get_expr` renders a literal default as
  `'instant'::text`, which the extractor reads; a valid non-literal default such as
  `lower('INSTANT'::text)` it cannot. Returning only what parsed would fail OPEN — the real
  incidental value would be missing, so a partial insert carrying it would read as explicit. An
  unreadable default therefore degrades to the same conservative set.
Which arm is live matters and the first draft of this got backwards: `open_slots_player` ships
`supports_whatsapp = false` and the page renders the WhatsApp switch only where supported, so **the
catalog arm is currently unreachable and the column arm is the live one**. The catalog arm is kept
because Stage 8 turns WhatsApp on. A plain CHANGE to a row already at this (user, event) needs no test: a same-channel-only save rewrites
`email_frequency` unchanged and the no-change short-circuit drops it, so a *changed* value on UPDATE
is always an explicit email choice. `off` is excluded from the incidental set **unconditionally** —
not because it happens not to be a default today, but because suppressing mail is safe whether it
was chosen or inherited, so an opt-out always applies. That is the case the contract actually names.

**Departures mirror too, but never at the cost of an opt-out.** Losing the v2 row (DELETE, retarget
away, or reassignment to another user — all reachable through the granted table API, none through
the UI) makes the effective v2 preference the catalog default while v1 keeps the departed value. The
first draft declined to mirror that at all, arguing any mirror could resume mail; the premise was
right and the conclusion too strong. The rule is now stated as suppression, not as a token: **a
departure may never make the legacy reader send MORE than it does now.** So it refuses when the
departing value is `off` and the target is not, and never un-suppresses a legacy `off` — but when the
catalog default is *itself* `off` it applies, because that suppresses. UPDATE-only, never INSERT, so
account teardown stays a no-op: `delete-user-data` removes v1 explicitly and v2 cascades from
`auth.users`, after which the mirror matches nothing.

**Existing state is reconciled, not only future writes.** A trigger sees nothing that already
happened, so the migration ends with one bounded, idempotent reverse reconcile using the trigger's
own rules. The population is nearly always empty — `open_slots_player` is branch-only, so no
production user can hold a v2 row for it — but not provably so: one `supabase db push` applies its
migrations in sequence, the already-deployed settings page reads the catalog dynamically, and C's
backfill is `ON CONFLICT DO NOTHING`. A user quick enough to save between `20261008100000` and
`20261013100000` would otherwise have their choice stranded *because* they were quick. It also makes
the migration correct on any environment that already holds v2 rows.

**The reverse mirror made an existing trigger privileged, so that trigger was hardened.** Writing v1
from a `SECURITY DEFINER` function means `validate_notification_frequency()` now runs with the
definer's rights, and its body is `EXECUTE format(...)` under `SET search_path TO 'public'` — an
unqualified call inside a dynamic EXECUTE, which is the shape slice I showed is capturable. Measured
rather than assumed: on this project no application role can create the rival, because
`public`'s ACL grants CREATE only to `pg_database_owner`
(`has_schema_privilege('authenticated','public','CREATE')` is false). It is closed anyway, since
this migration is what makes the path privileged. `SECURITY INVOKER` was rejected as the alternative:
no migration grants `authenticated` DML on `notification_preferences`, so an invoker-rights bridge
would turn a preference save into a hard error rather than a mirrored write.

**Recursion.** Two mirrors ping-pong, and Postgres does not detect it — it recurses until the stack
is gone. The guard is a transaction-local GUC (`notif.pref_bridge_hop`) set only around each
bridge's own nested write, checked by both directions. `pg_trigger_depth()` was rejected: it
suppresses the bridge whenever the write arrives from *any* trigger, including a future unrelated
one, and it fails OPEN — the mirror stops and a preference silently stops propagating.

The reverse direction ALSO writes distinct-only (`WHERE ... IS DISTINCT FROM EXCLUDED`). That is
deliberate redundancy, and it is worth knowing that the two protections **mask each other**:
neither is observable in the final state while the other stands. The mutation pins therefore remove
them in the combinations that actually bite, and one POSITIVE CONTROL proves the pin that removes
only the predicate fails for the reason claimed rather than because the scenario cannot bounce.

**Concurrency.** A v2 save locks v2 then v1; a legacy save locks v1 then v2 — a lock cycle, which
Postgres breaks with `deadlock detected`. A cross-table advisory lock in a `BEFORE INSERT` trigger
on both tables would remove it, and was rejected: it takes one advisory lock **per row** on every
preference write forever, to prevent an event that needs one user saving on two differently
versioned bundles within milliseconds. The invariant that matters survives either way and is what
the tests assert: **after any committed APPLYING write, v1 and v2 agree.** (A seed-only write leaves
them different on purpose — a partial v2 insert over a legacy `off` commits v1=`off` beside
v2=`instant`, and that divergence IS the protection.) A deadlock aborts one transaction
whole, so it cannot leave them disagreeing; a serialised pair leaves both at the later writer's
value. Lost updates are prevented by the upserts themselves — `ON CONFLICT DO UPDATE` re-reads the
conflicting row under lock.

**Retirement** is in the migration's own footer, and condition 1 of 4 is pinned rather than
remembered: `legacySendEmailInventory.test.ts` asserts `send-email`'s `TYPE_TO_PREF_COLUMN` still
maps `new_availability`/`slot_reopened` onto `open_slots_digest`.

**Red does not mean "delete the bridge."** It means the source-side condition is met and the other
three must now be checked by hand, because no test here can see them: the register measures the
REPOSITORY, and what still enforces v1 is the DEPLOYED bundle. Migrations are pushed before the edge
function, so retiring the bridge on a green CI while the old `send-email` is still live re-opens this
exact gap. The test carries that instruction in its own failure message rather than only here.
Conflating "merged" with "live" is the mistake the bridge exists to survive.

## 10c-b H — the deferred index measurement, and why `idx_notification_outbox_due` stays

C shipped `idx_notification_outbox_due_instant` (partial, `channel, scheduled_for,
next_attempt_at WHERE status IN ('pending','processing') AND delivery_mode IS DISTINCT FROM
'digest'`) so that a large DUE digest backlog is not walked and discarded by the instant claim.
One question was deliberately left open: the claim's SECOND arm — reclaiming rows orphaned by a
crashed worker — filters on `locked_at` and `attempts`, and neither is in any index, so they stay
RESIDUAL. The agreement was not to drop or narrow the older `idx_notification_outbox_due` until
that arm had been measured. It has now been measured.

**Result (real PostgreSQL, `openSlotsResolverDigest.realpg.test.ts`, 20 000 non-digest
`processing` rows locked seconds ago with an old `scheduled_for`, plus 5 genuinely due rows):
20 000 rows removed by filter, and NO index used at all — the planner chooses a sequential scan.**

The shape is realistic and self-inflicted: the instant worker sets `status='processing',
locked_at=now()` on every row it claims, so a slow or backed-up worker leaves exactly this
population. Those rows pass channel + status + `delivery_mode`, so they are IN the partial index;
they fail only the residual `locked_at < now() - stale` test, and with `ORDER BY scheduled_for`
they sort first.

**Decisions:**

1. `idx_notification_outbox_due` is **kept, unchanged**. Dropping or narrowing it would not improve
   this arm — neither index carries `locked_at` or `attempts`, so neither can serve it — while
   removing cover from every other consumer of that index. The deferral asked whether removal was
   safe; the measurement says removal would be all cost and no benefit.
2. Serving the stale-reclaim arm properly needs its **own** partial index keyed for it. That is a
   separate change, sized against production statistics (how many rows are genuinely in flight at
   once, and for how long), not a drive-by inside a digest cutover. It is not required for 10c-b:
   the arm is correct, and the cost only appears under an in-flight backlog that the instant
   worker's own throughput bounds.
3. The measurement is **asserted, not just recorded** — the test fails if the plan starts using an
   index, which is the signal that this analysis has gone stale and the decision must be retaken.

The clone-safety register gained a guard of its own. `run-rollout.sh` fails closed on any live cron
job missing from `clone-safety/reviewed-cron-jobs.tsv`, but nothing tied that file to the
migrations — so 10c-b F scheduled `notification-digest-worker` and it went unregistered. That
inventory step connects and reads but refuses before it CHANGES anything, so the cost is an aborted
rollout attempt rather than a stuck window; the point is that it would have been discovered by an
operator running the rollout instead of by CI on the day the job was added.
`src/test/reviewedCronJobsRegister.test.ts` closes that: every job name any migration schedules
must be registered.

**It deliberately does NOT re-derive the outbound classification from migration text.** Five review
rounds each found another SQL construct that a static reader mis-classified — a command variable
bound to the wrong assignment, `E''` escapes hiding a marker, `||` splitting one, `replace()`
removing one, `CASE` manufacturing one, `format(…)::jsonb ->> 'y'` evaluating to something else,
comments inside `DO $do$` bodies. The classification is compared instead where the text that will
actually run is available: `clone_source_inventory.sql` applies the same lexical test to the LIVE
`cron.job.command`, and run-rollout.sh reports CLASSIFICATION DRIFT against the register. Both
sides are lexical — neither evaluates reachability — but only one of them is reading the command
production will execute, and duplicating it statically added surface area without adding safety.

The remaining source scan is therefore **best-effort**: it reads the job name from every scheduling
form used in this repo and fails loudly on ones it cannot read, but it is not a proof that no call
escapes it (a comment between `cron` and `.schedule`, for example, is not matched). Its job is to
catch the ordinary case — a new migration scheduling a new job — on the day it lands.
