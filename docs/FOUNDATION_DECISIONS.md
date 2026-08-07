# Foundation decisions

**Status:** Decision ledger — OD-02–OD-06 accepted by the owner 2026-08-07; the D-01–D-13 product table is recorded owner direction (provenance per the note below the table — D-07–D-11 carry no dated record and must be reconfirmed before the first unit that depends on them); OD-07/OD-08 remain open and are explicitly not required for, and must not be decided in, slice U1a  
**Baseline:** `ea54f08b3a204a4ed29c3d37976d51ed2d841ad6`

## Product decisions recorded from owner direction (provenance note below)

| ID | Decision | Rationale | Consequences |
|---|---|---|---|
| D-01 | One human has one global Player identity and stable UUID across academies. | Prevent history and authorization from depending on entry path. | All domain records converge on `person_id`; duplicate resolution is explicit. |
| D-02 | A Player may exist without credentials; later authentication attaches without changing Player ID. | Academy roster creation is not account creation. | `user_id` is nullable/unique; no manufactured passwords or invitations for academy-created Players. |
| D-03 | “Guest player” is not a product role. | Guest is a legacy implementation distinction, not a human type. | Remove guest terminology from active UX/canonical docs after safe migration; preserve compatibility physically until proven safe. |
| D-04 | Never auto-merge on email or phone alone; the reviewed academy merge flow resolves duplicates. | Shared family contact data is not identity proof. | Automated matching only proposes candidates; merges are audited and reversible/traceable. |
| D-05 | Each academy owns a private relationship with a Player. | Tenant-owned notes/settings must never leak. | Use academy membership records; player-owned and academy-owned fields have separate visibility rules. |
| D-06 | Academy managers manage one academy; trainer authority is relationship-specific and configurable. | Prevent broad global role authority. | Server-enforced capabilities; planning/registration management is off for trainers by default. Manager authority is scoped independently to each academy relationship (the shipped schema permits one account to hold grants at several academies — not forbidden by this decision). |
| D-07 | Trainer and academy roles may coexist; trainer+player on one account is not required. | Avoid forcing complex account-role convergence. | Role switching remains supported; separate accounts are acceptable for trainer/player. |
| D-08 | Registration captures demand; Planning owns writes; Calendar is the agenda/read model. | Separates intake, decision-making, and presentation. | Publication is a human-confirmed command; suggestions never commit themselves. |
| D-09 | Sessions can be standalone or in a cycle; each booking remains independently changeable. | Recurrence grouping must not erase occurrence-level control. | Session and booking IDs remain first-class; cycle commands require explicit scope. |
| D-10 | Every broad change asks scope and previews bookings, Players, invoices, payments, and notifications. | Avoid silent cascading changes. | Preview/version is required input to the atomic command. |
| D-11 | Mollie and manual invoicing are supported; future processors use adapters. | Avoid provider logic spreading through domain code. | Normalized payment attempts/events and adapter interface. |
| D-12 | Company billing is a Player billing profile/party, not a fake Player. | Identity and payer are different concepts. | Invoices snapshot billing-party details. |
| D-13 | Preserve and freeze the notification foundation/no-backlog boundary. | Notification safety was independently completed. | Reuse its outbox/events; do not reopen N0–N7 without cross-domain evidence. |

**Provenance note (2026-08-07):** D-01–D-06, D-12, and D-13 correspond to dated owner statements
(2026-07-16 person-unification decisions; 2026-08-07 foundation review). D-07–D-11 were recorded as
owner-supplied direction during audit preparation but carry no dated record — reconfirm each before
the first unit that depends on it (D-08/D-09/D-10 → U4/U5; D-11 → U6; D-07 → U2/U3). None of them
gates U1a.

**Shipped nonconformance — B2 auto-merge vs D-04 (recorded 2026-08-07):** the shipped
person-unification backfill and live-mint triggers auto-merge a profile↔guest pair on a
system-wide-unique exact-email match (rule B2, locked 2026-07-16 — `PERSON_UNIFICATION_PLAN.md`
§2/§5, enforced in `20260826280000_persons_backfill.sql`). The 2026-08-07 rule "email or phone alone
never authorizes an identity merge" **supersedes** that rule going forward: B2 and the live H1/H2
auto-merge arms are recorded nonconformance to D-04, not an open question. Remediation (disabling
the live auto-merge arms and/or re-reviewing past auto-merges) is its own owner-authorized unit —
no later than U2, and explicitly not U1a, which merges nothing. The U1a inventory reports
auto-merged pairs as their own class.

## Accepted architecture decisions from owner review — 2026-08-07

| ID | Decision | Rationale | Consequences |
|---|---|---|---|
| OD-02 | Keep `persons` as the internal physical table name while using “Player” consistently in the domain, UI, and canonical documentation. | A physical rename adds migration, grant, function, and compatibility risk without user value. | The stable `persons.id` is the canonical Player UUID; adapters/types hide the implementation name. |
| OD-03 | Use one canonical academy membership per `(academy, person)` for academy-private Player data. | Tenant-private notes, status, tags, assignment, settings, and overrides need one explicit owner. | Migrate legacy metadata additively into `academy_player_memberships`; retain compatibility until reconciliation and owner-gated contraction. |
| OD-04 | Clubs/venues are independent from academies. Academies and venues have a many-to-many “trains at” association; only the club/venue owner may edit venue-owned fields (identity, address, facilities, media), while each academy manages only its own association metadata. | Multiple academies may train at one venue and one academy may use multiple venues. Association must not imply ownership or edit authority. | Use a dedicated academy–venue relationship. Academy details may appear on the venue page through that association, but academy managers cannot modify venue-owned identity/details. |
| OD-05 | Use a fixed, audited catalogue of per-relationship trainer capabilities; Planning/registration management is off by default. | Capabilities give precise delegation without the larger security surface of user-defined roles. | Enforce capabilities server-side, expose academy-managed switches, and audit every grant/revoke. |
| OD-06 | Each Player has at most one personal billing profile and one optional company billing profile. Issued invoices snapshot the selected profile. | Players normally pay personally and may optionally need business details; additional arbitrary profiles add complexity without product value. | Enforce uniqueness by Player and profile kind; later edits never rewrite issued invoices. (Defaulting the selection to personal unless company is explicitly chosen is a proposed UX detail, not part of the accepted decision.) |

### OD-04 association publication rule — accepted 2026-08-07

- A venue has its own owner/manager authority, independent tenant scope, and canonical profile.
- An academy may manage only its relationship metadata (for example its own schedule/contact context), never venue-owned fields.
- The public venue page may list associated academies without granting either tenant access to the other's private data.
- An academy may immediately show its own “we train here” declaration on the academy page.
- The academy appears on the venue page only after the venue/club confirms the association. An
  unclaimed venue therefore publishes no academy affiliations until it is claimed and its owner
  confirms them. Only the confirmation workflow/dispute mechanics remain open detail; the
  confirmation requirement itself is settled.

## Proposed decisions — awaiting explicit owner approval

| ID | Recommendation | Alternatives and consequences | Status |
|---|---|---|---|
| OD-07 | Require AAL2/step-up for platform admins and money-moving/refund actions; phase academy-manager AAL2 after recovery UX is proven. | All privileged roles immediately (stronger, higher lockout/support risk), or risk-accept no application enforcement (weakest). | **Open** |
| OD-08 | Retain financial/audit records under a pseudonymized Player after account deletion; publish explicit retention periods per record class. | Hard-delete where legally permitted (breaks audit/reconciliation), or indefinite identifiable retention (privacy risk). Exact periods need legal/owner input. | **Open** |

## Previously resolved decisions retained for continuity

- Global trainer login identity is self-service (shipped: migration `20261109100000_identity_is_self_service.sql`;
  audit A2-02). Academy managers may manage only academy relationship fields and may initiate
  invitation/reset flows; platform recovery must be separately authorized and audited.
- Person identity signals with shared/ambiguous email require manual review; explicit reviewed links outrank
  inferred legacy links (owner, 2026-07-16 — locked in `PERSON_UNIFICATION_PLAN.md` §2, enforced as
  invariants I-15/I-21 in `INVARIANTS.md`).

No open proposal above becomes accepted until the owner explicitly approves it. Approval should record date,
decider, and any conditions before an execution unit begins.
