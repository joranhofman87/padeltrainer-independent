# ADR 0002 — The slot is the single source of truth for what a booking costs

**Status:** Accepted.

## Context

Price information existed in several places: `cycles.total_price`, `cycles.price_table` (the form's
display columns), and `availability_slots.price_per_session`. When billing code read a different field
than pricing code wrote, players were charged the wrong amount. There was no single, unambiguous answer
to "what does *this* booking cost?"

A cycle's sessions can also differ in price (a one-off, a holiday-shortened term, a per-session
override), so a cycle-level scalar can't be the billing truth.

## Decision

**`availability_slots` is the source of truth for the charge.** Specifically `price_per_session`, plus
`split_payment` (whether the price is divided across the group sharing the slot) and `prices_include_vat`.
An invoice is computed from the slots its bookings sit on — never from a cycle-level price.

- `cycles.price_table` / `total_price` are **form display / config**, not the charge.
- The per-player amount on a split slot = `price_per_session / (distinct committed players on the slot)`.

## Alternatives considered

- **Cycle-level price as the truth.** Rejected — can't express per-session price changes or per-slot
  overrides; and the "group" that a price is split across is a property of the *slot*, not the cycle.
- **`price_table` (form columns) as the truth.** Rejected — that is what the registrant *sees* on the
  form; the authoritative charge must live on the bookable unit so edits and overrides are unambiguous.

## Consequences

- Invoice math reads the slot (the registration-pricing golden + invoice paths all resolve to
  `price_per_session`).
- Price edits go through **`updateCyclePricing`** (RPC `update_cycle_pricing`, id-ordered slot lock) →
  recompute the split divisor (`recalc_cycle_split_count` / `syncSplitCountForCycle`) → rebuild unpaid
  invoice line items. You cannot correctly change a price by writing a cycle field.
- The split divisor must be passed as `splitAmongPlayers` to `auto-create-invoice`, or each player is
  billed the full (un-divided) price — an N× overcharge. This is a recurring foot-gun; see
  [`../DOMAIN_MODEL.md §6`](../DOMAIN_MODEL.md).
