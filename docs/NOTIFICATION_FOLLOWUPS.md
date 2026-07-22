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
| 2 | `supabase/functions/notify-rebook-member-open/index.ts` (~L175/186/199) | recipient-SET discovery reads (slots→cohort→emails) errors discarded → silent under-notification | `task_7b5df2fc` | rebooking cron path |
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
(`feat/notif-pr10d-rebook-identity`) applies it as the full-closure identity pass over the rebook
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
| `rebook_claims_needing_auto_reminder` RPC (`20260721100000`) | player-first `DISTINCT ON` + profile-first name/email | guest-first CTE (migration `20260927100000`) |
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
