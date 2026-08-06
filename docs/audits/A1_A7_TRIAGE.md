# A1–A7 audit triage — classification and closure ledger

Independent audit: `codex/foundation-audit-a1-a7` @ `8bf23f71`, against deployed baseline
`5c339be5`. Report: `git show codex/foundation-audit-a1-a7:docs/audits/FOUNDATION_A1_A7_CODEX_AUDIT_2026-08-06.md`.

Every finding was reproduced against the working tree before anything was changed. This file is the
worklog the closure loop requires: what was accepted, what was rejected and why, and what is an
owner decision rather than a defect.

## P1

| # | Area | Classification | Where it stands |
|---|---|---|---|
| **F1** | activation measures enqueue time | **accepted** | **CLOSED** at `8010aa53`, Codex-clear after four correction rounds. `booking_lifecycle_events` gives every transition an immutable `occurred_at`; producers read it through `booking_transition_event` — service-role only, each booking's latest event then the OLDEST of those, a set-wide sha256 discriminator, and no rows unless EVERY member of the set has evidence. The route there is below. |
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

## Scope: what gates N7, and what does not (owner, 2026-08-06)

**The bounded N7 activation contract is authoritative.** A general P1 classification in this audit
does not by itself block N7 — only direct evidence that an item violates a bounded N7 invariant
does. The owner wants notifications live first; the broader foundation programme begins after N7
activation and postflight.

**In the release candidate**, because they *are* the no-backlog contract: F1 (the lifecycle-event
occurrence ledger) and every lifecycle/notification correction on #634.

**Deferred to the post-N7 foundation programme** — recorded here, not implemented now: F4, F7–F12,
FA-1, FA-2, FA-3, the remaining OD-1 trainer-invitation and UI work (the three `create-*-trainer`
endpoints still return a `temporaryPassword`), and the broad person / permissions / billing / DR /
MFA / UI restructuring.

## The release candidate is the combined tree

`integration/notif-n0-n7` (PR #635, targeting `main`) — see
[`N0_N7_INTEGRATION.md`](N0_N7_INTEGRATION.md). Composing the five reviewed heads found three
defects no single-unit review could have seen:

1. the ARMED job-identity assertions had lost N0's ownership re-check — the *post*-activation side;
2. the rollout harness modelled the operator as owning nothing, so 34 scenarios died on
   `permission denied` once N0's restricted role met N4–N7's definer functions;
3. the committed Supabase types had been missing N3's tables since N3, because the drift gate only
   runs on PRs against `main`.

That is the argument for the branch, in three concrete instances.

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

## F1 — the two wrong clocks, and the one that was right

Kept because the route matters: two plausible answers were shipped and withdrawn before the third,
and each failed in a way the other could not.

**`created_at` — immutable, and the wrong question.** A cancellation of a three-week-old booking
was dated three weeks back, fell under the event-age floor, and was never sent. Correctness about
history bought silent delivery loss in the present.

**`updated_at` — the right question, not immutable.** The `BEFORE UPDATE` trigger refreshes it on
every column write, so editing a note, writing a `mollie_payment_id`, rewriting a split share or
anonymising a departed player's history re-dated a year-old cancellation into the sendable window.
That is the laundering the whole mechanism exists to prevent, arriving through the value instead of
through an UPDATE. `max(updated_at)` over a set was worse still: one recently touched member
re-dated every historical one beside it.

**The ledger — the transition gets its own row.** `booking_lifecycle_events` is append-only,
captured by a trigger rather than by the ~15 call sites that write `bookings.status` across UI, lib
and edge, because per-call-site stamping misses one and the one it misses is silent. Four review
rounds then closed four more defects in the fix itself: definer readers granted to `authenticated`
(a cross-tenant timeline disclosure), `ON DELETE CASCADE` beside an append-only guard, an aggregate
that still let a fresh member re-date a mixed set, and a discriminator that never moved when a
*different* member re-transitioned.

**Where it stands:** the no-backlog contract is provable on true event time for booking
transitions. The backfill is deliberately partial — `created` and `paid` only, nothing synthesised
for historical cancellations — so pre-ledger transitions have no row and their notifications are
refused rather than sent. That refusal *is* the no-backlog outcome, and it is a real behaviour
change recorded in the migration header and in NOTIFICATION_OPERATIONS.md.

## Round-2 corrections (defects the corrections themselves introduced)

Recorded because a fix that creates a new defect is worth as much attention as the original:

1. **Dating every booking message from `created_at`.** Truthful for a booking request, false for a
   confirmation, payment or cancellation. A cancellation of a three-week-old booking was dated three
   weeks back, fell under the event-age floor, and became permanently unsendable — a backlog risk
   traded for silent delivery loss. Round 2's answer — `transition` → `max(updated_at)` — was
   itself withdrawn one round later for the laundering described above; the ledger is where this
   ended up.
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
