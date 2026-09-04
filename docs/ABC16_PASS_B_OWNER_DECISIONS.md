# ABC16 Pass B §4.1 and durable-authority owner decisions

This memo began as Chat D's record of two questions raised while correcting the Pass B §4.1 draft.
**Both are now RESOLVED** by owner mandate (2026-08-12), in each case with the long-term option
rather than the convenient one. It now also records the resolved ABC-26 ruling, the approved D5
design and its follow-on corrections, and the D6/D7 durable-authority ruling register. Each later
section states its own implementation status; approval does not mean that a pending item has landed.

---

## OD-A — pure-profile arm in `get_academy_undeliverable_recipients` → **RESOLVED: A1**

**Decision.** The reader stays limited to `guest_players.academy_profile_id = p_academy_profile_id`,
the guest's own name and address, and `profile_id = NULL`. No pure-profile/registered arm, no new
authority predicate, and no schema is added in Chat D.

**Why.** A pure profile proves an *account*, not an academy *relationship*. The routes that could
supply the missing half all launder weaker evidence into Class-B authority:

| Candidate route | Class | Why it is refused |
|---|---|---|
| `academy_player_metadata` | A | caller-authored: the academy picks the subject |
| bookings | C | the slot owner picks the subject |
| billing override | A | caller-authored |
| `linked_profile_id` / `twin_of_profile_id` / guest-origin person equality | D | written by an email/name matcher; provenance unreconstructable (see `ABC16_RELATIONSHIP_EVIDENCE.md` §5c) |
| email/name matching | D | the same matcher, applied live |
| `academy_player_memberships` | — | exists (`20261113100000_u1a_academy_player_memberships.sql:25`) but is empty by design, RLS-on with **zero policies**, `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, and has no authorized reader |

**Correction to an earlier draft of this memo.** It claimed that any future
membership→profile projection would *necessarily* rest on Class-D evidence. That was an
overstatement and is withdrawn. A **canonical profile→person self-projection can be valid**: a
profile mapping to its own person is structural, not an inference about two humans being the same.
What is genuinely missing today is (a) a *proof-populated*, lifecycle-governed academy membership
and (b) an authorized reader over it. What remains permanently inadmissible is **guest-origin**
`linked_profile_id` / `twin_of_profile_id` / person equality — that is Class D and must never supply
the projection.

**The removal condition is bounded, not open.** Registered delivery repair returns in the later
composed U2/U1c unit, once all three exist:

1. immutable Class-B attestation for academy membership;
2. lifecycle-governed academy membership that is proof-populated (not backfilled from Class-A rows);
3. a canonical account projection — profile→person self-projection, never guest-origin equality.

**Product consequence, accepted:** registered players do not appear on the academy's undeliverable
fix card in this release. Their address belongs to their account.

---

## OD-B — admin arm on the same reader → **RESOLVED: B1**

**Decision.** The gate stays exactly `is_academy_manager(auth.uid(), p_academy_profile_id)`. No
`is_admin` arm is added.

**Why.** Effective source is manager-only — a bare `academy_managers` EXISTS check
(`20260128121147_8528c5cc-871f-414d-94a1-158564e26e8b.sql`) with no admin arm, direct or inherited.
The rows are a named person's own email address plus their bounce/complaint history; an admin arm
would make that readable platform-wide, and **no support workflow has been demonstrated that needs
it**. An admin who also manages the academy already passes through the existing arm.

**If it is ever required** it must be a separate, purpose-bound, audited support reader or command
with its own owner and its own security review — not a widened arm on a dashboard reader.

---

## What this unblocks

The draft already shipped the A1 + B1 shape, so no behaviour changes. What changes is the record:
the function comment and the install assertions now state the bounded removal condition above
instead of describing an open ambiguity.

---

## ABC-26 — supplementary rebooking priority → **RESOLVED: unavailable for every class**

**Decision (final).** During containment there is no supplementary rebooking priority for anyone:
registered selections, directly owned guests, and exclusion-derived second-bucket selections are
all refused. **Ordinary round creation with zero supplementary priority stays available** and is
unaffected.

**Why all three classes, not just registered.** Each was admitted by a different route, and none of
the three routes survives its own question:

| Class | Route it used | Why it goes |
|---|---|---|
| Registered selections | staff-named profile ids, stored in `cycles.settings.rebook_priority_people` | an account is not proof of an academy relationship |
| Directly owned guests | `guest_players.academy_profile_id` via `filter_academy_priority_ids` | ownership proves who may edit a row, not who is owed a seat ahead of everyone else |
| Second bucket | registered accounts derived from series exclusion | the same withdrawn evidence, one step removed |

Keeping only the guest arm would have been the tempting half-measure. It fails on its own terms:
"this academy created this row" is an editing right, and turning it into a queue position hands the
academy a lever over who gets a scarce seat, decided by a field the academy itself writes.

**The effective composed system after ABC-26**

- `bulk-rebook-cycle` parses supplementary priority **once**, before any write. Any non-empty
  `priorityPeople`, `priorityGuests` or `secondBucketSeriesKeys` — and any blank, non-UUID,
  duplicate, malformed or over-cap entry — returns a typed refusal with **raw** submitted counts and
  writes nothing. Nothing is truncated, de-duplicated or filtered away first.
- `filter_academy_priority_ids` is **retired**: fail-closed body, no runtime EXECUTE for any role
  including `service_role`, signature preserved so types and references still resolve.
- `can_book_member_window` no longer reads `rebook_priority_people`; the two pure-profile arms
  survive, so it is a narrowing, not a deletion.
- `notify-rebook-member-open` **suppresses** stale supplemental and second-bucket recipients from
  rounds created before this change, and keeps only recipients holding a real
  `slot_priority_claims` row.
- Neither wizard can offer, hold or submit a selection: the selector is **removed**, not disabled,
  and both send canonical empty arrays with the exact protocol version.
- Nothing is destructively backfilled. Stored `rebook_priority_*` settings are suppressed on read.

**Protocol.** One authority, `supabase/functions/_shared/priority-unavailable.ts`, re-exported to
the browser. Version equality is **exact** — never `>=` — so a missing, stale, future or malformed
version all fail closed; a future version is never treated as success.

**Rollout order.** Contained bulk and notifier Edge functions first, then the migration/ACL
retirement, then the browser. Do **not** roll Edge below containment while the new migration and
client are live: the retired RPC has no EXECUTE left, so an older Edge build would fail on a call it
should no longer be making.

**The durable replacement** is a purpose-bound, expiring offer on canonical Player/U3 identity, with
UUID offer/command identity, UUID idempotency, tenant-scoped server authorization, deterministic
concurrency, bounded queries, audit and recovery. Its schema is **not** chosen in this pass, and it
never restores email/name/link/twin/person-equality identity.

## D5 — immutable recipient universe (Option A), approved 2026-08-12

The owner chose **Option A** over a post-priority claim-identity freeze (Option B), in these words:

> immutable normalized `rebook_round_recipients` and `rebook_round_recipient_claim_sources`,
> populated atomically when the round is frozen. Snapshot rows — not mutable claims, a cursor,
> count, or digest — are the finite recipient authority. Provenance records source claim/slot/cycle
> UUIDs without restricting later merges, repoints, or deletion. Rows are append-only,
> identifiers-only, retained pending U2 retention/erasure composition. Auto-adopted legacy rounds
> require completed import provenance; ambiguous or possibly sent legacy state remains
> `legacy_review_required`. Any digest is diagnostic only. This authorizes isolated local
> authoring/testing only, not production, backfill, email, commit, push, merge, deploy, or
> activation.

**What made this necessary.** Nothing in the database freezes `slot_priority_claims` identity after
the priority window closes — the manager policy, the merge/repoint functions, cascades and later
status changes can all change the claim set while a round is materializing. Continuation was
therefore an anti-join against a query whose answer could change between two batches of the same
round, remembered by a mutable text cursor. Three losses followed: a claim inserted below the
cursor was unreachable forever, a claim repointed from guest to profile read as a new identity and
could be invited twice, and a claim deleted after its decision left a decision whose subject the
round could no longer enumerate.

**Why not a digest.** A digest detects that *something* moved. It cannot name who, cannot identify
the dropped identity, and two equal digests do not prove that no recipient was added while another
was removed. It is diagnostic only, and this unit does not store one at all.

**Why Option A is additive.** The snapshot holds **no live foreign key** to
`slot_priority_claims`, `availability_slots`, `guest_players` or `profiles`. A restrictive FK to any
of them would block the merges, repoints and deletions the owner decided to keep working — that is
Option B wearing Option A's schema. Those UUIDs are retained as historical provenance, and an
install assertion fails if such an FK ever appears.

### Follow-on owner corrections during authoring

| # | Correction | Where it landed |
|---|---|---|
| 1 | No custom/session GUC as write authority — GUCs are caller-settable and spoofable | Outbox authority is privileges + unconditional triggers; the file contains zero `current_setting`/`set_config` |
| 2 | Outbox recipient shape must be exact | `num_nonnulls(guest, user) = 1`, `recipient_person_id IS NULL`, and trigger arms rejecting dual/contradictory identity |
| 3 | Caller-supplied copy is never authority | Catalog-named server-side descriptor builder; caller payload, template key and public summary are refused for this event |
| 4 | `CASE … THEN (SELECT 1/0)` is not a safe overflow assertion | Replaced with a `stats` CTE gate plus a PL/pgSQL raise after reading the observed count |
| 5 | Freeze only siblings in the exact approved open state | `status IS DISTINCT FROM 'open'` refuses, naming the offending status |
| 6 | Fresh wall clock per decision and at finalization | `clock_timestamp()` per decision and one shared reading for both completion stamps |
| 7 | Map only typed freeze refusals | `WHEN object_not_in_prerequisite_state OR program_limit_exceeded`; everything else propagates |
| 8 | Provenance `source_slot_id` / `claim_status` non-null | Both `NOT NULL`, with a legible pre-check for unreadable claims |
| 9 | Update every reference to the resolver's new 18-argument signature | COMMENT/REVOKE/GRANT corrected; install asserts the exact identity argument list and no overload |
| 10 | The event catalog is itself authority | Runtime DML revoked; unconditional immutability trigger on the security-bearing fields |
| 11 | Freeze the **entire** canonical event row, not selected fields | Whole-row comparison (`to_jsonb(NEW) - 'updated_at'`), so delivery-disabling and channel-rerouting fields — and any column added later — are covered by construction |

### Why the field list was not enough (correction 11)

An enumerated list froze the fields whose *security* meaning was obvious and left the ones that
decide whether anything is delivered at all. Each of these passed every check in the previous
revision:

| Field | Effect of the change |
|---|---|
| `supports_email = false` | the channel loop skips email; every recipient takes a terminal skip and the round finalizes looking healthy |
| `default_email_frequency = 'off'` | same outcome, via preference resolution instead of capability |
| `supports_whatsapp` / `supports_push = true` | reroutes an actionable, window-bound invitation onto an unreviewed channel |
| `collapse_window_minutes` widened | distinct invitations collapse into one |
| `quiet_hours_respect = true` | a short window can expire inside the quiet period |
| a column added by a later migration | unprotected from birth, with nothing to say so |

The row is now frozen whole with `updated_at` as the single exemption. Changing this event is
therefore a schema decision: a future migration must drop the trigger deliberately, change the row
and restore it — a reviewable act rather than a silent `UPDATE`. The incident kill switch is
unaffected: it lives in `notification_channel_kill_switches`, a separate set-only table that never
writes this catalog.

## D6 / D7 durable-authority ruling register (2026-08-13)

This register separates owner approval from local implementation evidence. Approval does not mean
landed, deployable, activated, or production-ready.

| Ruling | Status | Checkpoint meaning |
|---|---|---|
| D6 corrections: immutable cursor-free recipient snapshot and anti-join continuation; five closed claim statuses with only `pending`/`expired` outstanding; `claimed` hard-excluded; decline a conditional veto only when outstanding evidence exists; exact effective function/ACL/trigger evidence | **IMPLEMENTED IN CHECKPOINT 1** | The migration, pure helper, focused tests and boundary prose carry these corrections. This is local implementation evidence only. |
| D7-1: durable terminal-decision authority | **APPROVED / NOT YET IMPLEMENTED** | The current durable outbox can record the already-defined member-open skip decisions, but checkpoint 1 does not land the later durable authority that decides terminal outcomes. |
| D7-2: one UUID-idempotent command ledger/lifecycle authority | **APPROVED / NOT YET IMPLEMENTED** | Checkpoint 1 does not land the single UUID-idempotent command ledger and lifecycle authority, including its deletion behavior and U2-composed retention/erasure command. |
| D7-3: deadline-aware quiet hours plus the 8,000-source ceiling | **APPROVED / NOT YET IMPLEMENTED** | Checkpoint 1 neither changes provider/transport scheduling to make quiet hours deadline-aware nor claims the existing `rebook_round_max_slots_total()` constant is end-to-end enforcement of the approved 8,000-source ceiling. |
| Typed child-lifecycle fencing | **APPROVED / NOT YET IMPLEMENTED** | A sibling status can still be changed through predecessor paths; checkpoint 1 does not add the later round-locked typed child-lifecycle command. |
| Abort-closed legacy adoption | **APPROVED / NOT YET IMPLEMENTED** | Checkpoint 1 does not add the separately approved legacy-adoption behavior, which must abort closed rather than silently adopting an ambiguous legacy sibling. |

No checkpoint-1 edit changes provider policy, activation, cron, deployment, production data, or the
approved behavior of any later D7 unit.
