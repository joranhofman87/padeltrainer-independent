# ADR 0004 — Rebooking via priority-claim invites + a group captain who books all & pays once

**Status:** Accepted (shipped incrementally; group-captain + upfront-payment in later phases).

## Context

At the end of a term the academy wants to re-book the **same cohort** into the next round. Requirements
that emerged from real academy use (RL Padel):

- invite the existing players rather than silently re-booking them (they may not return, or may want
  different times);
- let a player accept / decline / change times before anything is charged;
- let **one group member re-book the whole group and pay once** for everyone;
- never double-charge, and survive scale (80+ invites, batched, resumable).

## Decision

A **priority-claim** model, not an auto-rebook:

- `bulk-rebook-cycle` mints a **new draft cycle + slots** for the next term (weeks + holiday ranges +
  session price) and creates per-group `slot_priority_claims` — **one `rebook_group_id` per source
  series** — then sends invitations. A draft is invisible/unbookable until committed.
- A player **accepts** → the group is booked. Payment is either upfront (Mollie via
  `create-rebook-invoice`, split divisor = the distinct committed players) or an invoice/bank fallback
  when the academy has no Mollie + no IBAN dead-end.
- The **group captain** path lets one member book the whole roster and pay once; the `mollie-webhook`
  flips **all** of the invoice's `booking_ids` to paid together. A unique index on the invoice
  `rebook_group_id` prevents a double upfront charge.
- The wizard's **dry-run** shows the admin the projected roster + per-group charge before anything is
  created or emailed.

## Alternatives considered

- **Auto-rebook the whole cohort.** Rejected — players may not return or want changes; silently booking
  + charging them is wrong and unrecoverable.
- **Per-player invites only (no group captain).** Rejected — real groups want one person to handle the
  whole court's rebooking and payment; forcing N separate flows is worse UX and risks partial groups.

## Consequences

- Resumable + batched at scale (draft-commit, concurrency-bounded inserts, 429 retry on sends).
- The dry-run preview and the real charge are computed from the **same** inputs (session count via the
  shared `generateWeeklyStarts`, the slot price, the split flag), so the preview ≡ the eventual charge
  (verified; the one inherent difference is "assumes everyone accepts" — the divisor is recomputed from
  actual committed players at invoice time).
- Group payment is the linchpin: the webhook must flip **every** booking in the group's invoice together,
  or some members show unpaid. See [`../DOMAIN_MODEL.md`](../DOMAIN_MODEL.md) for the write boundaries.
