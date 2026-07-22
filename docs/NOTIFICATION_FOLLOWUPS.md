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
