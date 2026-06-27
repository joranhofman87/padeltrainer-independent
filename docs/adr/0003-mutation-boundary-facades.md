# ADR 0003 — Every domain write goes through a canonical facade / RPC

**Status:** Accepted (Phase 1 onward; enforced by convention + the role-isolation lint).

## Context

The same business write was duplicated across role screens with raw
`supabase.from('bookings'|'availability_slots'|'invoices').insert/update/delete` calls — ~133 UI files
carried domain mutations directly. Because each screen reimplemented the rule, they **diverged**, and
the divergences were real money/data bugs:

- removing a player cancelled the booking but didn't reconcile the invoice → **stale billing**;
- deleting a slot ran a client check-then-delete → a concurrent booking was **cascade-destroyed** (TOCTOU);
- a stale Mollie webhook **downgraded a paid booking** to pending;
- "delete booking" hard-deleted the row → lost history + orphaned the invoice `booking_ids`.

These all passed naive per-screen review precisely because the logic was scattered.

## Decision

**Each kind of domain write has exactly one canonical entry point**, and pages/components call it
instead of mutating tables directly:

- a thin, typed **lib facade** for client-side writes (`cancelBookingsAndSync`, `applySlotDeleteToCycle`,
  `applySlotEditToCycle`, `updateCyclePricing`, `createRegistration`/`updateRegistration`, the `sync*`
  invoice reconcilers); or
- a **`SECURITY DEFINER` RPC** when the write must be atomic across rows
  (`apply_slot_delete_to_cycle`, `update_cycle_pricing`, `finalize_cycle_proposals`,
  `create_/update_registration_with_cycle`).

Components stay presentational; the money/data invariant lives in one place. See the full table in
[`../DOMAIN_MODEL.md §5`](../DOMAIN_MODEL.md).

## Alternatives considered

- **Keep per-screen writes, rely on review discipline.** Rejected — that is the status quo that produced
  the bugs above; discipline didn't scale across roles.
- **A heavier repository/ORM layer.** Rejected — overkill for a supabase-js codebase; the thin-facade +
  atomic-RPC pattern gives the single-source-of-truth benefit without a framework.

## Consequences

- The invariant is centralized and **testable against real SQL** (PGlite adapter for the client lib;
  PGlite rehearsals for the RPCs) — the bugs above now have regression coverage.
- New domain writes must **extend the facade / RPC**, not add a raw mutation in a page. The ESLint
  role-isolation rules + the domain-change PR checklist are the guardrails.
- **Cost:** one extra indirection layer, and the discipline to resist a "quick" inline `.update()`.
