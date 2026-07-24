# ADR 0008 — v2 notification digest materializer (group-claim) + run-level reconciliation

Status: **Proposed** — for review BEFORE implementation (PR 10c-a)
Date: 2026-07-24

> Scope note: this ADR covers **PR 10c-a only** — the digest ENGINE + observability. It migrates **no
> live route** (open_slots stays legacy until 10c-b). It ships **inert**: no live event opts into a
> digest frequency, so there is zero live digest traffic until 10c-b flips one on. That makes 10c-a
> testable end-to-end on synthetic outbox rows and reversible by a switch.
>
> The four-stage plan (owner-approved 2026-07-24): **10c-a** foundation+observability · **10c-b**
> open_slots→v2 · **10c-c** durability closure (group-confirmation / unresolved-send / member-open
> resumable outbox + set-based resolver) · **10c-d** legacy retirement. The rebuild is not complete
> until all four are deployed + verified.

## Context

The v2 pipeline (`enqueue_notification` → `notification_outbox` → `notification-email-worker`) sends
**1:1**: `claim_notification_outbox_batch` claims due `pending` rows by `scheduled_for` with
`FOR UPDATE SKIP LOCKED` and the worker sends each individually
([`20260912100000_notification_email_worker.sql:30`](../../supabase/migrations/20260912100000_notification_email_worker.sql),
[`notification-email-worker/index.ts:103`](../../supabase/functions/notification-email-worker/index.ts)).
The outbox already carries `collapse_key` + `scheduled_for` + a partial index
`idx_notification_outbox_collapse` and the resolver *sets* both
([`20260911100000_notification_resolver.sql:302`](../../supabase/migrations/20260911100000_notification_resolver.sql)),
and `notification_event_types` carries `supports_digest`, `default_email_frequency`
(`instant|daily|weekly|off`), `collapse_window_minutes`, `max_per_user_per_hour|day`,
`quiet_hours_respect` ([`20260910100000_notification_foundation_schema.sql:33`](../../supabase/migrations/20260910100000_notification_foundation_schema.sql))
— but **nothing collapses**. Digest collapse exists only in the legacy `notification_queue` +
`send-digest-emails` (collapse-by-count). ([`NOTIFICATION_ARCHITECTURE.md:355`](../NOTIFICATION_ARCHITECTURE.md).)

10c-a builds the missing engine and the observability to prove it.

## Decision

Add a **second claim/collapse/record path in the same worker**, gated by a switch, built to nine
invariants. A row is processed by **exactly one** path — instant (existing 1:1) or digest (new
group-claim) — partitioned by frequency-eligibility so the two can never both send it.

### 1 — Atomic GROUP claim (never claim rows then group in JS)

New RPC **`claim_notification_digest_group(p_channel, p_worker, p_now, p_max_group_rows, p_stale_after_minutes)`**.
In **one statement** it (a) picks the single earliest-due **group** (by the composite key of §3),
(b) locks all its member rows `FOR UPDATE SKIP LOCKED`, capped + ordered deterministically, and
(c) flips them to `processing` under the run's `locked_by`/`locked_at`, `attempts+1`. Sketch:

```sql
WITH candidate AS (           -- the next due group (one row: the group key + its min schedule)
  SELECT <group_key_cols>, min(o.scheduled_for) AS due
  FROM public.notification_outbox o
  JOIN public.notification_event_types et ON et.key = o.event_type
  WHERE o.channel = p_channel
    AND o.scheduled_for <= p_now
    AND digest_eligible(et, o)                    -- shared predicate (§9): supports_digest AND freq<>'instant'
    AND ( o.status = 'pending'
          OR (o.status = 'processing' AND o.locked_at < p_now - make_interval(mins => p_stale_after_minutes)
              AND o.attempts < o.max_attempts) )  -- stale-claim reclaim (§5)
  GROUP BY <group_key_cols>
  ORDER BY due ASC
  LIMIT 1
), locked AS (
  SELECT o.id
  FROM public.notification_outbox o
  JOIN candidate c USING (<group_key_cols>)
  WHERE o.scheduled_for <= p_now
    AND o.created_at   <= p_now                    -- membership boundary (§4): late arrivals excluded
    AND ( o.status = 'pending'
          OR (o.status='processing' AND o.locked_at < p_now - make_interval(mins => p_stale_after_minutes)) )
  ORDER BY o.created_at, o.id                       -- deterministic continuation ordering (§2)
  LIMIT p_max_group_rows
  FOR UPDATE SKIP LOCKED
)
UPDATE public.notification_outbox o
SET status='processing', locked_by=p_worker, locked_at=now(), attempts=o.attempts+1
FROM locked WHERE o.id = locked.id
RETURNING o.id, o.event_type, o.template_key, o.recipient_person_id, o.recipient_user_id,
          o.tenant_academy_profile_id, o.tenant_trainer_id, o.payload, o.public_summary,
          o.idempotency_key, o.scheduled_for, o.created_at;
```

The worker renders **one** email from the returned member set. It never SELECTs rows and groups them
in application code — a crash between two claims could otherwise split a digest or double-send.

### 2 — Bounded group + payload + deterministic continuation

`p_max_group_rows` (proposed default **500**) caps membership per claim; excess rows sharing the key
form the **next** claim, and because `locked` orders by `(created_at, id)` the split is deterministic
(chunk 1 = first N, chunk 2 = next N…). A rendered-payload byte ceiling (proposed **256 KB**) bounds
the email; if a full group would exceed it the render truncates to "+K more" with the overflow left
`pending` for the next window (never dropped). Each chunk is one email with its own idempotency key
(§4) so re-rendering a chunk is stable.

### 3 — Homogeneous grouping (composite key — NOT `collapse_key` alone)

`collapse_key` is an **index hint**, never the trust boundary. The claim GROUPs on the full tuple, so
a mis-computed `collapse_key` can never mix recipients, tenants, or locales:

```
group_key = ( channel,
              coalesce(recipient_person_id::text, 'u:'||recipient_user_id::text),   -- recipient
              contact_id / destination,                                            -- destination
              tenant_academy_profile_id, tenant_trainer_id,                         -- tenant / branding
              event_type, template_key,                                            -- event / template
              locale (persons.preferred_language),                                 -- locale
              default_email_frequency,                                             -- frequency
              digest_bucket(scheduled_for, collapse_window_minutes) )              -- digest boundary
```

**One `event_type` per digest** (a "3 new open slots" digest is N payloads of the *same* event, not a
mixed daily summary). Cross-event digests are explicitly OUT of 10c-a. Cross-tenant / cross-recipient
mixing is structurally impossible because those columns are equality-partitioned in the key.

### 4 — Stable membership + deterministic idempotency across retries

Membership is defined by immutable facts: the group key + `scheduled_for <= claim_now` +
`created_at <= claim_now`. A reclaim after a crash re-forms the **same** set. **Late arrivals**
(`created_at > claim_now`, or a later `scheduled_for` bucket) belong to the **next** group.

Provider idempotency key = `digest:v1:<sha256(group_key)>:<sha256(sorted member idempotency_keys)>:<chunk_ordinal>`
→ passed as the Resend `Idempotency-Key`. A retry (send accepted, crash before record) re-sends the
**identical** email; Resend dedups within its 24h window → no duplicate. Stable membership is what
makes the key stable.

### 5 — Ownership-checked all-row completion + stale / crash recovery

New RPC **`record_notification_digest_result(p_worker, p_outbox_ids uuid[], p_status, p_provider_message_id, p_error, p_terminal, p_max_backoff_minutes)`** → `text`:
- **Ownership gate:** every id must be `status='processing' AND locked_by=p_worker`; otherwise returns
  `'stale'` and touches nothing (a reclaim now owns them). Mirrors `record_notification_send_result`'s
  guard ([`20260912100000:124`](../../supabase/migrations/20260912100000_notification_email_worker.sql)).
- **All-or-nothing:** on `sent`, ALL members → `sent` + `sent_at`, and **one `email_delivery_events`
  row per member** (§7). On `failed`, the WHOLE group → failed-with-backoff (or terminal). A digest is
  never partially sent.
- **Stale/crash recovery:** rows left `processing` past the lease are re-claimable by the reclaim arm
  (§1); stable membership + the deterministic key guarantee no double send when the group re-forms.

### 6 — Concurrency-safe quiet hours + per-user caps (timezone / DST)

- **Quiet hours** (`quiet_hours_respect`): at claim time, if the recipient's **local** hour (their
  timezone, IANA + DST-aware) is inside quiet hours, the claim **defers** — bumps the group's
  `scheduled_for` to the next allowed boundary instead of sending. Atomic within the claim UPDATE.
- **Caps** (`max_per_user_per_hour|day`): a new atomic counter table
  `notification_send_counters(recipient_key text, bucket_kind text, bucket_start timestamptz, sent int,
  PRIMARY KEY(recipient_key,bucket_kind,bucket_start))` consumed via `INSERT … ON CONFLICT … DO UPDATE
  SET sent = sent+1 WHERE sent < cap RETURNING` (the `consume_rate_limit` pattern — atomic, so two
  workers can't both pass the cap). On cap-hit the group **defers** (not dropped).
- **⚠ OPEN DECISION — timezone source.** `persons` has `preferred_language` but **no timezone column**
  ([`20260826260000_persons_expand.sql:42`](../../supabase/migrations/20260826260000_persons_expand.sql)).
  Options: **(A)** a documented global default `Europe/Amsterdam` (matches
  [`_shared/send-window.ts`](../../supabase/functions/_shared/send-window.ts) `SEND_TIME_ZONE`), add
  per-recipient tz later; **(B)** the tenant academy's timezone; **(C)** add `persons.timezone` now.
  **Recommendation: (A)** for 10c-a (constant, DST-aware via Postgres `AT TIME ZONE`), with a flagged
  follow-up for per-recipient tz. Needs your call.

### 7 — Delivery-event linkage + run-level reconciliation

- Every digest member gets an `email_delivery_events` row (`outbox_id`, `channel`,
  `destination_redacted`, `resend_email_id`, + new `digest_group_id`) so the per-recipient audit and
  the tenant timelines reflect **each intended notification**, even though they shared one email.
- New RPC **`reconcile_notification_outbox(p_since timestamptz, p_until timestamptz)`** →
  `TABLE(channel, intended int, sent int, skipped int, failed int, unresolved int, processing_stuck int)`
  over `notification_outbox ⟕ email_delivery_events` in the window, so a **cron run is provable**
  (`intended = sent + skipped + failed + unresolved`). This closes the observability gap that made a
  `sent>0` run only inspectable via the HTTP response + Slack (no queryable audit) — the exact gap hit
  verifying the auto-reminder run. Service-role only.

### 8 — Tests (concurrency, crash-point, scale)

- **Two-worker concurrency:** two `claim_notification_digest_group` calls race → disjoint groups, no
  row in two groups, no group split across workers.
- **Crash-point:** claim→(crash)→reclaim yields the **same** member set; send-accepted→(crash before
  record)→reclaim yields the **same** idempotency key (assert byte-equal) → no double send; all rows
  eventually `sent`.
- **Scale:** a synthetic **100 000-row** outbox → assert the claim uses the `collapse`/`scheduled_for`
  index + `LIMIT` (no seq scan; check the plan), bounded memory, and deterministic chunk boundaries.
- Quiet-hours/cap: DST-boundary cases; cap-hit defers not drops; counter atomic under two workers.

### 9 — Feature switches, rollout, rollback, double-send prevention

- **Switch:** a global `notification_digest_enabled` flag (a `notification_settings` row / GUC) AND the
  per-event `supports_digest`. 10c-a ships with **no live event digest-enabled** (only a synthetic test
  event), so the path is inert in prod.
- **Double-send prevention:** the shared `digest_eligible(event_type, row)` predicate partitions the
  outbox — the **instant** claim (`claim_notification_outbox_batch`) is amended to **exclude**
  digest-eligible rows, and the digest claim includes only them. A row is claimable by exactly one
  path. (This amendment to the instant claim is the one change 10c-a makes to an existing RPC; it is a
  no-op today because no event is digest-enabled.)
- **Rollback:** flip the switch off → the digest claim returns nothing. With no live digest event in
  10c-a nothing is stranded. (10c-b, which enables a real digest event, will ship the drain/rollback
  for a live digest audience.)

## Exact schema / RPC contracts (for review)

**Columns (additive, nullable):**
- `notification_outbox.digest_group_id uuid` — set at send to link a group's members (audit + reconcile).
- `email_delivery_events.digest_group_id uuid` — same, on the delivery row.

**New table:** `notification_send_counters(recipient_key text, bucket_kind text CHECK in ('hour','day'), bucket_start timestamptz, sent int NOT NULL DEFAULT 0, PRIMARY KEY(recipient_key, bucket_kind, bucket_start))` — service-role only.

**New RPCs** (all `SECURITY DEFINER`, service-role only, `REVOKE … FROM PUBLIC, anon, authenticated`):
- `claim_notification_digest_group(p_channel text, p_worker text, p_now timestamptz DEFAULT now(), p_max_group_rows int DEFAULT 500, p_stale_after_minutes int DEFAULT 15) RETURNS TABLE(...member cols... , digest_group_id uuid)`
- `record_notification_digest_result(p_worker text, p_outbox_ids uuid[], p_status text, p_provider_message_id text DEFAULT NULL, p_error text DEFAULT NULL, p_terminal boolean DEFAULT false, p_max_backoff_minutes int DEFAULT 60) RETURNS text`
- `reconcile_notification_outbox(p_since timestamptz, p_until timestamptz) RETURNS TABLE(channel text, intended int, sent int, skipped int, failed int, unresolved int, processing_stuck int)`

**Amended:** `claim_notification_outbox_batch` — add `AND NOT digest_eligible(et, o)` to its WHERE
(no-op until an event is digest-enabled). **Reused as-is:** `locked_by/locked_at/attempts/max_attempts/status/scheduled_for/collapse_key`, the ownership-guard pattern, the `email_delivery_events` linkage.

**Types drift:** the 3 new RPCs + the amended one → apply the CI-generated `types.ts` artifact (do not hand-splice).

## Alternatives considered

- **Claim rows individually, then group in JavaScript** — rejected (owner constraint #1): a crash
  between per-row claims splits a digest and risks double-send; grouping must be one atomic statement.
- **Trust `collapse_key`** — rejected (#3): a single mis-set key would mix recipients/tenants; the
  composite equality-partitioned key is the only safe boundary.
- **A separate pre-collapse materializer function/cron** that synthesizes one outbox row per group for
  the existing 1:1 worker — rejected: adds a component, a second cron, and a two-stage state machine
  with its own crash/double-send window; the architecture doc's intent is that *the worker* honors
  collapse. Revisit only if the worker path proves too heavy.
- **Per-event mixed daily digest** (multiple event types in one email) — deferred (out of 10c-a):
  needs a cross-event template + ordering policy; homogeneous per-event digests cover open_slots.

## Consequences

- One worker, two claim paths; the digest path is dormant until 10c-b enables a real event.
- `reconcile_notification_outbox` becomes the standing run-level proof for **all** v2 sends (not just
  digests), retiring the "HTTP response + Slack only" observability gap.
- `notification_send_counters` + the quiet-hours defer are reusable by every future digest event.
- The timezone decision (§6) is the one open input needed before implementation; (A) unblocks 10c-a
  with a global default and a follow-up for per-recipient tz.
- Legacy `notification_queue` + `send-digest-emails` are **not** touched here — they retire in 10c-d
  only after 10c-b proves the v2 digest in production.
