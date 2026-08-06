# A1–A7 audit triage — classification and closure ledger

Independent audit: `codex/foundation-audit-a1-a7` @ `8bf23f71`, against deployed baseline
`5c339be5`. Report: `git show codex/foundation-audit-a1-a7:docs/audits/FOUNDATION_A1_A7_CODEX_AUDIT_2026-08-06.md`.

Every finding was reproduced against the working tree before anything was changed. This file is the
worklog the closure loop requires: what was accepted, what was rejected and why, and what is an
owner decision rather than a defect.

## P1

| # | Area | Classification | Where it stands |
|---|---|---|---|
| **F1** | activation measures enqueue time | **accepted** | Closed. Immutable `occurred_at`, per-path `max_event_age_minutes`, enforcement at every send authority + a BEFORE UPDATE backstop, producers derive the time from the domain row and fail closed. Round 2 corrected a defect in the correction: transitions are dated from `updated_at`, not the booking's `created_at` (see below). |
| **F2** | account deletion fails open | **accepted** | Closed. `runAll` / `runDelete` / `requireRead` check every operation; the auth deletion is unreachable after a failure. Round 2: evidence moved to `account_deletion_audit`, FK-free and two-phase, because the old table cascaded from `auth.users` and destroyed its own record. |
| **F3** | shared-trainer global identity | **accepted, with an owner decision inside it** | The cross-tenant risk is closed: a manager cannot touch the global identity of a trainer associated with any tenant they do not manage, and the check counts every non-terminal relationship status, not just `active`. The residual is below. |
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

## Owner decisions

### OD-1 — a manager may still change the login of a trainer who works ONLY for them

**Decision needed from:** Tom. **Raised:** 2026-08-06. **Risk if left as is:** low, bounded.

The audit's closure criterion for F3 reads: *"global login/identity changes require the trainer, a
platform admin, or an explicit audited consent/recovery flow."* What ships is narrower than that
sentence: a manager who manages **every** tenant a trainer is associated with may still change that
trainer's login and shared profile, audited and with a notice to the old address.

*Why it was not made stricter unilaterally:* academies routinely create their trainers' accounts and
manage them end to end, and that capability is deliberate and in use. Removing it is a product
change, not a bug fix, and it would break a live workflow the day it deployed.

*What is closed regardless:* the cross-tenant case the finding actually describes — academy A
rewriting the identity of a trainer who also works for academy B. That cannot happen now.

*The follow-up if OD-1 is decided the strict way:* route manager-initiated email changes through a
trainer-confirmed link (the same primitive the notification programme already uses for signed
management links), and reduce the manager's write set to tenant-scoped overlay fields only.
**Target:** the trainer-permissions unit (F9), which has to model tenant overlays anyway.

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
4. **Exclusivity answered with `status = 'active'`.** An invited or paused association read as
   absent, so a manager gained authority over a trainer another tenant was mid-onboarding. Now every
   non-terminal status counts as a claim.
