# Notification follow-ups (tracked backlog)

Durable record of out-of-scope findings surfaced during the notification migration, so they
are not lost between PRs. Each has a spawned-task id where one exists.

## 10c-a2 — a concurrent-materializer race, surfaced in CI (2026-08-05, found while landing N2 S1)

`src/test/notificationDigestStateMachine.realpg.test.ts` → *"two concurrent materializers both
complete; every member in exactly one group; no duplicate chunks"* FAILED once on CI
(run `30968984926`, job `92189004788`): one of its three post-conditions — ungrouped members,
duplicate `(canonical_group_key, chunk_ordinal)`, or a `pending` group with no members — came back
as 1 instead of 0.

**It is not a fixture artefact.** That suite TRUNCATEs the digest tables in `beforeEach`, and all
three counts are read after the two parallel `materialize_notification_digest_groups` calls, so the
row came from the test's own concurrency — i.e. from `materialize_notification_digest_groups`
racing itself, which is exactly what the test exists to catch.

**Not reproducible locally** (73/73 alone ×3; 196/196 with four realpg suites in parallel ×3) —
the two-core CI runner interleaves far more aggressively than a dev machine. N2 S1 added a fourth
embedded-postgres instance, which plausibly increased that pressure; it did not introduce the race.

Owner: 10c-a2. Worth reproducing under deliberate contention (a loop, or `taskset`-style CPU
limiting) before the digest engine is enabled for anyone, since the failure mode is a member landing
in no group (silently undelivered) or a duplicate chunk (a doubled digest).

## N2 — constraints S1's schema imposes on S2–S5 (from the S1 design + 6 review rounds, 2026-08-05)

These are not defects in S1; they are the bill S1's model presents to the later slices. Each was
raised by review against the shipped schema and must be satisfied where named.

1. ~~**Optional-service footers must render per RECIPIENT (S2).**~~ **CLOSED in S2b** for the
   live senders: `send-email` resolves the recipient's account ONCE (hoisted before the preference
   branch, so types with no preference column know it too) and renders the manage link only for an
   account — a guest gets the from-line alone, never a link that dead-ends on a login form. The
   digest paths need no guest arm by construction: the v1 queue is user-keyed and the v2 resolver
   refuses outbox rows with no `recipient_user_id` (20261011100000:403). Guest marketing mail gets
   its signed one-click link in S3; optional service mail to guests keeps the plain line until the
   contact-scoped preference model exists (item 2).
2. **A guest "stop optional service mail" lever needs a per-event, contact-scoped preference model
   (future unit).** The only existing mechanism, `notification_contacts.consent_status`, also
   silences REQUIRED mail — the resolver excludes an opted-out contact even for `required_delivery`
   — so N2 deliberately ships marketing-only guest management.
3. ~~**Retry epoch (S3/S5).**~~ **CLOSED in S3** for both marketing senders: a non-live
   capability blocks the SEND, not only the click. `resolveMarketingAttachment` returns
   `terminal` for a revoked or expired capability, a retired key generation, or missing key
   state, and BOTH senders mark the row failed with `unsubscribe unavailable: <reason>` before
   any provider call — never a footer-less send. A mint NMRET propagates as a throw and lands in
   the same failed-terminal path. S5's sweep must still respect item 7's retention floor so it
   cannot delete a capability whose source is retryable.
4. ~~**Deployment cutover (S2/S3).**~~ **CLOSED in S3**: capability EXISTENCE is the cutover
   marker. `get_manage_capability_for_source` (20261014130000, read-only, service_role-only,
   raises on malformed input so an error can never read as "legacy row") distinguishes the three
   cases: capability exists → attach the same deterministic token; none + never attempted →
   mint + attach; none + attempted → the provider-accepted body is footer-less, retry it
   byte-identical (`legacy_no_footer`). Digest was already safe (footer renders before request
   freezing; production has zero digest groups). The onboarding drip has no provider idempotency
   key, so it attaches on every attempt with no cutover concern. Residual: a row mid-flight at
   deploy whose runner dies between Resend accepting and the status write retries footer-less —
   byte-identical, correct. The deploy runbook should still avoid deploying the campaign sender
   while any campaign is status='sending'.
5. ~~**Token format + key selection (S2).**~~ **CLOSED in S2a**: the token is
   `v<N>.<id>.<base64url HMAC-SHA256("notif-manage:v1:v<N>:<id>", key vN)>`, frozen by a
   known-answer vector in `_shared/manage-token.test.ts`. The version rides in the token, so the
   live key window [min_mintable, current] and the signature are checked before any capability
   lookup; `bindManageTokenToRow` then requires the row's `key_version` to equal the signed one.
6. ~~**The neutral settings route must exist before S2 emits it (S4).**~~ **CLOSED in S4**:
   `/app/settings/notifications` is mounted in `DomainRouter` **outside every role layout** and
   **RENDERS the settings page — it does not forward to a role route.** Forwarding was the first
   implementation and review killed it: the role layouts guard far more than role. `AcademyLayout`
   redirects an expired academy to `/app/academy/subscription`; `TrainerLayout` redirects an
   incomplete onboarding to `/app/onboarding/trainer` and an expired solo trainer to subscription.
   Each fires on the settings path too, so a forward only moved the bounce one hop later — and the
   people it stranded (expired, mid-onboarding) are the ones most likely to be unsubscribing.
   Rendering in place means no downstream guard, present or future, stands between a recipient and
   turning mail off. Two further invariants a later slice must not undo: a still-resolving auth
   state decides NOTHING, and **any** aggregate `profileFetchFailed` offers a retry instead of
   rendering — `useAuth` publishes PARTIAL results on its last attempt, so a failed
   academy-manager lookup beside a successful roles lookup would otherwise show a manager the
   player-only list, a wrong answer that looks like a complete one. A depth-aware,
   comment-stripping router-source test fails if the route is ever nested under any of the five
   layouts.
6b. **`?redirect=` was navigated unsanitised on two paths (both fixed in S4).** `Auth.tsx` stored
   the query param verbatim and called `navigate(redirectUrl)` on it after login, sanitising only
   in the no-roles branch. Separately — and reachable from the same `?redirect=` — Auth's signup
   link forwards the raw param to `/app/signup`, `SignupRootRedirect` preserves the query,
   `TrainerSignup` stored it raw in `redirectAfterOnboarding` (three sites), and
   `TrainerOnboardingFlow.finishRedirect` navigated to it raw. Since S2b hands this parameter out
   in email footers, a crafted copy was a plausible off-origin jump (`//host` resolves
   protocol-relative). All five sites now go through `sanitizeAppRedirect`, and a stored value that
   fails is purged rather than re-evaluated at every future login/onboarding. **The tell was the
   string literal:** every site that used `SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY` already
   sanitised; the only two that did not were the two that hardcoded `'redirectAfterOnboarding'`. A
   test now forbids that literal in all three files.
6c. **`isStaff` read the PRIMARY role, so a trainer who is also an admin saw the player-only list
   (fixed in S4).** `useAuth` ranks admin above trainer, so `role === 'trainer'` is false for an
   account holding both, and `NotificationSettings` hid every staff catalog event and the legacy
   staff settings from a real trainer. Now tested against the whole `roles` set, with a behavioural
   test (`roles: ['admin','trainer']` renders staff rows). Pre-existing on all three role routes,
   not introduced by S4 — but S4 renders this page directly, so it was fixed rather than inherited.
   **Note for the N1 branch (PR #631):** it refactors this same file, so expect a conflict here.
6d. **A failed preference READ used to overwrite the other channel (fixed in S4).** PostgREST
   resolves with `{data: null, error}` rather than rejecting, so `NotificationSettings.load()`
   consumed four unchecked results: a failed `notification_preferences_v2` read left `prefs` empty,
   `effective()` then answered with CATALOG DEFAULTS, and `saveEvent` writes BOTH channel columns
   from `effective()`. Touching the email control therefore replaced a stored `whatsapp: 'off'`
   with the catalog default — a silent reversal of an opt-out, in the page whose entire job is
   honouring them. The page now checks every read, renders a retry state on failure, and renders no
   control that could write. Pre-existing; S4 made this page the destination of every email footer,
   which is why it is fixed here rather than deferred.
6e. **`profileFetchFailed` was too coarse to gate on; `roleDataFailed` was added (S4).** The old
   flag aggregates four reads (roles, profile, club-manager, academy-manager), so refusing on it
   would take the footer route offline for a profile failure that cannot affect authority — while
   NOT refusing means rendering on partial role data. `useAuth` now also publishes
   `roleDataFailed`, true when specifically the roles or academy-manager read failed, or when the
   fetch threw and nothing was published at all. Pinned by `src/test/useAuthRoleDataFailed.test.tsx`
   against the REAL provider: every consumer mocks `useAuth`, so without it the wiring could be
   deleted with every other test still green.
6f. **OPEN — `useAuth` keeps the previous account's roles across a switch when the fetch fails.**
   On a switch it clears `profileReady`/`profileFetchFailed`/`roleDataFailed` and the subscription,
   but not `roles`, `role`, `profile` or `isAcademyManager`; if every retry then throws, it marks
   the profile ready with the previous account's values still in state. `roleDataFailed` makes that
   state *detectable* — and S4's entry refuses on it — but every layout and page that reads `roles`
   without checking a failure flag still trusts it. **Owner:** a `useAuth` hardening pass that
   clears routing state on identity change, not a notification slice. Found by review during S4.
6g. **S2b SHIPPED (2026-08-05): every footer cites the neutral route; the legacy digest flush
   gained a send-time gate.** Three senders changed. (a) `send-email`: the footer's TYPE-based
   role guess is gone — the exact bug N1 deferred here — and both per-template follower links
   (`new_availability`, `slot_reopened`; followers are account holders) now cite
   `/app/settings/notifications`. (b) `_shared/digest-render.ts`: the v2 digest gained the same
   footer, rendered BEFORE the request freezes so a retry reuses identical bytes under its
   idempotency key; footer bytes are counted by the oversize measurement (test-pinned). Every
   digest recipient is an account holder by construction, so the footer is unconditional.
   (c) `send-digest-emails` re-checks at SEND time what it never re-checked: the current v1
   preference (`_shared/digest-send-gate.ts` — the J rule, only a literal `off` refuses; junk
   values fail OPEN deliberately, an opt-out is the only value safe to obey whatever its origin)
   and canonical address suppression (`email_address_state.is_suppressed`, same normalization as
   `is_email_suppressed`). Both reads happen BEFORE anything is claimed — a failed read aborts the
   run with nothing consumed. Both drop kinds CONSUME the claim (a suppressed address must not
   retry forever; an opt-out is a decision, not a queue); a send failure releases ONLY the items
   it tried to send. Cross-boundary parity (`src/test/notificationFooterParity.test.ts`) pins the
   edge-side URLs to `NOTIFICATION_SETTINGS_ENTRY_PATH` and forbids every role-guessed path —
   the constant lives in frontend code Deno cannot import, so nothing else ties the two worlds.
   **Accepted race, same family as 7b:** the gate reads preferences seconds before the send; an
   opt-out landing inside that window rides along. The window was previously hours-to-days.

6h. **DEFERRED to 10c-d: `send-digest-emails`' profile/role reads are unchunked.** The S2b review
   flagged the new suppression read's `.in()` URL size; that one is now chunked (100/query). The
   pre-existing `profiles` and `user_roles` reads still pass up to 1000 UUIDs through one `.in()`
   (≈37KB URL) — uniform-length keys, so the practical limit is higher, and Codex classified it
   deferrable rather than blocking. Chunk or RPC them when 10c-d touches this function; do not let
   the legacy sender grow another batch read without chunking it.

6i. **S3 SHIPPED (2026-08-05): the marketing attach layer.** `_shared/marketing-email.ts` is the
   decision core (Deno-tested, 12 cases): per-send capability (the SEND identity — campaigns key
   on the recipient ROW, onboarding on the QUEUE row), deterministic unsubscribe footer to
   `https://padeltrainer.ai/manage-email?token=…`, RFC 8058 `List-Unsubscribe` +
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` pointing at
   `functions/v1/notif-unsubscribe-one-click`. BOTH URL shapes are frozen here and S5 must ship
   the page and the endpoint AT those addresses (parity-pinned). Send-time suppression uses the
   canonical `is_marketing_suppressed` per recipient (an ERROR marks the row failed — never
   clearance); a suppressed row goes to status `'suppressed'`, terminal by construction because
   campaign retryFailed re-queues only `'failed'`, and the onboarding CHECK gained the
   `'suppressed'` arm (20261014130000 — the claim RPC optimistically marks rows 'sent', so a
   failed suppressed-write is CRITICAL-logged rather than left as a recorded delivery).
   Campaign scope = the campaign's OWNER (academy → trainer → platform). An UNCLASSIFIED
   onboarding template is treated as MARKETING deliberately: the safe error is an unnecessary
   unsubscribe on service mail, never marketing without one. TTL 480 days (mint bounds 395–800).
   testMode sends carry no footer (no durable send identity to bind); acceptable for
   owner-preview mail. Owner precondition (item 8) still stands before DEPLOY: classify the
   existing templates; the marketing default merely makes misclassification fail safe.

7. ~~**Retention (S5).**~~ **CLOSED in S5**: `sweep_notification_manage_capabilities(p_limit)`
   (20261014140000) deletes only rows more than 30 days past expiry — revoked rows included,
   through the same door, never early (revocation is audit state; deleting it would turn a
   truthful 'revoked' answer into 'missing'). Bounded 1..10000, SKIP LOCKED, service_role-only.
   Suppression provenance survives the sweep (no FK, by design — realpg-proven). **NOT wired to
   any scheduler**: destructive cleanup is an owner gate; the deploy runbook gives the owner the
   cron to install.
7b. **ACCEPTED RACE: mail in flight across an emergency key retirement.** Raising
   `min_mintable_version` serializes against MINT (the mint holds `FOR SHARE` on the key-state
   row), but it cannot serialize against a provider send: between the mint's commit and the moment
   Resend accepts the message there is an external call the database has no part in. A retirement
   committed inside that window ships with mail already sent, and those links are dead on arrival —
   they fail closed at click, so the recipient sees an unsubscribe that does nothing. **This is
   accepted, not overlooked.** Retirement is an emergency act, and the alternative — a
   drain/lease/grace protocol spanning the worker's provider call — is a subsystem whose failure
   modes would be less understood than the one it removes. The invariant the code does hold, per
   layer: mint never inserts or returns a generation retired in the snapshot it holds the row lock
   on; attachment never signs a generation retired in the authoritative state it was given (a
   snapshot check, not a barrier). If an emergency retirement ever happens with mail in flight, the
   remedy is operational: re-send to the affected window after the new key is live — as a NEW
   durable send with a new `source_id`, never by retrying the terminal identity, which would only
   raise `NMRET` again.
7c. **`NMRET` is a terminal contract (S2b/S3).** A retry whose capability was signed by a retired
   generation raises SQLSTATE `NMRET`. Workers MUST classify it as terminal for that send plus an
   ops alert — never as a transient RPC failure, which would poison-retry a send that can never
   succeed, since nothing about it can change. The send identity is preserved; no capability is
   ever rewritten.
7d. **S5 SHIPPED (2026-08-05): the endpoints behind the frozen URLs.**
   `notif-unsubscribe-one-click` (RFC 8058 POST target; GET NEVER applies — mailbox scanners
   prefetch List-Unsubscribe URLs, so GET redirects to the manage page) and `notif-manage`
   (the page's context/apply API), both `verify_jwt = false` — the SIGNED token is the auth.
   The fail-direction table lives in `_shared/notif-manage-core.ts` under 15 Deno tests, and its
   load-bearing rule is S1's twice-relearned lesson: AN OPERATIONAL FAILURE IS NEVER A SUCCESS —
   key state unreadable, key material missing, or an RPC error all answer 503 so the provider
   retries; invalid probes are 400; dead links are 410; only applied/already_applied are 200.
   Context binds the SIGNED generation to the STORED one via `bindManageTokenToRow` (the
   decorative-bind mutant is killed by a dedicated mismatch test). `/manage-email` is the PUBLIC
   page (outside /app and every layout): token scrubbed from the address bar before anything else
   (history sync, referrers and screenshots are not covered by the analytics allow-list),
   redacted context only, apply strictly on the button. Analytics stayed safe by construction —
   pageview URLs are overridden and query params allow-listed (`trackingPrivacy.ts`).

7e. **WHOLE-UNIT SWEEP CLEAR (2026-08-05, `main..f1a7f1e8`).** Fresh-thread review aimed at the
   seams; no P1. Four findings, all fixed in the sweep round: (a) the one-click endpoint now
   REQUIRES the RFC 8058 form body `List-Unsubscribe=One-Click` — mailbox scanners fire blind
   POSTs at List-Unsubscribe URLs, and without the marker check one would unsubscribe a real
   person; (b) `send-email`'s preference read failed OPEN (pre-existing on main — error
   discarded, frequency defaulted to `instant`, mail sent against a stored `off`); now the same
   fail-closed 503 as its account lookup; (c) operational 503s carry `Retry-After: 300` on the
   result object so the wrappers cannot forget it; (d) the sweep gained a FULL `expires_at`
   index — the S1 partial index excludes revoked rows, which the sweep deliberately includes, so
   every "bounded" batch would have scanned the whole table.

8. **Owner precondition before S3 deploys.** Every existing `onboarding_email_templates` row lands
   on `delivery_class='marketing'` (the suppressible direction). The owner must reclassify the live
   templates (`required_service` where the mail is genuinely obligatory) before S3's suppression
   starts consulting the column.

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
call site wired to the twin). **RESOLVED — PR 10d deployed + prod-verified 2026-07-23** (3 migrations
then all 7 edge fns; ACL leak closed, exact grant matrix verified; first `notify-rebook-member-open`
run succeeded).

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
   granting the parent of a dual-key row; closed in round 4 for `can_book_member_window`. The shared
   `is_cycle_member` primitive (a latent oracle; the 2026-07-24 live audit found ZERO callers — NOT
   capacity/slot-tier, which moved off it) was made guest-safe + service-role-only in PR #607
   (task #30) — **DEPLOYED + PROD-VERIFIED 2026-07-24**.
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
   **OWNED FOLLOW-UP — RESOLVED: DEPLOYED + PROD-VERIFIED 2026-07-24 (PR #607, task #30):** a 2026-07-24
   live-prod caller audit corrected the earlier assumption. `is_cycle_member` has **ZERO live callers** —
   capacity + slot-tier moved to `can_book_slot` / `can_book_member_window` (which `20260928100000` made
   guest-safe and no longer calls it — the only remaining reference is a deferral COMMENT); no RLS policy
   uses it; and the sole client reference (`priorityClaims.ts` `isCycleMember()`) was DEAD. So **no
   current-user wrapper and no client migration were needed** (contrary to this bullet's earlier text).
   PR #607: redefines `is_cycle_member(uuid,uuid)` guest-safe (reusing `guest_verified_account_profile`),
   `REVOKE`s PUBLIC/anon/authenticated + `GRANT`s `service_role` only, DELETES the dead helper, and adds
   identity + ACL regression (incl. a statement-parsed migration-wide guard covering multiline / `TO
   PUBLIC` / schema-wide `FUNCTIONS`|`ROUTINES` grants). **No wrapper** (owner decision). **Prod verify
   (2026-07-24) PASSED:** `anon=false, authenticated=false, service_role=true`; live `pg_get_functiondef`
   has the `guest_verified_account_profile` branch and restricts the raw player arm to
   `guest_player_id IS NULL`.
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
past session can never auto-remind (no edge/frontend/cron change). Deploy it with a dry-run first:
`supabase db push --dry-run --linked` → confirm **exactly `20260930100000` is pending** → then
`supabase db push --linked`.

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

---

## 10c-b J — documented follow-ups (NON-BLOCKING, owner-classified 2026-08-04)

The owner closed slice J's scope: P1/P2 and correctness/security/privacy/consent P3 block; unrelated
hardening, stylistic points and old-cached-client compatibility become follow-ups. The app has very
few active users, and temporary disruption, forced refreshes and imperfect old-client compatibility
are acceptable. Security, tenant isolation, explicit opt-outs, financial correctness, data integrity
and WhatsApp consent are NOT relaxed. These are the items that fall on the follow-up side.

### J-F1 · A catalog-default change after a departure is not itself mirrored
Deleting a `daily` v2 row while `default_email_frequency` is `weekly` correctly moves the legacy
column to `weekly`. If an admin later changes that default to, say, `off`, v2 resolves to `off` but
no v2 row exists to fire a trigger, so `notification_preferences.open_slots_digest` stays `weekly`
and the legacy reader keeps sending at that cadence.

Why it is a follow-up, not a blocker: the diverging value is an INHERITED default on both sides, not
an explicit opt-out — no user's recorded choice is overridden. It affects only the legacy v1 reader,
which 10c-d retires. Closing it properly needs a trigger on `notification_event_types` that re-mirrors
every affected user, which is a materially larger change than the bridge itself and would run a
bulk write on a catalog edit.

**Owner:** 10c-d (legacy retirement) — or it disappears entirely when the v1 column is dropped.
**Do not** close it by making the departure mirror read the catalog on every write.

### J-F2 · Departure fidelity when the catalog default INCREASES sending
A departure moves the legacy column to the catalog default. If that default is more frequent than
what the departing row held (e.g. `weekly` → `instant`), the legacy reader sends more often than
before. This is correct — it is what v2 now resolves to — but it is the one case where "a departure
never increases sending" is not literally true, and it is recorded here so a future reader does not
file it as a defect. It cannot resurrect an opt-out: an `off` on either side always refuses.

**Owner:** none. Documented behaviour.

### J-F3 · `update_updated_at_column` is not search_path-hardened
Slice J hardened `validate_notification_frequency` because the reverse bridge newly invokes it from a
`SECURITY DEFINER` context. The other trigger on that table, `update_updated_at_column`, has the same
shape (`SET search_path TO 'public'`, unqualified `now()`) but no dynamic `EXECUTE`, so the worst a
captured `public.now()` could do is write a wrong timestamp. It is shared by dozens of tables, so
replacing it is a repo-wide change, not a drive-by inside a notification cutover. Measured and worth
recording: NO application role can create the rival — `public`'s ACL grants CREATE only to
`pg_database_owner`, so `has_schema_privilege('authenticated','public','CREATE')` is false.

**Owner:** a general search_path-hardening sweep, if one is ever scheduled.

### J-F4 · Two timing-sensitive tests fail only under full-suite pressure
`notificationDigestStateMachine.realpg.test.ts` asserts a 60 ms budget on a 100k-row scale scenario
and measures 70–137 ms when the rest of the suite (or the other gates) compete for CPU;
`invoiceSyncPaging.pglite.test.ts` and `emailDeliverySuppression.pglite.test.ts` hit the 15 s default
timeout the same way. All pass in isolation. They belong to 10c-a2 and the invoice work, not to J.

**Owner:** whoever next touches those suites — either raise the per-test timeout/budget or mark them
serial. Do not "fix" them by relaxing what they assert.

---

## Final Integration Audit (2026-08-06) — recorded, not fixed

The audit that gates N7. These are findings it surfaced **outside** the notification foundation's
boundary; the in-scope ones were fixed in the same pass (see the roadmap's N-unit rows).

### FA-1 · Suppression is not enforced on every legacy email sender (P2, out of scope here)

`is_email_suppressed` (hard bounce / complaint) is enforced on the v2 paths — the instant worker,
the digest state machine — and on `send-digest-emails` and `send-invoice-email`. It is **not**
checked by these direct senders:

`send-email` (the generic one, which does check *preferences*), `notify-rebook-member-open`,
`process-onboarding-emails`, `send-campaign-emails`, `trigger-welcome-emails`,
`send-priority-claim-invitation`, `send-rebook-group-confirmation`, `signup-user`, `update-user`,
`send-auth-email`.

Some of those are legitimately exempt (`send-auth-email` carries password resets: a suppressed
address should arguably still receive a security mail, and that is a product decision, not an
oversight). Most are not: mailing an address that hard-bounced or filed a complaint costs domain
reputation and, for the marketing ones, is a compliance problem.

**Why it is recorded rather than fixed:** every one of them is outside the notification
foundation. The foundation's claims stay true — this is a system-wide email question, which is
what the postponed A-audits are for. The fix per sender is one RPC call before dispatch
(`is_email_suppressed`), plus a decision about the security-mail exemption.

**Owner:** whoever runs A1–A7. **Do not** treat this as closed by the notification programme.

### FA-2 · Two parallel senders own their own idempotency (P3)

`notify-rebook-member-open` and `send-digest-emails` send without a `notification_outbox` row, so
their sends do not appear in the v2 ledger, the admin surface or the delivery history. Both are
individually safe (deterministic idempotency keys, checkpointing), but "every send is attributable"
is only true *within* the foundation. Recorded so nobody reads the admin surface as a complete
picture of outbound mail.

### FA-3 · Instant and digest prevent duplicates by different mechanisms (P3, recorded)

The digest path never re-sends an ambiguous attempt: one HTTP call per recorded attempt, and
ambiguity becomes `delivery_unknown`. The instant path retries — three attempts inside
`resend-send.ts`, then a backoff requeue, then a stale-lease reclaim — all under the same stable
idempotency key (`notification-outbox-<row id>`), so Resend deduplicates them inside its 24h
window.

In normal operation both are safe. But the instant path's safety depends on a *provider* guarantee
while the digest path's depends on its own state machine, and only one of those is verifiable from
this repository — and the bound is weaker than it first looks: the backoff cap and `max_attempts`
bound the number and minimum spacing of attempts, **not** the wall-clock span, because
`next_attempt_at` is only a not-before condition. After an outage longer than the provider's dedup
window, a retry of a possibly-accepted attempt can duplicate. That case is operational and is
documented in NOTIFICATION_OPERATIONS.md §5; removing it rather than managing it is this
follow-up.

**The improvement:** bring instant delivery onto the single-shot adapter and the same
uncertain/`delivery_unknown` state machine. **Why it is recorded rather than done here:** it
changes the retry semantics of the live email path, and the notification foundation's final gate is
the wrong moment to redesign a sender that is working. Do it as its own reviewed unit.
