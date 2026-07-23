# Notification follow-ups (tracked backlog)

Durable record of out-of-scope findings surfaced during the notification migration, so they
are not lost between PRs. Each has a spawned-task id where one exists.

## Recipient-discovery fail-open sweep (found by PR 10b adversarial verification, 2026-07-22)

The pattern: an edge function resolves a RECIPIENT ADDRESS or the send AUDIENCE from a
`supabase.rpc`/`.from()` read but discards the returned `{ error }` (and/or swallows a throw),
so a lookup failure silently promotes a stale/raw address or shrinks the audience instead of
aborting. This is the doctrine fixed inside `enqueue_booking_notification` and
`sendPlayerBookingConfirmation` in PR 10b; these siblings still carry it and are OUT of PR 10b's
diff.

| # | location | shape | task id | notes |
| - | -------- | ----- | ------- | ----- |
| 1 | `supabase/functions/send-invoice-email/index.ts` (~L120) | `get_invoice_recipient_identity` error discarded → could send an INVOICE to a stale/fallback address | `task_0c403a91` | same RPC + same shape just fixed in booking-confirmation-email.ts; highest signal |
| 2 | ~~`supabase/functions/notify-rebook-member-open/index.ts`~~ | recipient-SET discovery reads (slots→cohort→emails) errors discarded → silent under-notification / **permanent claim** | **RESOLVED in PR 10d** | all of cycle/slots/claims/profile+guest/academy reads now FAIL LOUD; a throw enters the tested `runClaimedCycle` recovery (release the claim → next tick retries); unclaim failure surfaced. Runtime tests in `rebook-member-open.test.ts`. |
| 3 | `supabase/functions/forward-invoice/index.ts` (~L118/128) | bookkeeper recipient set (`invoice_forward_emails`) errors discarded | `task_7b5df2fc` | |
| 4 | `supabase/functions/notify-followers/index.ts` (~L97/116) | legacy follower/profile recipient reads fail open | (fix in PR 10c) | notify-followers is REPLACED by the open_slots durable fan-out in PR 10c, which already fails loud; do not patch the legacy fn |

Fix each per the PR 10a doctrine: inspect the `{ error }` and guard the throw; a returned error
or thrown exception ABORTS the lane (non-200 / error result), and only a successful no-row/
no-email answer uses the designed fallback. Add regression tests mirroring
`src/test/bookingConfirmationEmail.test.ts` ('identity RPC returns an ERROR', 'identity RPC THROWS').

## Slack alert redaction backstop (defence-in-depth, found by PR 10b adversarial verification)

PR 10b routes every failure `detail` in `mollie-booking-paid-side-effects.ts` through
`redactDetail` before it reaches Slack or the durable audit (player lane + all sibling
invoice/staff lanes). But the Slack SINKS themselves do not redact: the per-function
`notifySlackError` in `mollie-webhook/index.ts` and `verify-mollie-payment/index.ts`, and the
shared `notifySlackEdgeError` in `_shared/edge-slack.ts`, spread `...context` verbatim and only
`.slice()` the top-level `errorMessage`. Any OTHER edge function that passes a raw error string
in `error:`/`detail:` context still leaks it to Slack.

Follow-up: add a redaction backstop inside the Slack sink (`notifySlackEdge` / the per-function
`notifySlackError`) so `error`/`detail` string fields are scrubbed centrally — redact only those
free-text keys, NOT structured context (booking-id UUIDs etc., which `redactDetail`'s long-token
rule would otherwise mangle). Not a PR 10b blocker (10b's own lanes are all redacted at the call
site), but the right central defence. No task id yet.

## Guest-first identity — rebook/priority paths (P1 RECIPIENT-ROUTING) — RESOLVED: DEPLOYED + PROD-VERIFIED 2026-07-23 (PR 10d)

CORRECTION (Codex re-review): an earlier version of this entry called these "display-only". That
was wrong. They are P1 WRONG-RECIPIENT bugs, not just wrong names.

PR 10b built the canonical edge twin `supabase/functions/_shared/person-identity.ts`
(`personKeyOf`/`personRefOf`/`personDisplayName`/`personContactEmail`, guest-first, keyed on the
IDs — the keep-in-sync twin of `src/lib/personIdentity.ts`). **PR 10d
(`feat/notif-pr10d-rebook-identity`) applies it as the identity + verified-account pass over the rebook
subsystem.** An audit (completeness critic) proved the same player-first bug spanned more than the
three originally-named senders — the upstream producers collapsed a dual-key child + linked parent
BEFORE the senders ran, so fixing only the senders would have left green tests around
already-corrupted input. Every audit-proven site is fixed guest-first:

| location | was (player-first) | fix |
| -------- | ------------------ | --- |
| `_shared/priority-claim-invite.ts` `resolveRecipient` | `playerEmail \|\| guestEmail` | `personContactEmail(row, …)` |
| `send-rebook-reminder` | target key, dedup, name, reminded-stamp routing | `personKeyOf`/`personDisplayName`/`personRefOf` |
| `send-rebook-group-confirmation` | member grouping, invited-state, email, captain+recipient names, **claim-stamp scope** | `personKeyOf`/`personContactEmail`/`personDisplayName`; stamp scoped `personRefOf` (profile → `player_id AND guest_player_id IS NULL`) |
| `send-priority-claim-invitation` | rep dedup, group aggregation, main-loop lookup, name | `personKeyOf`/`personDisplayName` |
| `bulk-rebook-cycle` (~L988) `repByPlayer` | representative selection collapsed child+parent BEFORE the invite fn | `personKeyOf` |
| `src/lib/rebookManage.ts` (~L531) `keyOf` | built the reminder `targets` player-first | `personKeyOf` (nameByKey renamespaced) |
| `auto-rebook-reminder` (~L164) | reminded-stamp routing | `personRefOf` |
| `notify-rebook-member-open` + `_shared/rebook-member-open.ts` `recipientKey` | player-first grouping, name/email, **RB03 already-notified keys persisted to `cycles.settings`** | `recipientKey` guest-first (format-preserving: pure profile/guest keys byte-compatible, only a dual-key child moves to `g:<child>` for its one catch-up); `resolveMemberOpenContact` guest-first name/email + parent fallback |
| `rebook_claims_needing_auto_reminder` RPC (`20260721100000`) | player-first `DISTINCT ON` + profile-first name/email | guest-first FLAT re-emit (migration `20260927100000`; kept flat, not a CTE, to match the proven structure + avoid a PGlite plan-cache flake) |
| `bump_rebook_reminders` RPC (`20260625130000`) | player arm had no `guest_player_id IS NULL` guard | guarded (migration `20260927100000`) |

SECURITY (fixed in the same migration): `rebook_claims_needing_auto_reminder` is SECURITY DEFINER
and returns recipient email + claim_token cross-academy, but its original migration only
`REVOKE … FROM PUBLIC` — leaving the default `GRANT … TO anon, authenticated` in place (verified in
prod: anon/authenticated = EXECUTE). Now REVOKEd from `PUBLIC, anon, authenticated`, GRANTed to
`service_role` only.

Proofs: `rebookIdentityGuestFirst.pglite.test.ts` (cross-layer — raw claims → RPC grouping →
guest-first routing → stamp; dual-key child mailed at own email; linked-profile fallback only when
absent; parent stamp never touches child and vice-versa; grants locked down — all mutation-verified),
`priorityClaimInvite.test.ts` (resolveRecipient guest-first), `rebookIdentityWiring.test.ts` (every
call site wired to the twin). NOT flipped to fully "resolved" until PR 10d is deployed and verified
in prod (migration first, then all edge fns).

`bulk-rebook-cycle:493` (`registeredPlayerIds` for `computeRebookExclusion`) is consciously left
alone — it is eligibility bucketing, not notification identity; changing it would alter rebook
eligibility semantics (an unrelated refactor).

## Rebook SECURITY DEFINER RPC lockdown (closed in PR 10d migration 20260927100000)

The default-privileges footgun (`REVOKE … FROM PUBLIC` alone does NOT undo the project's default
`GRANT EXECUTE TO anon, authenticated`) left FOUR service-role rebook RPCs client-executable — all
verified live in prod (anon = authenticated = EXECUTE). Migration `20260927100000` REVOKEs each from
`PUBLIC, anon, authenticated` and GRANTs `service_role` only, pinned by `has_function_privilege`
assertions in `rebookIdentityGuestFirst.pglite.test.ts`:
- `rebook_claims_needing_auto_reminder(int)` — leaked invitee emails + claim tokens cross-academy.
- `rebook_cycles_needing_member_open_notice()` — leaked the cross-academy cycle list.
- `claim_rebook_member_open_notice(uuid)` — an attacker could SUPPRESS a cycle's member-open notices.
- `unclaim_rebook_member_open_notice(uuid)` — an attacker could force re-notification spam.

## PR 10c (durable outbox) — REQUIRED acceptance items carried from PR 10d review

PR 10d hardened `notify-rebook-member-open` substantially — every recipient is now checkpointed
ATOMICALLY as it sends (`append_rebook_member_open_notified`, no whole-settings read-modify-write),
the send carries a deterministic Resend `Idempotency-Key` (`member-open:<cycle>:<key>`), reads fail
loud, and a returned OR thrown failure releases the claim (`runClaimedCycle`). But it is still NOT
fully crash-safe at scale, and this residual must be closed by the PR 10c durable-outbox migration
(do NOT expand 10d):
- The cycle is CLAIMED (settings.rebook_member_open_notified_at) before an UNBOUNDED sequential send
  loop. A hard PROCESS DEATH mid-loop BYPASSES the release, so the cycle stays PERMANENTLY CLAIMED —
  the already-checkpointed recipients are safe, but the un-sent tail is never re-detected/delivered.
  (A returned/thrown error DOES release + retry; only an abrupt death does not.) The outbox must make
  each recipient a durable, independently-resumable unit so no death can strand an audience.
- Acceptance for "the messaging migration is complete/scalable": bounded + resumable processing and
  NO permanent claim after worker death — for the member-open path as well as open_slots. (The
  deterministic idempotency key + atomic per-recipient checkpoint are already in place from 10d.)

## Codex round 3 — resolved (PR 10d), + corrected claims

Round-2's account resolver initially claimed "exact authorization parity" and "full closure"; both
were premature. Round-3 corrections:

1. **All THREE manual senders now use the verified resolver** (`_shared/rebook-guest-contact.ts` →
   `resolve_guest_member_contacts`): `send-rebook-reminder`, `send-priority-claim-invitation`,
   `send-rebook-group-confirmation`. A guest is reached at their OWN email then their VERIFIED
   account, NEVER the raw `claim.player_id`. (Round 2 had only fixed member-open + auto-reminder.)
2. **Twin/linked bridge suppression** (owner-approved eligibility change): `can_book_member_window`
   was a UNION (`person_links OR twin OR linked`) while the resolver gave person_links precedence.
   Migration `20260928100000` makes curated `person_links` SUPPRESS the twin/linked bridge in both
   guest arms, so a stale twin cannot grant a different account than the curated one. Pre-deploy
   audit: 0 conflicting guests in prod (0 with claims / priority) → no current access lost.
   **NOT yet full parity** — see round-4 #2 below: clauses (a)/(b) still keyed the RAW `player_id`,
   granting the parent of a dual-key row; closed in round 4, but the shared `is_cycle_member`
   primitive (capacity/slot-tier) is still raw-keyed and is owned by the dedicated auth-hardening PR.
3. **Group-confirmation** is now send-THEN-stamp with a deterministic Resend idempotency key (was:
   claim-before-send with no key → timeout-dup + a failed clear permanently suppressed). The key
   dedupes for Resend's 24h window ONLY; a post-send stamp failure now returns `ok:false, unresolved>0`
   (round-4 #3) and durable recovery of unresolved sends remains a PR 10c acceptance item.
4. **Rate limiter** is one atomic `consume_rate_limit` RPC, fail-CLOSED (was: fail-open, race-prone
   read-modify-write on a `verify_jwt=false` endpoint).
5. **Manage UI** reachability (`guests_have_rebook_contact`, a boolean-only academy RPC) mirrors the
   verified delivery model, so it no longer advertises a route the sender skips (person-links/twin
   guests). The account ADDRESS is never exposed.

## Codex round 4 — resolved (PR 10d), + one OWNED follow-up PR

1. **Oracle scoping** — `guests_have_rebook_contact` was a cross-tenant boolean oracle (any
   authenticated user could probe any guest's contact-presence). Now scoped: the guest must belong
   to an academy cycle the caller manages (`academy_managers.user_id = auth.uid()`), array capped at
   1000, `anon` revoked. Returns rows ONLY for authorized guests.
2. **FAM-02 across every `can_book_member_window` arm** — Codex reproduced that clauses (a) and (b)
   still keyed the RAW `player_id`, so the PARENT of a dual-key row was granted the member window.
   Closed in `20260928100000`: clause (a) is inlined guest-safe (pure-profile booking matches
   `guest_player_id IS NULL AND player_id = me`; a guest booking matches only when its VERIFIED
   account resolves to me — raw `player_id` is never identity proof); clause (b) is guarded with
   `guest_player_id IS NULL` (a dual-key claim belongs to the guest, handled by (d)). Tests prove the
   parent is DENIED while the guest's verified account remains ELIGIBLE (canBookMemberWindowPerson).
   **OWNED FOLLOW-UP (dedicated auth-hardening PR, before PR 10c — do NOT leave unowned):** the shared
   `is_cycle_member` primitive (used by capacity + slot-tier) is still raw-`player_id` keyed. That PR
   must: redefine `is_cycle_member` guest-safe, add a current-user wrapper, migrate `priorityClaims.ts`
   to the wrapper, REVOKE the arbitrary-user function from PUBLIC/anon/authenticated, and regression
   across capacity/slot-tier/member-window/guest/pure-profile/dual-key.
3. **Group-confirmation durability** — a post-send stamp failure no longer returns `ok:true`: it
   increments `unresolved`, alerts with the member key, and returns `ok:false, unresolved>0`. Comments
   corrected to state provider idempotency is a 24h mitigation ONLY; durable recovery of unresolved
   sends is a mandatory PR 10c acceptance item (the v2 outbox), NOT guaranteed here.
4. **rebookManage error propagation** — the three `Promise.all` reads (profiles, guests, guest
   contacts) now destructure and THROW their errors instead of silently coercing a failed query to
   "no email" (which would have mislabeled reachable members as unreachable).
5. **Docs/comments** — this file (parity claim above), the group-confirmation header (was stale
   "claim-before-send"), and the send-then-stamp comment all corrected.

## Codex round 5 — resolved (PR 10d), + one OWNED reliability-sweep follow-up

Contained reliability pass (no P1s remained). Four findings:
1. **`guests_have_rebook_contact` silent cap → fail loud** — the `cardinality <= 1000` WHERE predicate
   silently returned an EMPTY set for a >1000-id request (UI reads absent → "no contact"). Now plpgsql
   that RAISEs above 1000 (signature unchanged → no drift); the client `fetchGuestRebookReachable`
   chunks into <=1000 batches AND throws if any requested id is absent from the union.
2. **`getCycleRebookStatus` fails loud as a class** — every read (cycle/siblings/slots/claims/single+
   group-invoice/contacts) throws on error; only the 42703 missing-column deploy-window fallback is
   tolerated (its own retry also throws). `AcademyRebookManage` renders an isError+retry state.
3. **Group-confirmation partial result has a consumer + regression** — extracted the send/stamp loop
   into `_shared/rebook-group-confirm.ts` (`groupConfirmOk = failed===0 && unresolved===0`, so a
   provider send failure ALSO returns ok:false); the fire-and-forget client caller inspects the result
   and `logger.warn`s on ok:false/unresolved/failed.
4. **Stale `20260928100000` header** — corrected (it claimed clauses (a)/(b) unchanged; round 4 made
   them guest-safe).

**The round-5 "FOLLOWUPS_ONLY, no P1" verdict was WRONG (corrected by Codex round 6):** the send
lifecycle held two P1 classes (a silent invitation permanent-suppression window + throttle reporting
clean success). All of it is now closed in round 6 (below). The 5 same-class sites the round-5 hunt
found (task #31) were also folded into round 6, not deferred.

## Codex round 6 — resolved (PR 10d)

**NOTE (corrected by round 7):** the round-6 "full reliability closure" / "scale boundaries closed"
claims below were PREMATURE — they validated the isolated helpers, not the production caller contracts
or the high-volume discovery paths. Round 7 (next section) closes those. The round-6 fixes themselves
are correct.


Consolidated pass; Codex reproduced two remaining P1 classes plus scale gaps. All fixed with runtime,
mutation-verified tests (no source-regex).

1. **send-priority-claim-invitation — fail loud across the WHOLE send lifecycle + no permanent
   suppression.** Every metadata read (slot, academy, cycle, group-claims) now fails loud and the
   group-claims read is PAGINATED — extracted into `_shared/rebook-invitation-context.ts`
   (`loadInvitationMetadata`), runtime-tested per error path + a 1500-session no-truncation test. The
   send loop is now SEND-THEN-STAMP with a deterministic idempotency key (`_shared/send-then-stamp.ts`
   `sendThenStampOne`): a failed send never stamps (structurally removing the old claim-before-send
   permanent-suppression window where send-fail + a failed invited_at-clear stranded the claim
   forever); a post-send stamp failure is UNRESOLVED (surfaced), not an idempotent skip. Switched from
   the Resend SDK to the shared `sendResendEmail` (idempotency-key + 429 backoff; `ResendSendPayload`
   widened with reply_to/headers).
2. **send-rebook-group-confirmation throttling is not clean success.** The throttle return is now
   `ok:false, throttled:true`; the fire-and-forget client caller inspects `throttled` AND `skipped>0`
   (a skipped member = no email for someone the captain just booked) and `logger.warn`s. Pinned incl.
   the 7th-call throttle case.
3. **Scale boundaries closed.** `send-rebook-reminder` claim discovery paginated + its 200-recipient
   cap returns a resumable `remaining` boundary (Slack-alerted + surfaced in the manager UI, never a
   silent slice); the priority-invitation group-claims paginated (in loadInvitationMetadata);
   `notify-rebook-member-open` profile/contact reads chunked <=1000 + exact-set checked; NEW partial
   index `slot_priority_claims(guest_player_id) WHERE guest_player_id IS NOT NULL`
   (20260929100000) backs guests_have_rebook_contact. 1001/1500-row no-truncation tests added.
4. **Task #31's fail-loud fixes landed here** (not deferred): `getMyPendingPriorityClaims` throws on
   the cycles read error (was: wrong player-facing payment copy); `create-rebook-invoice` inspects
   both thrown AND resolved `send-invoice-email` errors + alerts (kept non-blocking).
5. **i18n:** `rebookManage.loadFailedTitle/loadFailedBody` added to en+nl; the retry button key fixed
   (`common:retry` did not resolve → English users saw the Dutch fallback; now `common:queryError.retry`).
   Rendered error/retry state runtime-tested.

## Codex round 7 — resolved (PR 10d): caller contracts + high-volume discovery

Round 6 fixed the helpers; round 7 fixes the CALLER CONTRACTS and the high-volume DISCOVERY reads the
helpers sit behind:

1. **Drain propagates `unresolved`** — `SendChunkResult` / `drainRebookInvites` /
   `drainRebookRoundInvites` / the `bulk-rebook-cycle` inline caller now carry `unresolved` +
   `unresolvedClaimIds`. A drain is `drained` ONLY when `remaining + failed + unresolved === 0`; a
   terminal all-unresolved batch stops as retryable `'unresolved'` (not `drained`). Runtime test:
   `{sent:40, unresolved:40, remaining:0}` is NOT drained (mutation-verified).
2. **Reminder = exact identity BATCHING** — the client dedups by person and sends `<=200`-identity
   batches (each identity exactly once, no dup on retry); the server processes ALL provided targets
   with NO silent cap (a defensive ceiling ERRORS loudly), returns `failedTargets`, and `ok = failed
   === 0`. The UI keeps ONLY the failed identities selected + the composed text for a one-click retry.
3. **KEYSET pagination on every discovery read** (`_shared/paginate.ts` `fetchAllKeyset`) — replaces
   offset `.range()`, which skips a row when a claim leaves `status='pending'` mid-read.
4. **Reminder `ok` reflects completion** — any send failure → `ok:false`.
5. **Fail-loud sweep completed** — the emailless-recipient stamp + cycle-settings fallback read throw.

## Codex round 8 — resolved (PR 10d): caller-contract + query-shape fixes

Round 7 stated the contracts; round 8 fixes the failing paths its tests didn't exercise:

1. **Drain never reports outstanding work as `drained`** — the `sent:0 && remaining>0` exit is now
   `no_progress`, and hitting `maxIterations` is a new `iteration_limit` outcome with the real
   `leftover` (was `drained`/leftover 0 — a 100k run would have reported success with 80k outstanding).
2. **Inline round creation surfaces unresolved** — `bulk-rebook-cycle` returns `failed`, `unresolved`,
   both id sets, and `ok = failed===0 && unresolved===0`; both wizards show a partial/retry state.
3. **A configured-off reminder batch is a WHOLE-BATCH failure** — the client no longer reads
   `{ok:false, failed:0}` (e.g. `email_not_configured`) as a clean send; UI branches on `!ok||failed>0`.
4. **Reminder claims discovery viable at slot volume** — slots batched by 200 + claims keyset-paged.
5. **Group-confirmation member + invited-state reads keyset-paginated** — a >1000-claim group no
   longer truncates.
6. **The keyset helper fails CLOSED on a stalled cursor** — a non-advancing key returns an error.

## Codex round 9 — resolved (PR 10d): shared orchestration + production-connected tests

Round 8 fixed the accounting but a live wizard still bypassed the resumable architecture, and several
tests exercised toy paths. Round 9 makes the contracts hold in production and testably so:

1. **ONE shared create-then-drain orchestration** (`createAndDrainRebookRound` in
   `rebookInviteSend.ts`) — BOTH wizards (RebookCohortWizard was still sending inline) now create the
   round without sending (`skipInvites + roundAware`) and drain in bounded resumable chunks. No inline
   blast can leave a committed round half-sent. Unit-tested (create-skip-invites, deferred drain,
   inline-legacy accounting), mutation-checkable.
2. **Discriminated creation-vs-delivery contract** — `bulk-rebook-cycle` tags creation failures
   (`nothing_to_rebook` / `already_exists` / `slot_overlap`) with `phase:"creation"` and NO
   `targetCycleId`; the success path is `phase:"delivery"` + `targetCycleId`. The orchestration returns
   `{phase:'creation_failed'}` vs `{phase:'created', ...}` so a client only shows partial-delivery
   recovery when a valid round id exists. `nothing_to_rebook` no longer reads as "round created".
3. **Group-confirmation gates the EXPENSIVE scan behind a cheap probe + the rate limit**
   (`gateGroupConfirmation`): a `limit(1)` work probe first (no-work → no consume), then the atomic
   allowance (throttled → no scan), then the full paginated scan. A throttled token can't force
   repeated expensive scans on the `verify_jwt=false` endpoint. Ordering unit-tested.
4. **Tests connect to production wiring** — the chunk+keyset the 3 senders use is the shared
   `fetchAllInChunks` (batch-boundary + keyset + fail-loud tests); the group gate + the orchestration
   are the exact production helpers, unit-tested. **Architectural pins added in round 10**
   (`rebookOrchestrationWiring.test.ts`) read the real source so reverting the wiring fails.

## Codex round 10 — resolved (PR 10d): honest error accounting + wiring pins

Contained follow-up (no P1):

1. **Drain error accounting is honest** — `DrainResult.leftover` / `RoundOrchestrationResult.leftover`
   are now `number | null`: a send that threw yields `null` (UNKNOWN), never a fabricated `0`. (Round 10
   still kept the prior count after a mid-drain throw; **round 11 tightened this** — ANY error ⇒ `null`,
   because a network exception can land after the edge sent; the stale count is now exposed separately
   as non-authoritative `lastKnownLeftover`.)
2. **Partial-delivery copy fixed** — the reversed "{{left}} of {{sent}} sent" is now "{{sent}} sent;
   {{left}} remain" (EN + NL); a no-numbers `partialUnknown` / `invitesPartialUnknown` variant covers
   the unknown-count case.
3. **Mutation-verified caller pins** — `rebookOrchestrationWiring.test.ts` asserts both wizards call
   `createAndDrainRebookRound` (never a non-dryRun inline `bulk-rebook-cycle`), the group handler keeps
   the full scan behind `gateGroupConfirmation`, and all three discovery senders use `fetchAllInChunks`.
   Mutation-verified: renaming a wizard's helper call fails the pin.
4. **RebookCohortWizard shows drain progress** — it now forwards `onProgress` and renders "X/Y sending"
   instead of an indefinite spinner, matching AcademyNewRoundWizard.

## Codex round 11 — resolved (PR 10d): distributed-error semantics + genuinely load-bearing pins

Final contained correction before deployment review (no P1):

1. **ANY thrown send ⇒ unknown remainder** — not only a first-chunk throw. A network exception can land
   AFTER the edge sent messages but before the client saw the response, so even a prior chunk's count is
   a stale UPPER BOUND. `stoppedReason === 'error'` now always yields `leftover: null`; the prior
   observation is exposed separately as non-authoritative `lastKnownLeftover`. Tests updated.
2. **Round-wide progress** — `drainRebookRoundInvites` now rebases BOTH numerator and denominator onto
   the round (was a per-cycle denominator → impossible "5 / 3"). Test asserts progress `total` never
   decreases and is always `>= sent`.
3. **AST-structural wiring pins** (`rebookOrchestrationWiring.test.ts`) replace the token-co-occurrence
   pins (which a scan-before-gate or a dead-helper-call-plus-unbounded-query could false-pass). Using
   the TypeScript AST they prove the real call graph: the member scan is INSIDE `gateGroupConfirmation`'s
   `scan` step; every `.in("slot_id", …)` claims read is INSIDE `fetchAllInChunks`; every direct
   `bulk-rebook-cycle` wizard invoke passes `dryRun`. **All three Codex-named mutations verified to
   fail** the pins (scan-before-gate; unbounded query + dead helper call; non-dryRun wizard invoke).

### PR 10c (durable outbox) — REMAINING durability items NOT closed by this PR

To be honest about the boundary (Codex round-7): this PR makes the current behavior CORRECT and
HONEST at volume, but does NOT build durable delivery. These stay PR 10c acceptance items:
- **Throttled / failed / unresolved GROUP CONFIRMATIONS have no durable queue.** Round 7 stops a
  no-work call from consuming the rate-limit allowance and surfaces the non-clean result, but a
  throttled 7th-in-15min confirmation still relies on an idempotent re-trigger, not a queue. The
  durable retry belongs in the v2 outbox.
- **Unresolved invite/confirmation sends** (email out, stamp failed) are surfaced + retryable via a
  re-drain, but their durable, crash-safe recovery is the v2 outbox (the deterministic idempotency key
  is only a 24h mitigation).
- **Member-open** remains claim-then-unbounded-loop; a hard process death mid-loop still strands the
  un-sent tail (documented below) — the durable per-recipient outbox unit closes it.

### PR 10c (durable outbox) — additional REQUIRED acceptance item (Codex #6)

The batch resolver is set-based enough for member-open's low volume but NOT high-volume ready:
`resolve_guest_member_contacts` invokes the `SECURITY DEFINER` scalar `guest_verified_account_profile`
per guest via a LATERAL join, and the auto-reminder SQL invokes it per claim; the member-open edge
fetches every due row and applies its 500 cap in JS. For high volume this becomes repeated subqueries
+ unnecessary network materialization. PR 10c must resolve identities set-wise and push a
deterministic limit/pagination boundary into SQL (with a scale test) — for the auto-reminder + open_slots
paths as well.

## Codex round 12 — resolved (PR 10d): release-readiness (no P1 implementation bug)

Final release-readiness correction, not another architectural round:

1. **P1 deploy blocker — stale runbook.** The PR-body deploy section listed 1 migration + 6 edge
   functions; the branch actually ships **3 migrations + 7 edge functions**. Corrected in the PR body
   AND captured durably below (§ PR 10d — DEPLOY RUNBOOK). It now names all 3 migrations
   (`20260927100000`, `20260928100000`, `20260929100000`) and all 7 functions including the
   previously-omitted `create-rebook-invoice` (its own `index.ts` changed — the `send-invoice-email`
   error-inspection fix; all 7 entrypoints carry a changed `index.ts`).
2. **P2 quiet window is now an enforceable switch + forward-only recovery.** "Hold send-rebook-reminder"
   was an operator instruction, not a switch. The runbook now pins the **enforceable** control
   (deactivate the two crons via `cron.alter_job(active := false)`, verified against `cron.job` +
   `cron.job_run_details`) and scopes the manual-sender exposure to a short off-hours window whose
   residual risk is *bounded and not new*. Recovery is **forward-only**:
   on an edge-deploy failure, keep crons paused and re-run the deploy — **never roll back
   `20260927100000`**, which closes the live ACL leak.
3. **P2 index preflight — done (read-only prod, 2026-07-23).** `slot_priority_claims` = **3,205 rows /
   1.5 MB table / 3 MB total**. The non-concurrent `CREATE INDEX` in `20260929100000` finishes in ms
   with a brief write-lock; `CONCURRENTLY` is not warranted. Also re-ran the `20260928100000`
   person_links-vs-twin conflict audit = **0 conflicting guests**.
4. **P3 test gap — `invokeBodyHasDryRun` accepted `dryRun: false`.** The wiring pin only checked that the
   property existed. Tightened to `invokeBodyHasDryRunTrue` requiring the literal
   `TrueKeyword` initializer; mutation-verified that flipping a wizard's `dryRun: true → false` now
   FAILS the pin ("a direct bulk-rebook-cycle invoke is not dryRun:true ⇒ inline-send bug").
5. **Post-fix adversarial self-review of the runbook** (3 independent lenses + completeness critic)
   confirmed the deploy ACTIONS complete/correct (3 migrations + 7 fns) but caught VERIFY-step defects,
   now fixed in the runbook below: (a) the blanket `authenticated=false` criterion was FALSE for
   `guests_have_rebook_contact` (`authenticated=TRUE` by design — REVOKE would break the manage UI);
   (b) `rebook_claims_needing_auto_reminder` (THE leak RPC) was missing from the enumerated verify set;
   (c) NO frontend-ordering step existed although `rebookManage.ts:61` throws on the new
   `guests_have_rebook_contact` (fail-closed: frontend must ship AFTER the migration); (d) "migrations
   apply transactionally (nothing partial)" overstated ACROSS-set atomicity — each file is its own
   txn, so a mid-set failure leaves `20260927100000` committed (which only reinforces never-roll-back).
6. **Codex round 13 sharpened the runbook** (still no code change): (a) the prose grant carve-out is
   now an EXACT per-signature ACL matrix (11 functions) + a copy-paste `has_function_privilege`
   verification query — read-only prod baseline confirmed the live leak (`rebook_claims_needing_auto_reminder`
   + the member-open trio are `anon/authenticated=true` today; the 5 resolvers absent); (b) crons are
   paused via `cron.alter_job(active := false/true)` (preserves the Vault-backed command + schedule),
   NOT `cron.unschedule` (which deletes them) — verify exactly two jobs (jobids 7 + 8) before and
   after; (c) partial-migration recovery now says: keep crons inactive, `supabase migration list
   --linked` to identify which versions landed, fix forward, re-push only the remaining files; (d)
   `create-rebook-invoice` redeploy reason corrected (its OWN `index.ts` changed; it does not import
   `resend-send`).
7. **Codex round 14 — two docs-only findings closed** (this section had stale narrative even after the
   round-13 runbook fix): (a) the cron control now uses a reusable **cron-state query** joining
   `cron.job` with `cron.job_run_details`, run at all three boundaries (before pause / after pause /
   after resume) — it must show exactly two jobs, `running=false`, `active` transitioning
   `true → false → true` (deactivating does NOT stop an in-flight run, so `running=false` is required
   before migrating). (b) The round-12 items 1–2 above still carried the OLD wrong wording
   (`create-rebook-invoice`'s `index.ts` "unchanged"/bundles `resend-send`; `cron.unschedule`) — both
   corrected here, plus the runbook's generic "some entrypoints unchanged" claim removed: **all 7
   entrypoints have a directly changed `index.ts`** (verified `git diff origin/main...HEAD`).

### PR 10d — DEPLOY RUNBOOK (authoritative; supersedes the PR-body notes if they ever drift)

**Status: DEPLOYED + PROD-VERIFIED 2026-07-23** (executed under explicit owner authorization at
`55368ded` — 3 migrations pushed, all 7 edge fns ACTIVE at bumped versions, Vercel production deploy
success, exact ACL matrix verified [leak closed], crons cycled `active true→false→true`, first
`notify-rebook-member-open` execution succeeded). Runbook retained below for the record + as the
template for the follow-up. A follow-up (`20260930100000`) adds a `start_time > app_now()` guard so a
past session can never auto-remind; it deploys by plain `db push` (no edge/frontend/cron change).

**Preflight (read-only prod, 2026-07-23):**
- `supabase db push --dry-run --linked` → exactly **3 pending migrations** (below), nothing else.
- `slot_priority_claims` = **3,205 rows / 1.5 MB / 3 MB total** → non-concurrent index safe.
- person_links-vs-twin conflict re-audit for `20260928100000` = **0** conflicting guests. Re-run
  immediately before applying `20260928100000`; do NOT apply if unexpectedly > 0.

**Migrations (3, in order):** `20260927100000_rebook_identity_guest_first` (guest-first RPCs +
`bump_rebook_reminders` guard + ACL lockdown closing the live cross-academy leak) →
`20260928100000_can_book_member_window_person_links_precedence` (FAM-02 guest-safe clauses) →
`20260929100000_spc_guest_player_id_index` (partial index backing `guests_have_rebook_contact`).

**Edge functions (redeploy ALL 7):** `auto-rebook-reminder`, `bulk-rebook-cycle`,
`create-rebook-invoice`, `notify-rebook-member-open`, `send-priority-claim-invitation`,
`send-rebook-group-confirmation`, `send-rebook-reminder`. **All 7 have a directly changed `index.ts`**
(verified `git diff origin/main...HEAD` — incl. `create-rebook-invoice`, whose `index.ts` carries the
`send-invoice-email` error-inspection fix and does **not** import `resend-send`); several also bundle
changed `_shared` modules (`paginate`, `priority-claim-invite`, `rebook-group-confirm`,
`rebook-guest-contact`, `rebook-invitation-context`, `rebook-member-open`, `resend-send`,
`send-then-stamp`). No entrypoint is skippable.

**Steps:**
1. **Deactivate** the two crons — do NOT `cron.unschedule` (that DELETES them; the resume step then
   has nothing exact to recreate). `cron.alter_job(active := false)` preserves the Vault-backed command
   + schedule. Use this reusable **cron-state query** at EVERY boundary (before pause, after pause,
   after resume) — it must always return exactly two rows with `running=false`:
   ```sql
   -- CRON-STATE QUERY (reusable at every boundary)
   SELECT j.jobid, j.jobname, j.schedule, j.active,
          EXISTS (SELECT 1 FROM cron.job_run_details d
                  WHERE d.jobid = j.jobid AND d.status = 'running') AS running
   FROM cron.job j
   WHERE j.jobname IN ('auto-rebook-reminder','notify-rebook-member-open')
   ORDER BY j.jobname;
   ```
   (a) **BEFORE:** exactly two rows, `active=true`, `running=false` (jobids 7 + 8 today). If
   `running=true`, WAIT — deactivating does NOT stop an in-flight execution. (b) **Deactivate:**
   ```sql
   SELECT cron.alter_job(jobid, active := false)
   FROM cron.job WHERE jobname IN ('auto-rebook-reminder','notify-rebook-member-open');
   ```
   (c) **AFTER pause:** re-run the cron-state query — assert `active=false` on both, `running=false`,
   still exactly two rows, before proceeding. Off-hours, no round mid-send.
2. `supabase db push --linked` → applies the 3 migrations (each individually transactional; the
   dry-run pins the set). Re-run the `20260928100000` conflict count first; abort if > 0.
3. **Verify grants** against the EXACT per-signature ACL matrix (post-migration). Every row must be
   `anon=false, service_role=true`; `authenticated=true` ONLY for `guests_have_rebook_contact`,
   `authenticated=false` for the other ten:

   | function (exact signature) | anon | authenticated | service_role |
   |---|---|---|---|
   | `bump_rebook_reminders(uuid[], uuid[], uuid[])` | false | false | true |
   | `guest_verified_account_profile(uuid)` | false | false | true |
   | `resolve_guest_member_contacts(uuid[])` | false | false | true |
   | `rebook_claims_needing_auto_reminder(int)` | false | false | true |
   | `append_rebook_member_open_notified(uuid, text[])` | false | false | true |
   | `guests_have_rebook_contact(uuid[])` | false | **true** | true |
   | `consume_rate_limit(text, text, int, int)` | false | false | true |
   | `rebook_cycles_needing_member_open_notice()` | false | false | true |
   | `claim_rebook_member_open_notice(uuid)` | false | false | true |
   | `unclaim_rebook_member_open_notice(uuid)` | false | false | true |
   | `can_book_member_window(uuid, uuid)` | false | false | true |

   ```sql
   SELECT sig AS function_signature,
     has_function_privilege('anon',          sig, 'EXECUTE') AS anon,
     has_function_privilege('authenticated', sig, 'EXECUTE') AS authenticated,
     has_function_privilege('service_role',  sig, 'EXECUTE') AS service_role
   FROM (VALUES
     ('public.bump_rebook_reminders(uuid[], uuid[], uuid[])'),
     ('public.guest_verified_account_profile(uuid)'),
     ('public.resolve_guest_member_contacts(uuid[])'),
     ('public.rebook_claims_needing_auto_reminder(int)'),
     ('public.append_rebook_member_open_notified(uuid, text[])'),
     ('public.guests_have_rebook_contact(uuid[])'),
     ('public.consume_rate_limit(text, text, int, int)'),
     ('public.rebook_cycles_needing_member_open_notice()'),
     ('public.claim_rebook_member_open_notice(uuid)'),
     ('public.unclaim_rebook_member_open_notice(uuid)'),
     ('public.can_book_member_window(uuid, uuid)')
   ) AS t(sig)
   ORDER BY function_signature;
   ```
   Any deviation from the matrix = STOP (do not "fix" `guests_have_rebook_contact` to
   `authenticated=false` — that would break the manage UI at `rebookManage.ts:61`). Pre-deploy prod
   baseline (2026-07-23) confirmed the leak this closes: `rebook_claims_needing_auto_reminder` + the
   member-open trio are currently `anon=true, authenticated=true`; the 5 guest-first resolvers do not
   exist yet. Also confirm `idx_spc_guest_player_id` exists; a dual-key+twin fixture returns
   guest-first (pglite proofs already assert this — no prod fixture writes).
4. Redeploy all 7 fns; verify each `ACTIVE` at new version (`supabase functions list`).
5. **Merge/deploy the frontend only AFTER step 2 (migrations live)** — `rebookManage.ts:61` calls the
   new `guests_have_rebook_contact` and THROWS on error, so shipping the client before `20260927100000`
   creates+grants it breaks every academy's rebook-manage page (fail-closed deploy ordering).
6. **Reactivate** the two crons, then re-run the step-1 **cron-state query** — assert `active=true` on
   both, `running=false`, exactly two rows (completing the proven `active: true → false → true`
   transition across the three boundaries):
   ```sql
   SELECT cron.alter_job(jobid, active := true)
   FROM cron.job WHERE jobname IN ('auto-rebook-reminder','notify-rebook-member-open');
   -- then re-run the CRON-STATE QUERY from step 1: expect 2 rows, active=true, running=false
   ```
7. Flip these open→resolved. **Blocks PR 10c.**

**Forward-only recovery (never roll back):** `20260927100000` closes a LIVE ACL leak — reverting it
re-opens cross-academy exposure. `supabase db push` applies the files in order and RECORDS each
successful version in migration history BEFORE the next runs, so a mid-set failure (e.g.
`20260928100000` fails after `20260927100000` committed) leaves the earlier migration(s) — including
the ACL lockdown — APPLIED (a partial-SET state, not "nothing applied"). That is the safe direction:
1. Keep both crons **INACTIVE**.
2. `supabase migration list --linked` → compare Local vs Remote; identify exactly which of the 3
   versions landed.
3. Fix forward: correct the failing migration file, then re-run `supabase db push` — already-recorded
   versions are skipped, only the remaining file(s) apply.
4. **Never** `db reset` / revert `20260927100000` to "recover" (re-opens the leak).
5. Re-run the ACL matrix query + the `idx_spc_guest_player_id` check, then reactivate the crons (step 6).
On an edge-deploy failure specifically: keep crons inactive, re-run/complete the failed function
deploy(s), re-verify (step 4), then reactivate.
