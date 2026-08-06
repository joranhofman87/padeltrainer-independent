# N0–N7 integration — the release candidate

**The combined tree is the release candidate. The stacked branches are not.**

Until now each unit was reviewed on its own stack, and #633/#634 target other feature branches
rather than `main` — so the substantive workflows (`test.yml`, `migrations.yml`) never ran on them.
A unit reviewed only against its own base has not been integration-tested; the conflicts between
units are exactly where cross-unit defects live. This branch exists so the thing that ships is the
thing that was verified.

## Composition

Branched from `origin/main` = `5c339be50bf0bd0a33170b966c2e3e27446044ab`, then three merge commits
in reviewed order. Every original commit is an ancestor — no rebasing, no cherry-picking, no
hand-rebuilt work, so provenance is intact and `git log --graph` shows each unit as its own strand.

| Unit | PR | Branch | Exact head merged | Commits |
|---|---|---|---|---|
| N0 — cron lock privilege | [#630](https://github.com/joranhofman87/padeltrainer-independent/pull/630) | `fix/notif-10cb-cron-lock-privilege` | `6be077cf4a5decfc52c6a930466452d2e54ffa25` | 4 |
| N1 — player settings gaps | [#631](https://github.com/joranhofman87/padeltrainer-independent/pull/631) | `fix/notif-settings-n1-gaps` | `6cb96359c9d2f37abeaf25bef96dc0b82a116420` | 3 |
| N2 — email preference management | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | `feat/notif-n2-email-prefs` | `4f002488921b146f3e096ba10b7e96fc89cb47a7` | ancestor of ↓ |
| N3 — academy tenant controls | [#633](https://github.com/joranhofman87/padeltrainer-independent/pull/633) | `feat/notif-n3-academy-controls` | `3d1e23454e2907cf1db16924a335fe3adfebb606` | ancestor of ↓ |
| N4–N7 + audit corrections | [#634](https://github.com/joranhofman87/padeltrainer-independent/pull/634) | `feat/notif-n4-admin-ops` | `fe4af7967275128fc085d9ea10cd47db16449a63` | 133 |

N2 and N3 are ancestors of the N4 head (the stack), so merging that head carries all three. N0 and
N1 were siblings off `main` and are merged explicitly. 140 commits total.

## Conflicts, and how each was resolved

Four files conflicted. Each resolution names the competing invariants and preserves both where
they are compatible.

### 1. `scripts/rollout/notif-10cb/verify/preflight-pg.mjs` — the `cron.alter_job` mock

*Competing invariants.* N0 replaced the harness's three-parameter `alter_job` stand-in with a mock
measured against pg_cron 1.6.4: the full six-parameter signature, ownership checked against the
caller, `no updates specified` refused, and a new tuple version written even on a value-identical
update. That fidelity **is** N0 — the hosted role cannot `FOR UPDATE` the `supabase_admin`-owned
`cron.job`, so `alter_job` is the row lock the artifacts depend on. The N4 side still carried the
simpler stand-in.

*Resolution.* Take N0's. It is a strict superset: same `job_id` semantics, same argument names, so
every named-notation call the N4 artifacts make still resolves — plus the ownership check and the
refusal N0 exists to prove. No behaviour of the N4 side is lost.

### 2. `scripts/rollout/notif-10cb/verify/preflight-pg.mjs` — the fixture reset

*Competing invariants.* N4 added resets for the tables it introduced (the append-only invocation
record, via its sanctioned trigger-disable escape, and the kill switches). N0 added a comment
explaining why the `cron.job` seed names the operator role explicitly rather than inheriting the
boot superuser's name.

*Resolution.* Both, unchanged. They are additive and touch different lines.

### 3. `docs/NOTIFICATION_FOLLOWUPS.md`

*Competing invariants.* Both units prepended a different backlog entry — N1's footer-link-by-type
finding, N4's concurrent-materializer race.

*Resolution.* Both kept, N1's first (the older finding). Dropping either would silently lose a
tracked item, which is the one thing a backlog file must not do.

### 4. `src/test/notificationSettingsV2.test.tsx` — the router mock

*Competing invariants.* N1's mock adds `useLocation` and a settable pathname, because N1's page
derives its back target from which role layout mounted it. N4's is the older two-line mock.

*Resolution.* N1's, which is a strict superset. N4's tests do not read `useLocation`, so nothing
regresses; N1's back-button assertions would fail without it.

### 5. `src/pages/NotificationSettings.tsx` — the page shell vs the academy caps

*Competing invariants.* N1 rewrote the page onto the canonical chrome (`AppPage` + `PageHeader` +
`flushOnMobileCardClass`, a back target derived from the mounting layout) as part of the
mobile-first UI-standards work — the repo's architecture guards forbid a bespoke
`container mx-auto` shell here. The N4 side kept the older shell but added the N3 academy-cap and
cap-history reads, `QueryErrorState`, `setLoadFailed`, and the caps/history UI.

*Resolution.* N1's chrome, with every one of the N4 side's additions rendered inside it.

*One deliberate behaviour decision, recorded because it changes the merge side's code.* The N4 side
had folded the WhatsApp consent read (`wa.error`) into the page's fail-closed read boundary. N1
had deliberately excluded it, with a comment: that read's documented failure posture is fail-safe
to *not opted in*, so a failure leaves the WhatsApp controls disabled rather than failing the whole
page. The excluded term is kept excluded — every other term the N4 side added (caps, cap history)
stays in the fail-closed check, because a cap **binds** the player and rendering plain controls
beside a silent cap read would misinform them. A regression test pins both halves.

## What this branch does NOT change

No migration is reordered, no reviewed SQL is rewritten, no test is weakened or deleted. The
resolutions above are the entire behavioural delta between this tree and the union of the five
reviewed heads.
