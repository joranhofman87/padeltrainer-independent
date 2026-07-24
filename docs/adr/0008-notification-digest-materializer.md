# ADR 0008 — v2 notification digest materializer (durable attempts, sticky uncertainty, late evidence)

Status: **Proposed — Rev 9** (self-contained; addresses the Codex review of Rev 8; design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. No live route; ships inert (no live event
> `digest_engine_enabled`). Four-stage plan: **10c-a** foundation · **10c-b** open_slots→v2 (+ event
> pre-send policy hook; enables the first digest event) · **10c-c** durability closure · **10c-d** legacy
> retirement. Intended **implementation contract** — self-contained.

## Core model (Rev 9)

- **One durable attempt row per HTTP dispatch** (`notification_digest_attempts`, PK `attempt_id`); a
  **fresh `attempt_id` for every replay**, but the group's **frozen provider idempotency key is reused**
  (Resend dedups within 24 h). "≤1 HTTP per attempt row"; record is **idempotent in SQL** by `attempt_id`.
- **Late `accepted` monotonically completes the group** even if a newer attempt owns it; a stale
  non-accepted result may only **annotate its own attempt row**, never regress group state.
- **Uncertainty is sticky:** once `uncertain_since` is set it clears **only** by positive evidence — an
  `accepted` result, a correlated provider delivery/bounce event, or operator reconciliation. A later
  definite failure of a *different* attempt says nothing about an earlier possibly-accepted one.
- **Immutable `digest_boundary_at`** (in the canonical key) is separated from a mutable **`available_at`**
  (scheduling); the boundary is never mutated.

## Rev 9 review-response map

| # | Finding | Fix |
|---|---|---|
| 1 | Attempt identity contradictory; record not schema-idempotent; late accept rejected | Durable attempt rows; fresh `attempt_id`/replay + frozen key; SQL-idempotent record; **late `accepted` completes monotonically**, stale non-accepted only annotates (§ATT, §P6) |
| 2 | Ambiguity cleared by a later definite failure | **Sticky uncertainty** — cleared only by accepted / correlated provider event / operator reconcile; capacity held meanwhile (§UNC, §P6) |
| 3 | `digest_boundary_at` mutated; idempotency key formula absent | Mutable **`available_at`** for scheduling; boundary immutable. Key = **`'dg:v1:' || digest_group_id`** (≤256, server-set at `store`, reused) (§SCHED, §KEY) |
| 4 | Callback-before-record + late evidence missing | **Resend tag = `digest_group_id`**; **orphan provider events** by email id reconciled later; monotonic **late-evidence** `delivery_unknown → delivered/bounced`; full status set (sent/delivered/delivery_delayed/bounced/complained/failed/suppressed); at-least-once/unordered safe (§PV) |
| 5 | Error handling not exhaustive | **Allow-list + conservative fallback** (unknown → `ambiguous` + alert, never terminal); `invalid_idempotent_request` → **invariant-breach alert + global hold**, distinct from `concurrent_idempotent_requests` (§ERR) |
| 6 | Lifecycle gaps | `parent_group_id` on each child (split → many children); **drop `forming`** (materialize is atomic per group); **single-item >90 KB → terminal `oversize_failed`** + alert; `delivery_unknown` → reservations **`committed`** (terminal, purgeable) (§SPLIT, §MAT, §CH, §CAPS) |
| 7 | Breaker transitions incomplete | Full half-open outcome table (accepted/429/terminal/ambiguous/probe-death) + **explicit deny of non-probe workers** while half-open (§CB) |
| 8 | Audit/privacy/scheduling/retention | Append-only **enforced by grants** (INSERT/SELECT only); terminal scrub nulls the **outbox `payload`** too; **retention for all** tables; exact **daily/weekly boundary** rules incl. weekday + DST (§AUDIT, §SCRUB, §RET, §BND) |

Owner params: 50 items / ~90 KB / academy→trainer→Amsterdam / 35-day counter retention / 23 h uncertainty
deadline (24 h − 1 h) / breaker timings.

## Data model (self-contained)

### M1 — immutable snapshot + canonical key + idempotency key

`enqueue_notification` writes immutably per outbox row: `delivery_mode ('instant'|'digest')` (once from
`digest_engine_enabled` + resolved frequency; later flips affect new rows only), `recipient_key`
(`p:/u:/g:`), `digest_frequency`, `group_locale`, `recipient_timezone` (§TZ), **`digest_boundary_at`**
(§BND — immutable), `template_version`, `destination_fingerprint` (sha256 normalized destination),
service-role `digest_item` jsonb `{v:1, occurred_at, summary_text, deep_link}` (NOT `public_summary`) +
server-computed `digest_item_bytes`. `canonical_group_key = jsonb_build_array('v1', channel, recipient_key,
destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, event_type, template_key,
template_version, group_locale, digest_frequency, digest_boundary_at)`; `group_key_hash` = its sha256 (hint
only). **§KEY:** `provider_idempotency_key = 'dg:v1:' || digest_group_id` (36+6 chars ≪ 256; server-set at
`store_digest_request`, **reused across every attempt** — load-bearing since Resend retains keys 24 h).
`digest_eligible(o) := coalesce(o.delivery_mode='digest', false)`. Outbox `status` gains `'delivery_unknown'`;
adds `digest_group_id`, `skip_reason`.

### M2 — durable group (no `forming`; `available_at`; sticky uncertainty; lineage)

```sql
CREATE TABLE public.notification_digest_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_group_id uuid REFERENCES public.notification_digest_groups(id),   -- set on split children
  canonical_group_key jsonb NOT NULL, group_key_hash text NOT NULL, chunk_ordinal int NOT NULL DEFAULT 0,
  channel text NOT NULL, event_type text NOT NULL, recipient_key text NOT NULL, destination_fingerprint text NOT NULL,
  tenant_academy_profile_id uuid, tenant_trainer_id uuid, recipient_timezone text NOT NULL,
  digest_boundary_at timestamptz NOT NULL,          -- IMMUTABLE (part of canonical key)
  available_at timestamptz NOT NULL,                -- MUTABLE scheduling (quiet-hours/cap/backoff)
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','leased','prepared','request_ready','sending',
     'sent','failed_terminal','oversize_failed','delivery_unknown','retry_stopped','no_work','superseded')),
  item_count int NOT NULL DEFAULT 0, total_item_bytes int NOT NULL DEFAULT 0,
  provider_attempts_started int NOT NULL DEFAULT 0,     -- MONOTONIC audit
  delivery_budget_used int NOT NULL DEFAULT 0, max_delivery_budget int NOT NULL DEFAULT 5,
  locked_by text, locked_at timestamptz, worker_run_id uuid,
  frozen_request jsonb, request_hash text, provider_idempotency_key text,
  uncertain_since timestamptz, uncertain_deadline_at timestamptz,      -- sticky; +23h
  provider_message_id text, provider_status text NOT NULL DEFAULT 'none', provider_status_rank int NOT NULL DEFAULT 0,
  terminal_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_group UNIQUE (canonical_group_key, chunk_ordinal),
  CONSTRAINT uq_digest_group_provider UNIQUE (provider_message_id));
```

### ATT — durable attempt rows (append-only; SQL-idempotent record)

```sql
CREATE TABLE public.notification_digest_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_group_id uuid NOT NULL REFERENCES public.notification_digest_groups(id),
  worker_run_id uuid NOT NULL, provider_idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  outcome_class text, resend_error_name text, http_status int, provider_message_id text,
  recorded_at timestamptz);   -- NULL until record(); record is idempotent (UPDATE … WHERE recorded_at IS NULL)
```

`begin_digest_attempt` INSERTs one row (fresh `attempt_id`, the group's frozen key). `record` sets its
outcome once (`WHERE recorded_at IS NULL` → idempotent; a replay after crash is a no-op). Append-only via
grants (§AUDIT). **HTTP calls ≤ attempt rows**; a crash may leave an attempt row with no HTTP.

## Phase A — MATERIALIZE (atomic per group; no `forming`; fixes #6-mat)

`materialize_notification_digest_groups(p_run_id, p_channel, p_now, p_max_members, p_max_chunks) → int`:
per `canonical_group_key`, `pg_try_advisory_xact_lock(group_key_hash)`, `chunk_ordinal =
coalesce(max(existing),-1)+1` under the lock; **create the group row AND assign its members in one
transaction** — a group is either fully `pending` or not created (rollback). So there is **no persisted
`forming` state**; a crash mid-materialize leaves nothing partial; re-materialize creates it fresh (or the
`UNIQUE(canonical_group_key, chunk_ordinal)` no-ops a completed one). `available_at = digest_boundary_at`.
Bounded by `p_max_members` AND `p_max_chunks`. **Single-item oversize:** if one item's `digest_item_bytes`
alone exceeds the render budget, the group is created directly as **`oversize_failed`** (terminal, member
`failed`/`single_item_oversize`, alert) — it can never render.

## Phase B — the RPCs

**P1 · claim** (breaker-gated §CB): ONE group `FOR UPDATE SKIP LOCKED`, `ORDER BY available_at`, from:
fresh `pending` (`available_at ≤ p_now`, quiet-hours §QH → defer bumps **`available_at`**, never the
boundary); **due owned `request_ready`** (`available_at ≤ p_now AND locked_by IS NULL` → set ownership,
stay `request_ready`); **crash reclaim** (stale-locked, `locked_at < p_now − stale`) in
`leased|prepared|request_ready|sending` — a stale `sending` (record never ran) → set `uncertain_since` if
null, → owned `request_ready` (reservation held), due.

**P2 · prepare** (from `leased`): pre-send validation (§PS); **finalize each rejected member immediately**
(§MEM) even in mixed groups; ≥1 survivor → freeze member manifest → `prepared`; else `no_work`.

Worker **renders**; hard-check ≤ 90 KB; oversize (multi-item) → **P3 split**.

**P3 · split** `split_digest_group(p_run_id, p_worker, p_digest_group_id) → int` (ownership-gated,
`pending|prepared`): create child groups (`chunk_ordinal max+1` under key lock) each with
**`parent_group_id = this.id`**, move members; original → `superseded`; ledger.

**P4 · store** `store_digest_request(p_run_id, p_worker, p_digest_group_id, p_frozen_request)` (from
`prepared`): recompute `request_hash` server-side; validate destination == fingerprint / schema / ≤90 KB;
store request; set **`provider_idempotency_key = 'dg:v1:'||id`** (§KEY); → `request_ready`,
`available_at=now()`, ledger.

**P5 · begin attempt** `begin_digest_attempt(p_run_id, p_worker, p_digest_group_id, p_now) →
TABLE(attempt_id uuid, provider_idempotency_key text, outcome text)`, ownership-gated, from
`request_ready`, one txn:
1. **All stop-only re-checks (§PS):** preference / current contact / destination / suppression / event
   policy. Stop & `uncertain_since IS NULL` → `retry_stopped`; stop & uncertain → `delivery_unknown` (held).
2. **Uncertainty age-out:** uncertain & `p_now ≥ uncertain_deadline_at` → `delivery_unknown`.
3. **Breaker** open → stay `request_ready`, `available_at = circuit.retry_at`, clear ownership.
4. **Quiet hours** (§QH, from `p_now`) outside `[09:00,20:00)` → stay `request_ready`, `available_at = next
   local 09:00`, clear ownership.
5. **Budget:** `delivery_budget_used ≥ max` → uncertain ? `delivery_unknown` : `failed_terminal`.
6. **Capacity (§CAPS):** reuse active held reservation (current buckets) else acquire fresh; unavailable →
   `request_ready`, bump `available_at`, clear ownership.
7. **INSERT an attempt row** (fresh `attempt_id`, frozen key); `provider_attempts_started++`;
   `delivery_budget_used++`; ledger `attempt`(attempt_id); → `sending`; return `attempt_id` + key.

Worker **POSTs** via **`sendResendDigestOnce`** with the frozen key + **Resend tag `digest_group_id`**
(§PV) — one HTTP for this attempt row.

**P6 · record** `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_attempt_id,
p_outcome_class, p_provider_message_id, p_resend_error_name, p_http_status, p_retry_after_seconds) → text`,
one txn: **write the attempt row's outcome idempotently** (`UPDATE notification_digest_attempts SET … WHERE
attempt_id=p_attempt_id AND recorded_at IS NULL`; already-recorded → no-op). Then update the GROUP:
- **`accepted`** → **monotonic complete**: `state='sent'`, `provider_message_id`, commit reservations,
  scrub (§SCRUB), members `sent` — **applied even if a newer attempt now owns the group** (acceptance is
  positive evidence; it wins). Clears uncertainty.
- If the attempt is **stale** (group `locked_by`/`worker_run_id`/`attempt_id` no longer this one) and
  `p_outcome_class ≠ accepted` → **annotate the attempt row only**; do not change group state.
- **`retryable_definite`** (429 `rate_limit_exceeded`) → `request_ready`; release reservations; clear
  ownership; `available_at = now()+max(Retry-After, backoff)`. **Uncertainty unchanged** (a later definite
  failure does not clear a prior ambiguity, §UNC).
- **`ambiguous`** (5xx/network/timeout, 409 `concurrent_idempotent_requests`) → `request_ready`; **set/keep
  `uncertain_since`**; **retain** reservation; clear ownership; `available_at = now()+backoff`.
- **`terminal`** (422/validation/invalid payload) → `failed_terminal`; release; scrub; members `failed`.
  (If uncertain from a prior attempt, uncertainty persists and the group instead ages to
  `delivery_unknown` — a terminal on a *new* attempt cannot prove an earlier possible acceptance did not
  deliver.)
- **`global_config`** (401/403 auth/config, `daily_quota_exceeded`, `monthly_quota_exceeded`) → record the
  attempt; **`delivery_budget_used--`** (refund); release reservations; **trip breaker** (§CB); →
  `request_ready`, clear ownership, `available_at = circuit.retry_at`. Uncertainty unchanged.

### UNC — sticky uncertainty (fixes #2)

`uncertain_since` is set on the first `ambiguous` outcome and **persists** until: an `accepted` record (this
key delivered), a **correlated provider event** proving the send's fate (§PV late evidence), or explicit
operator reconciliation. It is **never** cleared by a later definite failure of a different attempt. While
uncertain, capacity stays held/committed. `delivery_unknown` (age-out) → reservations **`committed`**
(terminal), so retention purges them (§CAPS).

### ERR — allow-list + conservative fallback (fixes #5)

Classify by **Resend error name** (allow-list):

| name / signal | class |
|---|---|
| 2xx | `accepted` |
| `rate_limit_exceeded` (429) | `retryable_definite` (Retry-After) |
| `daily_quota_exceeded` / `monthly_quota_exceeded` (429) | `global_config` |
| `restricted_api_key` / `invalid_api_key` / 401 / 403 | `global_config` |
| 5xx / network / timeout / `application_error` | `ambiguous` |
| `concurrent_idempotent_requests` (409) | `ambiguous` (original may still complete) |
| `validation_error` / `invalid_from_address` / `invalid_attachment` / 422 | `terminal` |
| **`invalid_idempotent_request`** | **invariant-breach**: alert + **global hold** (our key reuse is wrong — do not treat as concurrent) |
| **unknown / unmapped name** | **`ambiguous` + alert** (conservative: a new 4xx must NOT terminal-fail the queue) |

### CB — provider circuit breaker (full transitions; fixes #7)

`notification_provider_circuit(channel PK, state CHECK('closed','open','half_open'), reason, tripped_at,
retry_at, probe_locked_by, probe_locked_at)`. Trip (`global_config`/invariant-breach): `open`, reason-aware
`retry_at` — auth/config `+15m`; daily quota `+coalesce(Retry-After,24h)`; monthly quota / invariant-breach
`retry_at=NULL` (manual hold). **Claim gate:** any `open` (with `retry_at NULL or now<retry_at`) OR
`half_open` → non-probe workers get `none` (explicit deny). At `now≥retry_at`, one worker CAS
`open→half_open` (probe lease); it claims **one** probe group. Half-open outcomes:

| probe result | breaker → |
|---|---|
| `accepted` | `closed` |
| `retryable_definite` (rate-limit) / `terminal` validation | `closed` (API reachable; per-request issue) |
| `global_config` | `open` (new reason-aware `retry_at`) |
| `ambiguous` | `open` (short `retry_at`; recovery unconfirmed) |
| probe process death (`probe_locked_at` stale) | re-CAS-able by another worker |

### PV — callbacks: tags, orphans, late evidence, full status (fixes #4)

Send tags carry `digest_group_id`. `notification_provider_events(resend_event_id text PK, provider_message_id
text, digest_group_id uuid, status text, occurred_at timestamptz, received_at timestamptz DEFAULT now())`,
**append-only** (`ON CONFLICT (resend_event_id) DO NOTHING`; at-least-once/unordered safe). Correlation:
prefer the tag `digest_group_id`; else resolve via `provider_message_id`; a webhook arriving **before**
`record` is stored as an **orphan** (group null, `provider_message_id` set) and linked when the group's
`provider_message_id` lands. Status set + **monotonic rank**: `sent 1 < delivery_delayed 2 < delivered 3`
(terminal-good) and side outcomes `bounced/failed/suppressed 4 < complained 5` (terminal-bad); a lower-rank
late event never regresses a higher one. **Late-evidence monotonic transitions:** a `delivered` for a
`delivery_unknown` group → `sent` (resolved) with provider_status `delivered`; a `bounced`/`failed` →
resolves the unknown as not-delivered (audit + suppression via `record_email_event`). The webhook calls
**`record_email_event` once per group destination** so suppression stays authoritative.

### CAPS — reuse/acquire, key, release/commit, retention (fixes #4-key, #6-du)

`notification_send_counters(counter_key PK, bucket_kind CHECK('hour','day'), bucket_start, used int CHECK(used>=0), cap int)`;
`notification_send_reservations(digest_group_id, counter_key, bucket_start, state CHECK('reserved','committed','released'),
created_at DEFAULT now(), updated_at DEFAULT now(), PRIMARY KEY(digest_group_id, counter_key))`.
**`counter_key = channel || ':' || event_type || ':' || destination_fingerprint || ':' || bucket_kind || ':'
|| bucket_start::text`** (per destination → no shared-mailbox bypass). `begin` reuses an active `reserved`
pair on current buckets, else acquires fresh (ensure rows; `FOR UPDATE` **hour then day**; verify `used<cap`;
`used++`; upsert `reserved`). **Commit** on `accepted` and on `delivery_unknown` (`reserved→committed` —
capacity may have been consumed; terminal). **Release-once** on `retryable_definite`/`terminal`/
`global_config`/pre-attempt `retry_stopped`. Retention: purge counters `bucket_start<now()-35d`, terminal
reservations (`committed`/`released`) `updated_at<now()-35d`.

### MEM — member finalization (mixed groups; fixes #5)

At `prepare`, each rejected member is finalized immediately (even with survivors). Every group terminal
finalizes members in the same txn:

| terminal | member `status` | reason |
|---|---|---|
| prepare reject | `cancelled` | validation reason (`preference_off`/`suppressed`/`contact_revoked`/`destination_mismatch`/`opted_out`/`unfollowed`) |
| `sent` | `sent` | — |
| `failed_terminal` | `failed` | `provider_terminal` |
| `oversize_failed` | `failed` | `single_item_oversize` |
| `retry_stopped` | `cancelled` | `opted_out_before_send` |
| `delivery_unknown` | `delivery_unknown` | `ambiguous_window_expired`/`opted_out_after_ambiguous_attempt` |
| `superseded` | (moved to child `digest_group_id`) | — |

### PS / QH / TZ / BND / SCRUB / AUDIT / RET / MIG / ACL / IX

- **PS:** stop-only checks (preference, contact revoked/replaced, destination mismatch, `is_email_suppressed`,
  event policy hook [10c-b]) at `prepare` (drop members) AND before every attempt (whole-group stop, no
  manifest rewrite). Required-delivery exempt from opt-out.
- **QH:** `[09:00,20:00)` in `recipient_timezone` (DST via `AT TIME ZONE`), at claim AND in `begin`; outside
  → next local 09:00; bumps `available_at` (never the boundary).
- **TZ:** academy → trainer → `Europe/Amsterdam`.
- **BND (fixes #8-sched):** `digest_boundary_at` at enqueue in `recipient_timezone`, DST-correct: **daily** =
  the next `09:00` local ≥ enqueue (today if before 09:00 local, else tomorrow); **weekly** = the next
  configured weekday (default **Monday**) `09:00` local ≥ enqueue. Computed with
  `date_trunc('day', now() AT TIME ZONE tz)` + interval then back to UTC `AT TIME ZONE tz`; a DST-shift day
  still yields 09:00 wall-clock. Immutable once set.
- **SCRUB (fixes #8-priv):** on `sent`/`failed_terminal`/`oversize_failed`/`retry_stopped`/`delivery_unknown`:
  `frozen_request = NULL`, null the member `digest_item` token payload AND the **original outbox `payload`**
  token-bearing fields; retain `request_hash` + safe-metadata allow-list (`recipient_key, item_count,
  total_item_bytes, provider_message_id, digest_boundary_at, terminal_reason`).
- **AUDIT (fixes #8-append):** `notification_digest_attempts`, `..._group_attempts` (ledger), and
  `..._provider_events` are **append-only enforced by grants** — `GRANT INSERT, SELECT` to service_role,
  **no `UPDATE`/`DELETE` grant** (record sets an initially-NULL outcome column via a narrow SECURITY DEFINER
  RPC that is the only writer; a `BEFORE UPDATE/DELETE` trigger raises on any other path).
- **RET (fixes #8-ret):** retention/archival — terminal groups + their attempts + provider events purged/
  archived after **90 days**; finished `worker_runs` after 90 days; counters/reservations 35 days (§CAPS).
- **MIG:** legacy NULL `delivery_mode` → instant-path (strict boolean). Catalog `CHECK (NOT
  digest_engine_enabled OR supports_digest)`. Engine exercised by **test fixtures only**.
- **ACL:** each of the 8 new tables (groups, attempts, group_attempts, worker_runs, provider_events,
  provider_circuit, send_counters, send_reservations): RLS on, no policy, `REVOKE … FROM PUBLIC, anon,
  authenticated`, service-role grants only (append-only tables per §AUDIT). RPCs `SECURITY DEFINER`,
  `SET search_path=public`, service-role only. Migration-wide ACL guard test.
- **IX:** forming `notification_outbox (channel, digest_boundary_at) WHERE delivery_mode='digest' AND
  digest_group_id IS NULL AND status='pending'`; due `notification_digest_groups (channel, available_at)
  WHERE state IN ('pending','request_ready') AND locked_by IS NULL`; stale `(channel, locked_at) WHERE state
  IN ('leased','prepared','request_ready','sending')`; attempts `(digest_group_id)`; provider-event orphans
  `(provider_message_id) WHERE digest_group_id IS NULL`; member `notification_outbox (digest_group_id)`;
  dedup `UNIQUE(canonical_group_key, chunk_ordinal)`, `UNIQUE(provider_message_id)`.

## Crash / race → single recovery route

| Event | State | Route |
|---|---|---|
| crash mid-materialize | (none; rolled back) | re-materialize creates fresh; `UNIQUE` no-ops a completed group |
| crash after claim/prepare/store | `leased`/`prepared`/`request_ready` | due/stale claim → next step |
| crash after begin, before HTTP | `sending`, attempt row unrecorded | reclaim → `uncertain_since` set → new attempt row, **same key** → re-POST (Resend dedups) |
| crash after HTTP accept, before record | `sending` | reclaim re-POSTs same key (dedup); the accepted idempotent replay completes the group; >23h uncertain → `delivery_unknown` (capacity committed) |
| **callback before record** | `sending` | orphan provider event stored; linked when `provider_message_id` lands; can complete a later `delivery_unknown` |
| **late `accepted` after reclaim** | any | monotonically completes the group; stale non-accepted only annotates its attempt |
| webhook double / unordered | — | `ON CONFLICT DO NOTHING`; monotonic rank |

## Test plan (named crash/race cases)

Real-Postgres: **attempt rows** — fresh `attempt_id`/replay, one frozen key; record idempotent (double =
one effect); HTTP ≤ attempt rows; **late `accepted` after another worker reclaimed** completes the group;
stale non-accepted only annotates. **Sticky uncertainty** — `timeout→429`, `timeout→401`, `timeout→422`:
uncertainty persists (not cleared), capacity held, resolves only on accepted/provider-event/operator.
**Boundary immutability** — quiet-hours/cap defer bumps `available_at`, never `digest_boundary_at`; the
canonical key is unchanged. **Callback-before-record** — orphan event linked on `provider_message_id`;
`delivery_unknown → delivered` on a late webhook; bounced/failed/suppressed/delivery_delayed handled;
unordered/at-least-once idempotent. **Errors** — allow-list mapping; unknown name → ambiguous+alert (no
terminal); `invalid_idempotent_request` → invariant-breach alert + hold. **Breaker** — one half-open probe
(CAS); non-probe denied; every probe outcome transition; stale probe re-claim; monthly-quota manual hold.
**Lifecycle** — split → multiple children each with `parent_group_id`; no persisted `forming`; single-item
>90 KB → `oversize_failed`; `delivery_unknown` reservations `committed` then purged at 35 days. **Scrub** —
frozen_request + member digest_item + outbox payload token fields nulled on every terminal. **Audit** —
UPDATE/DELETE on append-only tables blocked by grants/trigger. **Retention** — groups/attempts/events/runs
purged at 90 days. **Boundary rules** — daily/weekly next-09:00-local incl. DST-shift day and weekday.
Two-worker concurrency; ACL guard; catalog constraint; 100k scale on real PG; back-compat instant-path.

## Alternatives considered

- **One attempt_id reused on replay (Rev 8)** — rejected (#1): breaks ≤1-HTTP-per-attempt; durable attempt
  rows + one frozen key + SQL-idempotent record + monotonic late accept.
- **Definite failure clears uncertainty (Rev 8)** — rejected (#2): sticky until positive evidence.
- **Mutating `digest_boundary_at` (Rev 8)** — rejected (#3): separate `available_at`.
- **Correlate only via stored `provider_message_id` (Rev 8)** — rejected (#4): tag + orphan + late evidence.
- **Closed error table / `superseded_by` scalar / `forming` state / attachment-only scrub (Rev 8)** —
  rejected (#5,#6,#8): fallback+allow-list, `parent_group_id`, atomic materialize, full scrub.

## Consequences

- Attempt identity is now sound across the network boundary: replays are distinct rows under one Resend
  key; acceptance (even late) completes monotonically; ambiguity is conservatively sticky and capacity is
  never wrongly released.
- Immutability of the group key is preserved; scheduling moves to `available_at`.
- Callback-before-record and late evidence are handled; the breaker is fully specified; the lifecycle and
  retention are complete; audit tables are append-only by grant; all token-bearing bytes are scrubbed.
- Confirmations before implementation (all set): 50 / ~90 KB / 09:00–20:00 / academy→trainer→Amsterdam /
  35-day counter + 90-day audit retention / 23 h uncertainty / breaker timings / weekly weekday = Monday.
- Legacy `notification_queue`/`send-digest-emails` untouched until 10c-d.
