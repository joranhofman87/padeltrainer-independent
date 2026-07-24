# ADR 0008 — v2 notification digest materializer (group-claim) + run-level reconciliation

Status: **Proposed — Rev 2** (addresses the Codex review of Rev 1; still design-only, PR 10c-a)
Date: 2026-07-24

> Scope: **PR 10c-a only** — the digest ENGINE + observability. Migrates **no live route** (open_slots
> stays legacy until 10c-b) and ships **structurally inert** (§9). Four-stage plan (owner-approved):
> **10c-a** foundation+observability · **10c-b** open_slots→v2 · **10c-c** durability closure · **10c-d**
> legacy retirement.

## What changed in Rev 2 (review response map)

The Rev-1 guarantees rested on **re-computing** the group at claim time from live joins. Rev 2 moves to
**snapshot-at-enqueue + freeze-at-first-claim + per-group identity + per-run identity**. Every finding:

| # | Finding | Rev-2 fix |
|---|---|---|
| 1 | Group claim can split across workers (`SKIP LOCKED` lets two workers lock disjoint subsets of one group) | **`pg_try_advisory_xact_lock(group_hash)` is taken BEFORE member selection**; only the lock holder claims the group's members (§C1) |
| 2 | Retry membership not stable (`claim_now` not persisted) | **First claim FREEZES the group**: assigns `digest_group_id` + `group_cutoff_at` and stamps them on members; reclaim re-selects by `digest_group_id` only (§C2) |
| 3 | Grouping inputs incomplete + mutable (`default_email_frequency` ≠ resolved pref; locale/config mutate; guest-only missing; UUIDs unnamespaced) | **Resolver SNAPSHOTS immutable grouping columns onto the outbox row** at enqueue: `recipient_key` (`p:/u:/g:`), effective `digest_frequency`, `group_locale`, `recipient_timezone`, `digest_boundary_at`, `template_version`, `digest_group_hash` (§B, §C0) |
| 4 | Overflow can lose/strand; "+K more" contradicts leaving items pending | **Deterministic chunking at CLAIM** (row-count cap + per-item byte budget); each chunk is its own frozen `digest_group_id`+`chunk_ordinal`; no "+K more", no post-render surprise; a defined item schema (§C3, §D) |
| 5 | No-dup claim exceeds Resend's 24h | Persist **`first_send_at`**; an ambiguous outcome aged past the provider window → explicit **`delivery_unknown`** (manual reconcile), never blind resend (§C5) |
| 6 | Reconciliation not run-level (time window can't isolate a run; joins multiply counts) | **`notification_worker_runs` + `worker_run_id` stamped on every claim/outcome**; reconcile by `run_id`, delivery resolved through the group provider-event (no fan-out) (§C6) |
| 7 | Provider callbacks won't link to all members (webhook writes one null-`outbox_id` event; shared `resend_email_id` ≠ per-member visibility) | **One provider-event row keyed by `digest_group_id`**; the Resend webhook maps `resend_email_id → digest_group_id`; member timelines/reconcile resolve THROUGH the group; `resend_event_id` idempotency preserved (§C7) |
| 8 | Rollout not structurally inert (`supports_digest=true` on live events; users hold daily/weekly prefs) | **New per-event `digest_engine_enabled` (default false)**, separate from `supports_digest`; the eligibility predicate keys on it; only a synthetic event is enabled in 10c-a (§C9) |
| 9 | Rate caps not retry-safe (key omits channel/event; no reservation; hour/day non-atomic; deferral consumes attempts) | **Reservation model keyed by `(channel,event,recipient,bucket)` + `digest_group_id`**: reserve hour+day in one atomic step, commit on provider acceptance, release on failure; **deferral never increments `attempts`** (§C9b) |
| 10 | Query not bounded at 100k (group-by scans the due set) | **Candidate selection is index-only** on a partial index over `(digest_group_hash, digest_boundary_at)`; pick ONE group, then fetch its bounded members; **100k `EXPLAIN` on real Postgres**, not PGlite (§C10, §E) |
| 11 | Delayed opt-outs undefined | **Claim-time re-validation**: a row whose recipient opted out / unfollowed after enqueue is `cancelled` (skip_reason), not sent; for optional open-slot messages the opt-out wins (§C11) |
| tz | Timezone source | **Option A + snapshot**: snapshot `recipient_timezone` per row NOW via precedence `person → tenant → Europe/Amsterdam` (today resolves to Amsterdam); group identity never needs redesign when richer tz data arrives (§B) |

## Context

The v2 worker sends **1:1** (`claim_notification_outbox_batch` + `notification-email-worker`); the outbox
carries `collapse_key`/`scheduled_for` but nothing collapses; digest collapse lives only in legacy
`notification_queue`+`send-digest-emails`. 10c-a builds the engine and the observability to prove it,
inert until 10c-b enables a real event. (Full current-state citations in `NOTIFICATION_FOLLOWUPS.md` /
`NOTIFICATION_ARCHITECTURE.md`.)

## Decision

A second claim/collapse/record path in the same worker. Every guarantee rests on **immutable snapshots**
(set once at enqueue) and a **frozen group identity** (assigned once at first claim), never on live
re-computation. A row is processed by exactly one path — instant or digest — via a shared predicate.

### B. Snapshot columns set by the resolver at enqueue (immutable)

`enqueue_notification` writes these onto each `notification_outbox` row and **never** recomputes them:
- `recipient_key text` — `p:<person_id>` | `u:<user_id>` | `g:<guest_player_id>` (covers guest-only; namespaced).
- `digest_frequency text` — the **resolved effective** frequency (prefs_v2 override → event default), one of `instant|daily|weekly`.
- `group_locale text` — snapshot of the recipient's locale (`persons.preferred_language`).
- `recipient_timezone text` — precedence **person tz → tenant tz → `Europe/Amsterdam`** (today: Amsterdam).
- `digest_boundary_at timestamptz` — the immutable target send boundary (next daily/weekly slot, quiet-hours pre-applied at enqueue for the *nominal* boundary; claim re-checks live).
- `template_version int` — snapshot of the event's template version.
- `digest_group_hash text` — `encode(sha256(channel || recipient_key || destination || tenant_academy || tenant_trainer || event_type || template_key || template_version || group_locale || digest_frequency || digest_boundary_at), 'hex')`. **This is the only thing grouping keys on** — a stable hash of the immutable snapshot, so cross-recipient/tenant/locale mixing is impossible and config drift after enqueue cannot move a row between groups. `collapse_key` is retired for digests.

### C. Lifecycle + the guarantees

**C0 — eligibility (shared predicate, no overlap with instant):**
`digest_eligible(row) := row.digest_frequency IN ('daily','weekly') AND EXISTS(event_types WHERE key=row.event_type AND digest_engine_enabled)`. The instant claim (`claim_notification_outbox_batch`) is amended with `AND NOT digest_eligible(o)`. A row is claimable by exactly one path.

**C1 — atomic whole-group claim (fixes #1).** `claim_notification_digest_group`:
1. Pick ONE candidate `digest_group_hash` = the earliest `min(digest_boundary_at) <= p_now` among pending digest-eligible rows, via the partial index (§C10) — index-bounded, `LIMIT 1`.
2. `IF NOT pg_try_advisory_xact_lock(hashtextextended(digest_group_hash, 0)) THEN` skip to the next candidate. The advisory lock (txn-scoped) serializes the **entire** group so no two workers select disjoint subsets.
3. Holding the lock, freeze + claim the group (C2/C3).

**C2 — freeze membership at first claim (fixes #2).** On the first claim of a group this window: assign a fresh `digest_group_id uuid` and `group_cutoff_at = p_now`; stamp both (plus `chunk_ordinal`, `worker_run_id`, `status='processing'`, `locked_by`, `locked_at`) onto the selected members. **Reclaim** (stale) re-selects strictly by `WHERE digest_group_id = X AND status='processing'` — the frozen set, never a fresh `created_at <= now` scan. Membership therefore cannot change across retries, so the idempotency key (§C4) is stable. Late arrivals (`created_at > group_cutoff_at`, or a later `digest_boundary_at`) belong to the **next** group.

**C3 — deterministic chunking at claim, defined item schema (fixes #4).** Members are selected `ORDER BY created_at, id` and capped by BOTH a row count (`p_max_group_rows`, default 500) AND a conservative per-item byte budget (`p_max_group_rows_by_size = floor(256KB / max_item_bytes)`), whichever is smaller — computed at claim, **before** render, so overflow never surprises the renderer. A group larger than the cap splits into consecutive chunks (`chunk_ordinal` 0,1,2…), each its own frozen `digest_group_id`; every item appears in exactly one chunk (no "+K more" while pending). The render consumes a fixed **digest item schema** (`{ occurred_at, summary_line, deep_link }` from each member's `public_summary`), so item size is bounded and known.

**C4 — deterministic idempotency (fixes #2, bounds #5).** Provider `Idempotency-Key = 'digest:v1:' || digest_group_id || ':' || chunk_ordinal`. Because `digest_group_id` is assigned once and membership is frozen, the key is byte-identical across every reclaim.

**C5 — beyond Resend's 24h window (fixes #5).** Persist `first_send_at` when a group is first handed to Resend. The ADR does **not** claim duplicates are impossible: within 24h the key dedups; if an outcome is still ambiguous after `now - first_send_at > provider_idempotency_window (24h)`, the group moves to explicit status **`delivery_unknown`** (a terminal state that surfaces in reconciliation for manual resolution) rather than being re-sent.

**C6 — run-level reconciliation (fixes #6).** New table `notification_worker_runs(run_id uuid pk, worker text, channel text, started_at, ended_at, claimed int, sent int, failed int, skipped int, deferred int, unknown int)`. Every claim/record stamps `worker_run_id`. `reconcile_notification_worker_run(p_run_id uuid)` (and a windowed variant for trend) counts **distinct outbox rows** by terminal status and resolves delivery via the group provider-event (C7) — no join fan-out. Handles `pending|processing|sent|failed|cancelled|delivery_unknown|delivered|bounced`. Invariant proven: `claimed = sent + failed + cancelled + deferred + unknown + still_processing`.

**C7 — group-level provider event + webhook (fixes #7).** On send, write ONE `notification_provider_events(digest_group_id uuid, resend_email_id text, status text, resend_event_id text, occurred_at, PRIMARY KEY(digest_group_id))` row (`UNIQUE(resend_event_id)` for webhook idempotency). The Resend webhook resolves `resend_email_id → digest_group_id` and updates this one row (`delivered|bounced|complained`). Each member's timeline/reconcile resolves delivery **through** `digest_group_id → notification_provider_events` — so a bounce on the shared email shows on every member's timeline without duplicating N provider rows. `email_delivery_events` still gets one row per member for the `queued/sent` audit (linked via `digest_group_id`), but the provider-callback truth is the single group row.

**C9 — structurally inert rollout (fixes #8).** New column `notification_event_types.digest_engine_enabled boolean NOT NULL DEFAULT false`, **separate** from `supports_digest`. `digest_eligible` (C0) keys on `digest_engine_enabled`, NOT `supports_digest`. 10c-a enables it for **one synthetic test event only**; every live event stays false, so pre-existing daily/weekly prefs cannot activate the engine. Rollback = flip the flag off (no live digest rows exist to strand).

**C9b — retry-safe caps + deferral without consuming attempts (fixes #9).** New table `notification_send_reservations(reservation_key text PRIMARY KEY, digest_group_id uuid, channel text, event_type text, recipient_key text, bucket_hour timestamptz, bucket_day timestamptz, state text CHECK in ('reserved','committed','released'), created_at)`. At claim, reserve BOTH the hour and day buckets in ONE statement keyed by `digest_group_id` (idempotent — re-reserving the same group is a no-op). If either cap is exhausted → **defer**: bump `digest_boundary_at` to the next window, release the members to `pending` (clear digest_group_id/processing), **do not increment `attempts`**, record `deferred` on the run. `attempts` increments only on an actual provider send attempt (C-send). Commit the reservation on provider acceptance; release on failure.

**C11 — claim-time opt-out re-validation (fixes #11).** At claim, re-check each candidate member's **current** consent / preference (and follow-status for open-slot). A member now opted-out/unfollowed → `status='cancelled', skip_reason='opted_out_after_enqueue'`, excluded from the group (not sent). For optional open-slot messages, a pre-send opt-out **wins**. (Required-delivery events are exempt, matching existing semantics.)

**C10 — bounded at scale (fixes #10).** Partial index `idx_outbox_digest_candidate ON notification_outbox (digest_group_hash, digest_boundary_at) WHERE status='pending' AND digest_frequency IN ('daily','weekly')`. Candidate selection reads ONE group via this index (no group-by over the due set); member fetch is bounded by `chunk cap`. The 100k scale test asserts the plan on **real Postgres** (CI `supabase db reset` job / a dedicated plan test), not PGlite.

**C-send / C-record (worker):** render one email from the frozen ordered member set → `first_send_at` if unset → provider send with the C4 key → `record_notification_digest_result(p_run_id, p_worker, p_digest_group_id, p_status, …)` (ownership gate `worker_run_id=p_run_id AND locked_by=p_worker AND status='processing'`; all-or-nothing; commits/releases the reservation; writes the group provider-event + per-member delivery rows). Failure → group failed-with-backoff (`attempts` already counted at send), reservation released.

### D / RPC contracts (revised, for review)

**New/changed columns** — `notification_outbox`: `recipient_key`, `digest_frequency`, `group_locale`, `recipient_timezone`, `digest_boundary_at`, `template_version`, `digest_group_hash` (snapshot, at enqueue); `digest_group_id`, `group_cutoff_at`, `chunk_ordinal`, `worker_run_id`, `first_send_at` (frozen, at claim/send); `status` CHECK gains `'delivery_unknown'`. `notification_event_types`: `+digest_engine_enabled boolean default false`. `email_delivery_events`: `+digest_group_id uuid`.

**New tables** — `notification_worker_runs`, `notification_provider_events`, `notification_send_reservations` (shapes above). All service-role only.

**New RPCs** (all `SECURITY DEFINER`, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … service_role`):
- `start_notification_worker_run(p_worker text, p_channel text) RETURNS uuid`
- `claim_notification_digest_group(p_run_id uuid, p_worker text, p_channel text, p_now timestamptz DEFAULT now(), p_max_group_rows int DEFAULT 500, p_max_item_bytes int DEFAULT 512, p_stale_after_minutes int DEFAULT 15) RETURNS TABLE(digest_group_id uuid, chunk_ordinal int, member cols…, outcome text)` — `outcome ∈ ('claimed','deferred','none')`.
- `record_notification_digest_result(p_run_id uuid, p_worker text, p_digest_group_id uuid, p_status text, p_provider_message_id text, p_error text, p_terminal boolean, p_max_backoff_minutes int) RETURNS text`
- `reconcile_notification_worker_run(p_run_id uuid) RETURNS TABLE(channel text, claimed int, sent int, failed int, cancelled int, deferred int, unknown int, processing int, delivered int, bounced int)`
- `record_notification_provider_event(p_resend_email_id text, p_status text, p_resend_event_id text) RETURNS text` (webhook path; idempotent on `resend_event_id`).

**Amended** — `claim_notification_outbox_batch`: `+ AND NOT digest_eligible(o)` (no-op until an event is engine-enabled). **Types drift** → apply the CI-generated `types.ts` artifact.

### E. Test plan

- **Concurrency (real PG):** two `claim_notification_digest_group` racing on one group → advisory lock lets exactly one claim it; the other gets a different group or `none`; **no group split**, no row in two groups.
- **Crash-point:** claim→(kill)→reclaim yields the SAME `digest_group_id` + member set + idempotency key (byte-equal); send-accepted→(kill before record)→reclaim re-sends same key (Resend dedups); aged-out ambiguous → `delivery_unknown`.
- **Scale (real Postgres):** 100 000 due rows across many groups → `EXPLAIN (ANALYZE, BUFFERS)` shows the candidate select uses `idx_outbox_digest_candidate` (index scan, not seq), bounded member fetch, deterministic chunk boundaries. **Not PGlite.**
- **Caps/quiet-hours:** reservation idempotent under two workers; hour+day reserved atomically; cap-hit + quiet-hours **defer without incrementing `attempts`**; DST-boundary tz cases via snapshot `recipient_timezone`.
- **Opt-out:** member opted-out after enqueue → `cancelled`, not in the digest; required events exempt.
- **Provider webhook:** a bounce on the group email surfaces on every member's timeline via `digest_group_id`; `resend_event_id` idempotent (double webhook = one update).
- **Reconciliation:** `claimed = sent+failed+cancelled+deferred+unknown+processing`; no count multiplication under N members.

## Alternatives considered

- **Re-compute the group at claim (Rev 1)** — rejected by the review: config/preference drift + `SKIP LOCKED` subsetting + un-persisted `claim_now` break stability. Snapshot+freeze is required.
- **Claim rows individually + group in JS** — rejected (owner #1): a crash between per-row claims splits a digest.
- **Trust `collapse_key`** — rejected (#3): replaced by `digest_group_hash` over immutable snapshots.
- **Per-member provider rows** — rejected (#7): the callback is one email; a single group provider-event that timelines resolve through is correct and avoids N-way duplication.
- **Global digest switch** — rejected (#8): per-event `digest_engine_enabled` is the only structurally-inert gate given live `supports_digest=true` events.
- **Separate pre-collapse function/cron** — deferred: extra component + two-stage state; revisit only if the in-worker path proves heavy.

## Consequences

- The resolver (`enqueue_notification`) gains the snapshot responsibility — the correctness pivot. 10c-a ships this even though only the synthetic event exercises it.
- `notification_worker_runs` + `reconcile_notification_worker_run` become the standing run-level proof for **all** v2 sends, closing the observability gap hit on the auto-reminder verification.
- `delivery_unknown` + `first_send_at` make the >24h ambiguity explicit rather than silently assumed-safe.
- Timezone: resolved to **A + snapshot** — `recipient_timezone` is stored per row now (precedence person→tenant→Amsterdam), so enabling per-recipient tz later needs no group-identity redesign.
- Legacy `notification_queue`/`send-digest-emails` are untouched here; they retire in 10c-d after 10c-b proves the v2 digest in production.
- Open input for the owner: confirm the **A+snapshot** timezone precedence and the two default caps (`p_max_group_rows=500`, `p_max_item_bytes=512`) before implementation.
