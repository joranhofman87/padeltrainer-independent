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

## Guest-first identity — rebook/priority paths (P1 RECIPIENT-ROUTING) — FIXED IN PR 10d (pending deploy-verify)

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
2. **Authorization parity is now REAL** (owner-approved eligibility change): `can_book_member_window`
   was a UNION (`person_links OR twin OR linked`) while the resolver gave person_links precedence.
   Migration `20260928100000` makes curated `person_links` SUPPRESS the twin/linked bridge in both
   guest arms, so a stale twin cannot grant a different account than the curated one. Pre-deploy
   audit: 0 conflicting guests in prod (0 with claims / priority) → no current access lost.
3. **Group-confirmation** is now send-THEN-stamp with a deterministic Resend idempotency key (was:
   claim-before-send with no key → timeout-dup + a failed clear permanently suppressed).
4. **Rate limiter** is one atomic `consume_rate_limit` RPC, fail-CLOSED (was: fail-open, race-prone
   read-modify-write on a `verify_jwt=false` endpoint).
5. **Manage UI** reachability (`guests_have_rebook_contact`, a boolean-only academy RPC) mirrors the
   verified delivery model, so it no longer advertises a route the sender skips (person-links/twin
   guests). The account ADDRESS is never exposed.

### PR 10c (durable outbox) — additional REQUIRED acceptance item (Codex #6)

The batch resolver is set-based enough for member-open's low volume but NOT high-volume ready:
`resolve_guest_member_contacts` invokes the `SECURITY DEFINER` scalar `guest_verified_account_profile`
per guest via a LATERAL join, and the auto-reminder SQL invokes it per claim; the member-open edge
fetches every due row and applies its 500 cap in JS. For high volume this becomes repeated subqueries
+ unnecessary network materialization. PR 10c must resolve identities set-wise and push a
deterministic limit/pagination boundary into SQL (with a scale test) — for the auto-reminder + open_slots
paths as well.
