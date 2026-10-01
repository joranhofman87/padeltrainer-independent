# U2 — trusted identity continuity for anonymous returning Players (design + threat model)

Owner-approved 2026-08-10. This is the design record the U2 handoff points at; implementation
follows it. It closes the standing merge blocker "returning anonymous bookers become new Players
with a duplicate proposal" **without** ever letting an attribute select an identity.

## The rule, restated as a state machine

A first-time anonymous contact creates a NEW canonical Player. PII may only *suggest* existing
candidates. When candidates exist, the system proves control of the contact address through a
short-lived signed capability; only then may the person explicitly pick the right existing Player
or "someone new". Login, an existing reviewed claim, or a valid server-issued returning-player
capability identify the exact Player with no fresh challenge. Nothing auto-merges.

Every anonymous entrypoint (slot, cart, cyclus, intake, rebook add-member) resolves identity through
ONE function before any side effect:

```
resolve_anonymous_identity(creation_request_id, owner, workflow, contact, [selection_capability]) →
  PROCEED_NEW      -- no candidate collision: create through the UUID command, as today
  PROCEED_PERSON   -- trusted evidence bound to an exact person_id: use it
  VERIFY_REQUIRED  -- candidates exist and no trust yet: a challenge was enqueued; reveal NOTHING
```

Trusted evidence, in precedence order:
1. an authenticated caller whose `auth.uid()` resolves to a canonical `person_id` (login);
2. a valid, unexpired, single-use **selection capability** already bound to THIS
   `creation_request_id` and an exact `person_id` (a completed selection, or a prior reviewed
   claim re-issued as a capability);
3. otherwise PII matching runs. It returns a boolean "candidates exist" and a candidate-set
   fingerprint — never names, ids, or counts. Zero candidates ⇒ PROCEED_NEW. ≥1 ⇒ VERIFY_REQUIRED.

### The rebook entrypoint is already satisfied — no challenge is added there

Of the five listed entrypoints, four self-service checkouts (slot, cart, cyclus, intake) do
anonymous PII matching and get the challenge. **Rebook does not, and correctly so**, because its
identity never comes from anonymous PII:

- A returning member responding to a rebook invitation acts through their **claim token** — a
  capability already bound to the exact person from last cycle. That is trusted evidence #2 (the
  owner's stated bypass: "an existing valid capability already bound to an exact person_id"). No
  fresh challenge is needed or wanted.
- A **captain adding a NEW member** types that member's details and creates through the UUID command
  (round-3 attempt-id binding). The member is not present; email-verifying an absent third party
  would both break the captain's synchronous flow and email people who initiated nothing (an abuse
  vector). This is operator-add "create new" semantics, and it is already what happens.

So rebook is compliant with the owner's flow as-is. **This interpretation is flagged for owner
confirmation at the gate** — it is the one place where "apply verification to the rebook entrypoint"
was read as "rebook identity already flows through trusted evidence / create-new" rather than "add
an email challenge". Reversible; touches no production data.

The verification round-trip (only entered on a candidate collision):
```
begin  → mint ONE challenge for (workflow, owner, creation_request_id, contact_norm, candidate_set_fp),
         enqueue ONE generic verification email (inert outbox), return VERIFY_REQUIRED + opaque token-less ack
click  → verify-identity edge validates the emailed capability (control-of-address proof)
list   → disclose the MINIMUM owner/trainer-scoped candidate info to distinguish household members
choose → identity_verification_select(person_id | 'someone_new') binds the result to creation_request_id
resume → the original entrypoint re-runs; step 2 now returns PROCEED_PERSON; booking proceeds
```

## What is reused, and the one thing that is not

REUSED, verbatim pattern (not a new framework):
- **HMAC capability tokens** exactly as `_shared/manage-token.ts`: `v<N>.<capability_id>.<b64url
  HMAC-SHA256>`, key in edge env (`IDENTITY_VERIFY_TOKEN_KEY_V<n>`), DB stores the row +
  `key_version` + `expires_at`, never the secret or the HMAC; version-in-token lets the floor +
  signature be checked before any row read; tagged failures (`invalid`/`inactive`/
  `key_unavailable`); constant-time compare; domain-separated signed string.
- **Key rotation floor** — a `*_key_state` single-row monotonic table + guard trigger, mirroring
  `notification_manage_key_state`.
- **Idempotent enqueue + inert outbox** — `enqueue_notification`; the payload carries the
  `challenge_id` and workflow only, **never the HMAC token** (the token is derived from
  (challenge_id, key) at the owner-gated send, exactly as the manage-link worker derives its own —
  the database stores no HMAC). A new INERT `identity_verification_requested` event type
  (required_delivery, footer `none`, no active channel/worker) — enqueue-only, real send is the
  owner gate. **ACTIVATION PREREQUISITE (Codex r2 f3):** a real send MUST target the challenged
  address (`contact_normalized`), not the recipient person's resolved notification-contact, which
  for a claimed candidate can differ; and consent-suppression of this required challenge must be
  handled at the sender. Delivery stays inert until that address-bound sender exists.
- **Anonymous rate limit** — `throttleGuestPayment`/`rate_limits` as a secondary cap.
- **Explicit selection shape** — modeled on `person_claim_confirm` (idempotent, row-locked,
  person-keyed), but anonymous and capability-gated instead of `auth.uid()`-gated.

NOT reused / deliberately separate: `manage-token.ts` is NOT refactored. The notification
architecture is FROZEN (release-ready, inactive); editing that reviewed module to share code would
enlarge the diff into frozen territory. A second capability legitimately needs its own domain
separation and key, so `identity-verify-token.ts` is a sibling that follows the identical reviewed
pattern. This is "reuse the pattern", not "a parallel generic framework": the two modules share no
runtime, only a shape.

## The capability, precisely bound

`identity_verification_challenges`:
- `id uuid pk`, and a **selection capability** is a second row/state, single-use.
- binds ALL of: `workflow` (slot|cart|cyclus|intake|rebook), `owner_kind`+`owner_id`,
  `creation_request_id`, `contact_normalized` (lower(btrim(email))), `contact_fingerprint`
  (md5 binding, not secrecy), and `candidate_set_fingerprint` + `candidate_set_version`.
- `key_version`, `expires_at` (short — 30 min), `verified_at`, `consumed_at`, `created_at`.
- No PII in any URL: the link carries only `v<N>.<challenge_id>.<hmac>`.
- Refuses cross-workflow, cross-owner, cross-attempt, expired, replayed, tampered use — each maps
  to ONE uniform generic response (never "no such challenge" vs "wrong owner": that is an oracle).
- **Candidate-set change fails closed**: if the candidate_set_fingerprint recomputed at verify/
  select time differs from the one bound at mint, the challenge is void and a fresh verification is
  required (a candidate appearing/disappearing between begin and choose must not let a stale token
  select into a changed set).
- A browser cookie is NOT identity proof; it may only carry the opaque server-issued token, which
  the server validates every time.

For a SHARED family email, verification proves control of the address, not which member is acting —
so multiple candidates are disclosed (scoped, minimal) and explicit selection stays mandatory.
"One email = one Player" is never encoded in a constraint or fixture.

## Idempotency

All of {challenge creation, message enqueue, verification, selection} bind to the original
`creation_request_id`. Repeated submission: at most one ACTIVE challenge (unique partial index on
`creation_request_id` where not consumed), at most one equivalent enqueue per window (outbox
`idempotency_subject` = the challenge identity), no duplicate Player/booking/invoice/payment, same
terminal result once completed (the bound selection replays).

## Threat model (what each guard answers)

| Threat | Guard |
| --- | --- |
| Enumeration of who exists by PII probing | pre-verification responses carry no names/ids/counts/existence; one uniform VERIFY_REQUIRED ack whether or not candidates exist would be ideal, but a first-timer must PROCEED_NEW — so the distinguisher is "did booking proceed" not any candidate detail, and the begin response is identical (`verify_required`) for 1 vs N candidates |
| Token theft / replay | single-use (`consumed_at`), short expiry, HMAC signature, key-in-env; a replayed selection returns the same bound result, never a second mutation |
| Token forgery / tamper | HMAC over domain-separated `v<N>:<id>`; version floor; constant-time compare; grammar-before-lookup so a probe never costs a row read |
| Shared-email ambiguity | control-of-address ≠ member identity; explicit selection mandatory; multiple candidates supported |
| Cross-tenant / cross-owner selection | challenge binds owner; select re-checks `player_owner_may_select_person` for the chosen person in the challenge's owner scope |
| Pre-verification side effects | the entrypoints call the resolver BEFORE any hold/invoice/Mollie/create; VERIFY_REQUIRED returns before booking |
| Email abuse / bombing | structural: one active challenge per creation_request_id (fail-closed unique index) + secondary rate_limits cap; enqueue idempotent |
| PII leakage | token has no PII; payload service-role-only; never in logs/analytics/error/Mollie metadata; candidate disclosure is post-verification and minimal |
| Compatibility inversion | selection carries only canonical person_id into booking/invoice/payment; no guest_player_id crosses the boundary (legacy keys derived server-side by the existing service-only adapter) |
| Candidate-set drift between begin and choose | candidate_set_fingerprint bound at mint, rechecked at select; mismatch ⇒ void ⇒ re-verify |

## Scope boundaries (unchanged from the parent slice)

Legacy `guest_player_id` physical compatibility stays private and unchanged; no contraction; no
re-entry into `club_players`; no touch to production Players/bookings/invoices/payments/links; no
backfill; email delivery + notification activation remain owner gates (enqueue only, inert).

## Genuinely-new-decision check

Reconnaissance surfaced no new product/retention/permission/billing/production-data decision beyond
what the owner already specified. Two things were CONSIDERED and resolved within the mandate: (a)
the existing rate-limiter fails open — neutralized by a PER-ADDRESS hourly email cap enforced under
an advisory lock in `identity_challenge_enqueue` (the per-creation_request_id uniqueness is NOT an
abuse cap — a caller rotates request ids — Codex r1 f5 / r2 f3); the residual owner-scoped
proceed_new-vs-verify_required existence signal is inherent to gating returning bookers and is
rate-limited, not eliminated; (b) enqueueing requires a notification event type, and the
catalog is frozen — the new type is INERT (no channel/worker), which matches the frozen-inactive
posture and the owner's "enqueue, do not send" instruction. Neither is a new decision requiring an
owner stop.
