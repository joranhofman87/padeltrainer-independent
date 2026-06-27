# ADR 0001 — Split the overloaded `cycles` table into `registrations` + `cycles`

**Status:** Accepted (Phase 2 read side + Phase 4 write side shipped).

## Context

`cycles` was overloaded. A single row, distinguished only by a `type` enum (`registration` /
`event` / `cyclus`), held **two unrelated concerns**:

- the **intake form** — sign-up config, form-only `settings` keys, `price_table`, public link; and
- the **training container** — its `availability_slots` → `bookings` → `invoices`, training-only
  settings, plus `intake_requests.cycle_id`.

This made the model hard to reason about, coupled form edits to live training/billing data, and left
the "is this row a form or a training series?" question to a brittle enum. The owner explicitly
distrusted the model.

## Decision

Physically split the two concerns:

- **`registrations`** = the form (config + form-only `settings` + `price_table` + name/status/dates).
- **`cycles` (`type='cyclus'`)** = the training container (owns slots/bookings/invoices).
- Paired **1:1** via `registrations.source_cycle_id`. Creating a form mints a `type='cyclus'` cycle
  **shell** + the registration atomically (`create_registration_with_cycle` RPC) so the
  `intake_requests.cycle_id` link is satisfiable from the moment the form opens.
- `intake_requests` and `invoices` **keep `cycle_id`** (the training link) and gain an **additive
  nullable `registration_id`** (the form link). `proposed_assignments` is unchanged.
- Settings are partitioned by a **single frozen allowlist** (asserted against
  `src/test/fixtures/settingsSplit.golden.ts`).

## Alternatives considered

- **Keep one table + the `type` enum, add discipline.** Rejected — the overloading (and the coupling
  of form edits to billing data) persists; the enum is exactly the ambiguity we wanted gone.
- **Re-point every `cycle_id` → `registration_id`.** Rejected — a large, destructive migration over
  1009 live bookings, and it would break proposals/finalize, which legitimately key on `cycle_id`.
- **Full split with the cycle kept as the training owner (CHOSEN).** Additive, non-destructive, and
  leaves the proposal/booking/invoice graph untouched.

## Consequences

- Migration is **additive / non-destructive**; proposals + finalize are unchanged (they key on
  `cycle_id` / `cyclus_id`).
- Dual-read via `registrationToCycle` maps a registration to a cycle-shaped object with
  `id = source_cycle_id` (this mapping is **intentional**, a recurring point of confusion).
- Writes go through `create_/update_registration_with_cycle` (atomic shell + form;
  `ON CONFLICT (source_cycle_id)` makes edits backfill-order-independent). The editor falls back to the
  legacy `createCycle` path on `PGRST202` (RPC not yet deployed).
- **Cost:** two tables to keep coherent — the settings allowlist + golden test is the anti-divergence
  guard. A `type='cyclus'` shell with no slots can exist (a form whose training hasn't been built yet).
