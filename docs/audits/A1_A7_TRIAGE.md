# A1–A7 audit triage — classification and closure ledger

Independent audit: `codex/foundation-audit-a1-a7` @ `8bf23f71`, against deployed baseline
`5c339be5`. Report: `git show codex/foundation-audit-a1-a7:docs/audits/FOUNDATION_A1_A7_CODEX_AUDIT_2026-08-06.md`.

Every finding was reproduced against the working tree before anything was changed. This file is the
worklog the closure loop requires: what was accepted, what was rejected and why, and what is an
owner decision rather than a defect.

## P1

| # | Area | Classification | Where it stands |
|---|---|---|---|
| **F1** | activation measures enqueue time | **accepted** | **CLOSED** at `8010aa53`, Codex-clear after four correction rounds. `booking_lifecycle_events` gives every transition an immutable `occurred_at`; producers read it through `booking_transition_event` (service-role only, oldest-of-latest, set-wide sha256 discriminator, fail-closed unless EVERY member has evidence). Earlier note: Immutable `occurred_at`, per-path `max_event_age_minutes`, enforcement at every send authority + a BEFORE UPDATE backstop, producers derive the time from the domain row and fail closed. Round 2 corrected a defect in the correction: transitions are dated from `updated_at`, not the booking's `created_at` (see below). |
| **F2** | account deletion fails open | **accepted** | Closed. `runAll` / `runDelete` / `requireRead` check every operation; the auth deletion is unreachable after a failure. Round 2: evidence moved to `account_deletion_audit`, FK-free and two-phase, because the old table cascaded from `auth.users` and destroyed its own record. |
| **F3** / **OD-1** | shared-trainer global identity | **accepted; OD-1 RESOLVED STRICT by the owner 2026-08-06 and implemented** | The cross-tenant risk is closed: a manager cannot touch the global identity of a trainer associated with any tenant they do not manage, and the check counts every non-terminal relationship status, not just `active`. The residual is below. |
| **F4** | non-atomic cycle editing | **accepted** | **OPEN.** Needs one server-owned transactional RPC. Not started. |
| **F5** | DST-unsafe cycle extension | **accepted** | Closed. `planWeeklySessionsAfter` projects the owner-local wall time; the editor uses it. |
| **F6** | paid invoices into generic cancellation | **accepted** | Closed. Paid rows are refused and reported; round 2 added the database-side status predicate to the write, so an invoice paid between the list read and the click cannot be cancelled by a captured id. |

## Core P2

| # | Area | Classification | Where it stands |
|---|---|---|---|
| F7 | person contraction unfinished | accepted | OPEN — bounded compatibility contract or Phase 4. |
| F8 | `get_player_locations` trusts caller refs | accepted | OPEN. |
| F9 | no granular trainer permissions | accepted | OPEN — product-shaped, needs a permission model. |
| F10 | payment recovery is operator-centric | accepted | OPEN. |
| F11 | DR not drilled; no privileged MFA | accepted | OPEN — the drill needs production access (owner gate); MFA is an owner risk decision. |
| F12 | canonical docs carry resolved findings | accepted | OPEN — reconcile after the P1s. |

## Rejected as stale by the audit itself

Not reopened, and not to be reopened without new contrary evidence: overbooking without a lock;
shared-trainer `guest_players` roster leak; paid invoices hard-deletable; Mollie refunds ignored;
the named edge functions failing silently. Each was verified fixed on this tree.

## Queued as a SEPARATE release unit — not in this branch

### Registration → Planning → Calendar redesign

**Status: PENDING. Accepted by the owner, queued, and deliberately NOT implemented here.**

The owner accepted that audit and queued it as its own release unit. It is recorded here so it is
visible in the same ledger as everything else, and so nobody reads its absence from the closure
table as completion. Nothing in this branch implements it, and it must not be marked complete by
this programme.

## Owner decisions

### OD-1 — RESOLVED by the owner, 2026-08-06, in the strict direction

> An academy manager may manage a trainer's membership, academy-specific role and permissions, but
> must never directly change that trainer's global login identity, login email, password or
> credentials. The trainer owns their identity and changes it through self-service. An academy may
> initiate an invitation, email-change confirmation or password-reset flow. A separately authorized
> platform-administrator recovery path may exist, but it must be audited. This applies even when one
> manager currently manages every academy to which the trainer belongs.

**Implemented.** `update-user` refuses every manager caller (`identity_is_self_service`), the
exclusivity carve-out and the dead `club_trainers` grant are gone, and
`profiles_login_identity_guard` enforces it at the mutation boundary. `academy-update-player-email`
refuses outright when the target is a trainer. Proven by `src/test/identitySelfService.pglite.test.ts`,
including the "manages every academy" case the decision names.

**Known remaining OD-1 surface, NOT yet closed:** `create-academy-trainer`, `create-club-trainer`
and `create-admin-trainer` still generate and return a `temporaryPassword` — an academy holding a
trainer's initial credential. They should create the account without one and send an invitation.
The academy/club trainer-edit UIs also still submit global profile fields and now receive a 403
rather than a disabled field.

## F1 — how it was closed (was: "not closed")

Everything structural is in place: `occurred_at` is immutable and never future-dated, every send
authority enforces `greatest(boundary_at, now() - max_event_age)`, a BEFORE UPDATE backstop catches
any other route into the pipeline, producers derive the time from a domain row and fail closed when
they cannot, and ten mutants prove each guard load-bearing.

What is not right is the value fed into it for transitions. `bookings.updated_at` is a generic
touch timestamp refreshed by every write to the row, so:

* an unrelated later edit (notes, attribution, payment metadata) re-dates a historical
  cancellation or confirmation forward and past the floor;
* for a message covering several bookings, `max(updated_at)` lets ONE recently edited member
  re-date the whole historical set.

That is the same laundering the column exists to prevent, arriving through the value instead of
through an UPDATE. Using `created_at` instead is not an option — it re-creates the delivery-loss
defect (a current cancellation of an old booking dated three weeks back, refused, never sent).

**The fix is event-specific immutable timestamps** — `paid_at`, `cancelled_at`, `confirmed_at`, or
a booking status-history ledger — which `bookings` does not currently have. Schema change plus
producer changes plus their own regressions; it is the next unit of work, not a patch.

**Until then:** the no-backlog contract is provable on ENQUEUE time and on the boundary/age floor,
and is NOT yet provable on true event time for booking transitions. No channel may be activated on
the strength of the event-time claim.

## Round-2 corrections (defects the corrections themselves introduced)

Recorded because a fix that creates a new defect is worth as much attention as the original:

1. **Dating every booking message from `created_at`.** Truthful for a booking request, false for a
   confirmation, payment or cancellation. A cancellation of a three-week-old booking was dated three
   weeks back, fell under the event-age floor, and became permanently unsendable — a backlog risk
   traded for silent delivery loss. Now: `created` → `min(created_at)`, `transition` →
   `max(updated_at)`.
2. **Auditing a deletion into a table that cascades from the deleted user.** Moving the insert
   earlier only inverted the problem: the record then existed exactly when the deletion had failed.
   Now a dedicated FK-free, append-only, two-phase table.
3. **Cancelling by id alone.** The status partition used what the client had last read; the write
   now re-checks the status in the database.
4. **Querying a table that does not exist.** The trainer-authority module read `club_trainers`,
   which no migration creates. Because it (correctly) checks the error and fails closed, every
   manager lost the capability the rule was written to preserve — and the unit test hid it by
   serving an in-memory fake of that table. A fake is only evidence about tables the migrations
   actually create; there is now a spy pinning which tables the function reads.
5. **A two-phase audit whose terminal writes were unchecked**, so a completed deletion could leave
   a record saying it had never finished.
6. **Reporting cancel candidates as cancelled.** The database predicate refused the raced paid row;
   the result still counted it, and would have annotated a paid invoice with a cancellation reason.
7. **Exclusivity answered with `status = 'active'`.** An invited or paused association read as
   absent, so a manager gained authority over a trainer another tenant was mid-onboarding. Now every
   non-terminal status counts as a claim.
