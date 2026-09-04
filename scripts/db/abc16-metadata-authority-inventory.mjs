/**
 * ABC-16 — READ-ONLY inventory of the overlay rows whose authority H0 withdrew.
 *
 * Answers ONE question: for every existing row in `academy_player_metadata` and
 * `academy_player_locations`, what INDEPENDENT evidence (if any) supports the academy↔player
 * or trainer↔player relationship the row used to assert, and what is structurally wrong with
 * the row? H0 fixed the authority defect forward; it deliberately changed no data. This tool
 * produces the evidence an owner needs before deciding what — if anything — should happen to
 * the rows that turn out to have no independent basis.
 *
 * It NEVER writes, quarantines, repairs, merges, deletes or re-stamps anything. Disposition
 * is an owner decision and a separately approved change.
 *
 * ── Two orthogonal classifications (deliberate, do not collapse them) ──────────────────────
 *
 *   EVIDENCE PATHS (may overlap — one row can be reachable by several). Each reproduces a
 *   predicate that genuinely ships somewhere in the repository; they are never merged into a
 *   single "is related" rule, because the shipped readers do not agree on one.
 *
 *   DISPOSITIONS (a strict partition — every row lands in exactly ONE, by the fixed
 *   precedence in DISPOSITION_PRECEDENCE). The structural defects are ordered ahead of the
 *   evidence classes, so a row that is BOTH well-evidenced and structurally broken is
 *   reported as broken: the point of the inventory is to surface what needs a decision.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────────────────────
 *
 *   No query selects a name, email, phone, birth date, note, tag label, billing name,
 *   billing address, billing BTW number or billing email. Not "they are redacted afterwards"
 *   — they are never read, which is the only form of minimization a reviewer can verify by
 *   reading the queries (and a test greps this file for those column names).
 *
 *   UUIDs and fingerprints REMAIN pseudonymous personal data: they re-identify a person for
 *   anyone holding the database. So stdout carries counts only, and row-level output exists
 *   solely in an explicitly requested artifact file written 0600.
 *
 * ── Determinism ───────────────────────────────────────────────────────────────────────────
 *
 *   * one REPEATABLE READ, READ ONLY transaction per run (the database itself refuses writes);
 *   * a caller-supplied fixed `asOf` instead of now()/current_date — this file contains
 *     neither (pinned by a test that greps this source);
 *   * every row-level output totally ordered by UUID (no ties, no ORDER BY on nullable text);
 *   * canonical serialization + a content hash, so two runs over unchanged data are
 *     byte-identical and a later run is comparable to this one;
 *   * source-table fingerprints taken before AND after the read set, proving zero mutation.
 *
 * The executor lifecycle mirrors `scripts/db/u1a-membership-inventory.mjs`, which earned its
 * shape over several review rounds. The pure helpers are imported from it rather than
 * hand-copied; the lifecycle is reproduced because U1a's runner is bound to U1a's own query
 * set, and editing that reviewed file from this lane would cross into another workstream.
 */

import { constants as fsConstants, openSync, writeFileSync, closeSync } from 'node:fs';
import { canonicalize, contentHash, InventoryExecutorError } from './u1a-membership-inventory.mjs';

/**
 * Bump when the output SHAPE changes; comparing hashes across versions is meaningless.
 *
 * abc16.2 — booking signals were reclassified from evidence to untrusted observations
 * (ABC-17), which added the `booking_observation_only` disposition and renamed three flags.
 */
export const INVENTORY_VERSION = 'abc16.2';

/**
 * Terminal dispositions, most-specific first. A row takes the FIRST that applies, so the set
 * partitions the row universe. Order is a contract: it decides which diagnosis is reported
 * when several apply, and reruns must classify identically.
 */
export const DISPOSITION_PRECEDENCE = [
  // 1. The row does not point at things that exist, so nothing else about it can be assessed.
  //    Wrong-target precedes the generic orphan class because a location row naming a
  //    `profiles` row ALSO fails the academy-exists check, so the specific diagnosis would
  //    otherwise be unreachable.
  'wrong_target_academy_fk',
  'orphan_reference',

  // 2. NO TRUSTED EVIDENCE — the finding this inventory exists to surface. Ranked above the
  //    data-quality classes deliberately: a forged row typically has no person link either,
  //    and reporting it as "missing person stamp" would bury a security finding under a
  //    housekeeping one. Evidence first, tidiness second.
  'metadata_only',
  'location_only',
  // Supported ONLY by a booking, whose subject the academy or trainer could reassign
  // (ABC-17). Not proof, but materially different from an overlay row with nothing at all
  // behind it — an owner disposing of these needs to tell the two apart.
  'booking_observation_only',

  // 3. The row IS supported by independent evidence, but something about it needs a decision.
  'duplicate_or_conflicting',
  'split_frozen',
  'missing_person_stamp',
  'stale_person_stamp',
  'divergent_person_stamp',

  // 4. Supported and sound. Strongest evidence first.
  'canonical_membership_backed',
  'independently_academy_evidenced',
  'independently_trainer_evidenced',
];

/**
 * Evidence paths, with the shipped predicate each reproduces. These OVERLAP by design and are
 * reported separately from the disposition.
 */
export const EVIDENCE_PATHS = [
  ['V1_canonical_membership', '20261113100000 — a row in academy_player_memberships for (academy, person)'],
  ['V2_academy_owned_guest', '20260706130100:28 arm (a) — guest_players.academy_profile_id = the academy'],
  ['V5_trainer_owned_guest', '20260116200114 — guest_players.trainer_id = the owning trainer'],
];

/**
 * Booking signals. Reported, never counted as evidence.
 *
 * ABC-17: a booking's subject was freely reassignable by the slot owner — the academy and
 * trainer UPDATE policies gate on the SLOT and never mention `player_id` / `guest_player_id`,
 * and `public.bookings` carried no triggers. So a booking says "somebody with write access to
 * this slot asserted this person", which is an OBSERVATION about the academy's own records,
 * not proof about the person.
 *
 * The containment migration installs a trigger freezing those columns for client roles, so
 * bookings made AFTER it are meaningfully harder to forge. Existing rows predate it, and this
 * inventory exists to describe existing rows — so they stay untrusted here regardless.
 */
export const UNTRUSTED_OBSERVATIONS = [
  ['O1_academy_slot_booking', 'a booking on a slot the academy owns — subject was reassignable'],
  ['O2_registered_slot_booking', 'bookings.player_id on a slot in the academy trainer scope — same'],
  ['O3_trainer_slot_booking', 'a non-cancelled booking on one of the trainer\'s own slots — same'],
];

/**
 * Tables fingerprinted before and after the read set, so a run that mutated anything is
 * detectable even though the transaction is READ ONLY.
 */
const SOURCE_TABLES = [
  'academy_player_metadata',
  'academy_player_locations',
  'guest_players',
  'person_links',
  'persons',
  'bookings',
  'availability_slots',
  'academy_trainers',
  'academy_profiles',
  'profiles',
  'trainer_profiles',
];

/**
 * The row universe: every overlay row, normalized to one shape.
 *
 * `academy_player_metadata` carries exactly one owner (the `academy_player_metadata_owner_check`
 * CHECK) and exactly one subject. `academy_player_locations` has no trainer arm and no
 * trainer column at all, so its owner is always the academy one.
 */
const ROWS_CTE = /* sql */ `
  rows_all AS (
    SELECT
      'academy_player_metadata'::text AS source_table,
      m.id                            AS row_id,
      CASE WHEN m.academy_profile_id IS NOT NULL THEN 'academy' ELSE 'trainer' END AS owner_kind,
      m.academy_profile_id            AS academy_profile_id,
      m.trainer_profile_id            AS trainer_profile_id,
      CASE WHEN m.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END AS subject_kind,
      COALESCE(m.guest_player_id, m.profile_id) AS subject_id,
      m.guest_player_id               AS guest_player_id,
      m.profile_id                    AS profile_id,
      m.person_id                     AS stamped_person_id,
      (m.removed_at IS NOT NULL)      AS removed,
      NULL::boolean                   AS dismissed
    FROM public.academy_player_metadata m
    UNION ALL
    SELECT
      'academy_player_locations',
      l.id,
      'academy',
      l.academy_profile_id,
      NULL::uuid,
      CASE WHEN l.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END,
      COALESCE(l.guest_player_id, l.profile_id),
      l.guest_player_id,
      l.profile_id,
      l.person_id,
      false,
      l.dismissed
    FROM public.academy_player_locations l
  )
`;

/**
 * Per-row facts. Every predicate is a SELECT over ids and booleans; no direct identifier is
 * read anywhere in this CTE or downstream.
 */
const FACTS_CTE = /* sql */ `
  facts AS (
    SELECT
      r.*,
      -- the owner exists, in the RIGHT id space. academy_player_locations.academy_profile_id
      -- references profiles(id) while every authorization path resolves an academy through
      -- academy_profiles(id) / academy_managers.academy_profile_id, so "names a profiles row"
      -- is precisely the shipped wrong-target FK.
      (r.academy_profile_id IS NULL
        OR EXISTS (SELECT 1 FROM public.academy_profiles ap WHERE ap.id = r.academy_profile_id)) AS academy_exists,
      (r.academy_profile_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.academy_profiles ap WHERE ap.id = r.academy_profile_id)
        AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.academy_profile_id)) AS wrong_target_academy_fk,
      (r.trainer_profile_id IS NULL
        OR EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = r.trainer_profile_id)) AS trainer_exists,
      -- the subject exists
      CASE WHEN r.subject_kind = 'guest'
        THEN EXISTS (SELECT 1 FROM public.guest_players g WHERE g.id = r.guest_player_id)
        ELSE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.profile_id)
      END AS subject_exists,
      -- canonical person for the subject, via person_links ONLY (never inferred from PII)
      CASE WHEN r.subject_kind = 'guest'
        THEN (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = r.guest_player_id)
        ELSE (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = r.profile_id)
      END AS linked_person_id,
      CASE WHEN r.subject_kind = 'guest'
        THEN public.is_guest_split_frozen(r.guest_player_id)
        ELSE false
      END AS split_frozen,

      -- ── evidence paths (overlapping by design) ──────────────────────────────────────────
      EXISTS (
        SELECT 1 FROM public.guest_players g
        WHERE g.id = r.guest_player_id AND g.academy_profile_id = r.academy_profile_id
      ) AS v2_academy_owned_guest,
      EXISTS (
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.guest_player_id = r.guest_player_id AND s.academy_profile_id = r.academy_profile_id
      ) AS o1_academy_slot_booking,
      EXISTS (
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        JOIN public.academy_trainers at ON at.trainer_profile_id = s.trainer_id
        WHERE b.player_id = r.profile_id
          AND at.academy_profile_id = r.academy_profile_id
          AND at.status = 'active'
          AND b.status IN ('confirmed', 'completed')
      ) AS o2_registered_slot_booking,
      EXISTS (
        SELECT 1 FROM public.guest_players g
        WHERE g.id = r.guest_player_id AND g.trainer_id = r.trainer_profile_id
      ) AS v5_trainer_owned_guest,
      EXISTS (
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.guest_player_id = r.guest_player_id
          AND s.trainer_id = r.trainer_profile_id
          AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      ) AS o3_trainer_slot_booking
    FROM rows_all r
  )
`;

/**
 * Canonical-membership evidence is separated because `academy_player_memberships` may not
 * exist in every environment this runs against (U1a ships it at 20261113100000).
 *
 * The arm is chosen STRUCTURALLY, not with a runtime guard. A `CASE WHEN to_regclass(...)`
 * test does not help: PostgreSQL resolves every relation in a statement at parse time, so a
 * query that merely MENTIONS the missing table fails before any guard runs. The caller probes
 * first and this emits either the real predicate or a constant.
 */
const membershipCte = (hasMemberships) => (hasMemberships
  ? /* sql */ `
  membership AS (
    SELECT
      f.row_id,
      (f.linked_person_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.academy_player_memberships apm
        WHERE apm.academy_profile_id = f.academy_profile_id
          AND apm.person_id = f.linked_person_id
      )) AS v1_canonical_membership
    FROM facts f
  )
`
  : /* sql */ `
  membership AS (
    SELECT f.row_id, false AS v1_canonical_membership FROM facts f
  )
`);

/**
 * Duplicate/conflicting: more than one row, for the SAME source table and owner, resolving to
 * the same PERSON. The partial unique indexes already prevent two rows per (owner, same key),
 * so this can only arise across the guest-keyed and profile-keyed rows of one merged person —
 * exactly the case whose disposition is unsettled.
 */
const DUPLICATE_CTE = /* sql */ `
  dup AS (
    SELECT f.source_table, f.owner_kind, f.academy_profile_id, f.trainer_profile_id,
           f.linked_person_id, count(*) AS n
    FROM facts f
    WHERE f.linked_person_id IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
    HAVING count(*) > 1
  )
`;

/**
 * The disposition decision, defined ONCE. Several queries need it; duplicating it invites the
 * report-vs-fact disagreement this inventory exists to prevent. Expects `facts` as `f` with
 * `membership` joined as `mb` and `dup` available.
 */
const DISPOSITION_CASE = /* sql */ `
  CASE
    -- 1. the row does not point at things that exist
    WHEN f.wrong_target_academy_fk THEN 'wrong_target_academy_fk'
    WHEN NOT f.subject_exists OR NOT f.academy_exists OR NOT f.trainer_exists THEN 'orphan_reference'

    -- 2. no TRUSTED evidence — ranked ABOVE the data-quality classes on purpose: a forged row
    --    usually has no person link either, and calling that "missing person stamp" would file
    --    a security finding as housekeeping.
    --
    --    Booking signals are deliberately EXCLUDED from this test (ABC-17: the subject was
    --    reassignable by the very party the signal would authorize). A row supported only by a
    --    booking is reported as its own class rather than as evidenced.
    WHEN NOT (mb.v1_canonical_membership OR f.v2_academy_owned_guest OR f.v5_trainer_owned_guest)
      THEN CASE
             WHEN f.o1_academy_slot_booking OR f.o2_registered_slot_booking OR f.o3_trainer_slot_booking
               THEN 'booking_observation_only'
             WHEN f.source_table = 'academy_player_locations' THEN 'location_only'
             ELSE 'metadata_only'
           END

    -- 3. evidenced, but something about the row still needs a decision
    WHEN EXISTS (
      SELECT 1 FROM dup d
      WHERE d.source_table = f.source_table
        AND d.owner_kind = f.owner_kind
        AND d.linked_person_id = f.linked_person_id
        AND d.academy_profile_id IS NOT DISTINCT FROM f.academy_profile_id
        AND d.trainer_profile_id IS NOT DISTINCT FROM f.trainer_profile_id
    ) THEN 'duplicate_or_conflicting'
    WHEN f.split_frozen THEN 'split_frozen'
    WHEN f.linked_person_id IS NULL THEN 'missing_person_stamp'
    WHEN f.stamped_person_id IS NULL THEN 'stale_person_stamp'
    WHEN f.stamped_person_id IS DISTINCT FROM f.linked_person_id THEN 'divergent_person_stamp'

    -- 4. evidenced and sound
    WHEN mb.v1_canonical_membership THEN 'canonical_membership_backed'
    WHEN f.v2_academy_owned_guest THEN 'independently_academy_evidenced'
    ELSE 'independently_trainer_evidenced'
  END
`;

const baseCtes = (hasMemberships) => /* sql */ `
  WITH ${ROWS_CTE},
  ${FACTS_CTE},
  ${membershipCte(hasMemberships)},
  ${DUPLICATE_CTE}
`;

/** Probe run on its own, BEFORE any query that could reference the optional table. */
export const MEMBERSHIP_PROBE_SQL =
  `SELECT to_regclass('public.academy_player_memberships') IS NOT NULL AS has_memberships`;

/**
 * Ordered, canonical query set. Every statement is a SELECT; the transaction is READ ONLY.
 *
 * `asOf` is echoed rather than used as a cut-off: none of these predicates are time-based, so
 * introducing one would add non-determinism without adding meaning. It is still required and
 * still recorded, so a report is always attributable to a stated instant.
 */
export function buildQueries(asOf, { hasMemberships = false } = {}) {
  const BASE_CTES = baseCtes(hasMemberships);
  return {
    /** Row-level detail. Pseudonymous ids only — artifact output, never stdout. */
    rows: {
      sql: /* sql */ `
        ${BASE_CTES}
        SELECT
          f.source_table,
          f.row_id,
          f.owner_kind,
          f.academy_profile_id,
          f.trainer_profile_id,
          f.subject_kind,
          f.subject_id,
          f.stamped_person_id,
          f.linked_person_id,
          f.removed,
          f.dismissed,
          mb.v1_canonical_membership,
          f.v2_academy_owned_guest,
          f.o1_academy_slot_booking,
          f.o2_registered_slot_booking,
          f.v5_trainer_owned_guest,
          f.o3_trainer_slot_booking,
          ${DISPOSITION_CASE} AS disposition
        FROM facts f
        JOIN membership mb ON mb.row_id = f.row_id
        ORDER BY f.source_table, f.row_id
      `,
    },

    /** Disposition totals — the summary that is safe on stdout. */
    dispositions: {
      sql: /* sql */ `
        ${BASE_CTES}
        SELECT ${DISPOSITION_CASE} AS disposition, f.source_table, count(*)::int AS n
        FROM facts f
        JOIN membership mb ON mb.row_id = f.row_id
        GROUP BY 1, 2
        ORDER BY 1, 2
      `,
    },

    /**
     * Removed-but-preserved is reported as its OWN count rather than a disposition: a removed
     * row still has whatever evidence it has, and collapsing it into the partition would hide
     * that. H0 preserves these rows and the readers still honour them.
     */
    removed_but_preserved: {
      sql: /* sql */ `
        ${BASE_CTES}
        SELECT ${DISPOSITION_CASE} AS disposition, count(*)::int AS n
        FROM facts f
        JOIN membership mb ON mb.row_id = f.row_id
        WHERE f.removed
        GROUP BY 1
        ORDER BY 1
      `,
    },

    /** Evidence-path totals. These overlap; they do not sum to the row count. */
    evidence_paths: {
      sql: /* sql */ `
        ${BASE_CTES}
        SELECT
          count(*) FILTER (WHERE mb.v1_canonical_membership)::int AS v1_canonical_membership,
          count(*) FILTER (WHERE f.v2_academy_owned_guest)::int    AS v2_academy_owned_guest,
          count(*) FILTER (WHERE f.o1_academy_slot_booking)::int   AS o1_academy_slot_booking,
          count(*) FILTER (WHERE f.o2_registered_slot_booking)::int AS o2_registered_slot_booking,
          count(*) FILTER (WHERE f.v5_trainer_owned_guest)::int    AS v5_trainer_owned_guest,
          count(*) FILTER (WHERE f.o3_trainer_slot_booking)::int   AS o3_trainer_slot_booking
        FROM facts f
        JOIN membership mb ON mb.row_id = f.row_id
      `,
    },

    /** Per-owner breakdown, so a decision can be scoped to one academy or trainer. */
    by_owner: {
      sql: /* sql */ `
        ${BASE_CTES}
        SELECT
          f.owner_kind,
          COALESCE(f.academy_profile_id, f.trainer_profile_id) AS owner_id,
          ${DISPOSITION_CASE} AS disposition,
          count(*)::int AS n
        FROM facts f
        JOIN membership mb ON mb.row_id = f.row_id
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
      `,
    },

    /** Environment facts the report should be attributable to. */
    environment: {
      sql: /* sql */ `
        SELECT ${hasMemberships} AS has_memberships,
               current_setting('server_version') AS server_version
      `,
    },

    as_of_echo: { sql: `SELECT $1::timestamptz AS as_of`, params: [asOf] },
  };
}

// ── executor ──────────────────────────────────────────────────────────────────────────────
// Same contract as u1a-membership-inventory.mjs: sessionSource is an OBJECT exposing
// connect(), resolving to an exclusive { query, release } lease. A bare callback or
// pool.query is rejected structurally — neither can own a session, and pool.query scatters
// statements across connections, voiding both READ ONLY and the REPEATABLE READ snapshot.

function assertValidAsOf(asOf) {
  // An ABSOLUTE instant only. PostgreSQL parses 'now'/'today'/'yesterday' as timestamptz,
  // which would smuggle wall-clock behaviour back into a "fixed" as_of.
  if (typeof asOf !== 'string'
      || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(asOf)) {
    throw new InventoryExecutorError(
      'INVALID_AS_OF',
      `runAbc16Inventory: \`asOf\` must be an absolute ISO-8601 timestamp with offset (got ${JSON.stringify(asOf)}).`,
    );
  }
}

function assertValidSessionSource(sessionSource) {
  // typeof check FIRST: a function decorated with a `.connect` property must still be
  // rejected — that is the shape a caller would reach for to smuggle a bare callback back in.
  if (typeof sessionSource !== 'object' || sessionSource === null || Array.isArray(sessionSource)) {
    throw new InventoryExecutorError(
      'INVALID_SESSION_SOURCE',
      'runAbc16Inventory: pass a session SOURCE object exposing connect() — a real pg.Pool qualifies. '
      + 'A bare query callback or pool.query cannot own a session.',
    );
  }
  if (typeof sessionSource.connect !== 'function') {
    throw new InventoryExecutorError(
      'INVALID_SESSION_SOURCE',
      'runAbc16Inventory: sessionSource.connect must be a function resolving to an exclusive { query, release } client.',
    );
  }
}

/** The transaction mode is asserted, not assumed: BEGIN can be silently overridden by a wrapper. */
async function assertTransactionMode(client) {
  const { rows } = await client.query(
    `SELECT current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only`,
  );
  const isolation = String(rows?.[0]?.isolation ?? '').toLowerCase();
  const readOnly = String(rows?.[0]?.read_only ?? '').toLowerCase();
  if (isolation !== 'repeatable read' || readOnly !== 'on') {
    throw new InventoryExecutorError(
      'TRANSACTION_MODE',
      `runAbc16Inventory: transaction is ${isolation}/read_only=${readOnly}, expected repeatable read/read_only=on.`,
    );
  }
}

/**
 * Mutation fingerprint per source table: row count + a digest over SYSTEM columns only.
 *
 * NOT `md5(x::text)`. That hashes the WHOLE ROW, which for `guest_players` and `profiles`
 * means feeding every name, email, phone, birth date and billing field through the digest —
 * a direct contradiction of this tool's own privacy claim, and a usable oracle against a
 * guessed plaintext.
 *
 * `ctid` identifies the physical row and `xmin` the transaction that last wrote it, so any
 * UPDATE changes the digest while `count(*)` catches INSERT and DELETE. Neither is user data,
 * and both exist on every table — including the ones with no surrogate `id` column. Inside one
 * REPEATABLE READ transaction neither can drift for any other reason.
 */
async function fingerprintSources(client) {
  const out = {};
  for (const table of SOURCE_TABLES) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n,
              COALESCE(md5(string_agg(t.digest, '' ORDER BY t.digest)), '') AS digest
       FROM (SELECT md5(x.ctid::text || ':' || x.xmin::text) AS digest FROM public.${table} x) t`,
    );
    out[table] = { rows: rows[0].n, digest: rows[0].digest };
  }
  return out;
}

/**
 * Run the inventory.
 *
 * @param {{ connect(): Promise<{query: Function, release: Function}> }} sessionSource
 * @param {{ asOf: string }} options `asOf` is REQUIRED and fixed by the caller.
 */
export async function runAbc16Inventory(sessionSource, { asOf } = {}) {
  assertValidAsOf(asOf);
  assertValidSessionSource(sessionSource);

  const client = await sessionSource.connect();

  // Cleanup capability is determined INDEPENDENTLY of client validity: a malformed client that
  // can still be released must be released, or the lease leaks. Both capability reads are
  // guarded because `query`/`release` may be accessors or proxy traps that throw, and
  // `release` is read EXACTLY ONCE — reading it twice lets a getter hand back a callable the
  // first time and throw the second, losing a lease we could have released.
  let releaseFn = null;
  try {
    const releaseCandidate = client?.release;
    if (typeof releaseCandidate === 'function') {
      releaseFn = (...args) => Reflect.apply(releaseCandidate, client, args);
    }
  } catch { releaseFn = null; }

  let hasQuery = false;
  try { hasQuery = typeof client?.query === 'function'; } catch { hasQuery = false; }

  if (releaseFn === null || !hasQuery) {
    if (releaseFn !== null) { try { await releaseFn(); } catch { /* already failing */ } }
    throw new InventoryExecutorError(
      'INVALID_CLIENT',
      'runAbc16Inventory: sessionSource.connect() must resolve to { query, release }.',
    );
  }

  let released = false;
  const release = async (err) => {
    if (released) return;
    released = true;              // marked BEFORE awaiting: a throwing release is never retried
    await releaseFn(err);
  };

  let beginAttempted = false;
  let commitConfirmed = false;

  try {
    beginAttempted = true;
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertTransactionMode(client);

    const fingerprintBefore = await fingerprintSources(client);

    const { rows: probe } = await client.query(MEMBERSHIP_PROBE_SQL);
    const hasMemberships = Boolean(probe?.[0]?.has_memberships);

    const queries = buildQueries(asOf, { hasMemberships });
    const report = {};
    for (const name of Object.keys(queries).sort()) {
      const { sql, params } = queries[name];
      const { rows } = await client.query(sql, params ?? []);
      report[name] = rows;
    }

    const fingerprintAfter = await fingerprintSources(client);

    // The COMPLETE result is built and hashed BEFORE commit: a partial report is never returned.
    const dispositionCounts = {};
    for (const key of DISPOSITION_PRECEDENCE) dispositionCounts[key] = 0;
    for (const row of report.dispositions) dispositionCounts[row.disposition] += row.n;

    const totalRows = report.rows.length;
    const summedDispositions = Object.values(dispositionCounts).reduce((a, b) => a + b, 0);
    if (summedDispositions !== totalRows) {
      throw new InventoryExecutorError(
        'PARTITION_VIOLATED',
        `runAbc16Inventory: dispositions summed to ${summedDispositions} but ${totalRows} rows exist. `
        + 'The disposition set must partition the row universe.',
      );
    }

    const body = {
      inventory_version: INVENTORY_VERSION,
      as_of: asOf,
      total_rows: totalRows,
      disposition_counts: dispositionCounts,
      report,
    };
    const result = {
      ...body,
      source_fingerprint_before: fingerprintBefore,
      source_fingerprint_after: fingerprintAfter,
      mutation_free: canonicalize(fingerprintBefore) === canonicalize(fingerprintAfter),
      content_hash: contentHash(body),
    };

    await client.query('COMMIT');
    commitConfirmed = true;

    await release();              // a release failure here rejects the run — it is not "success"
    return result;
  } catch (err) {
    if (beginAttempted && !commitConfirmed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // The connection may be poisoned: hand a TRUTHY Error to release() so a pool discards
        // it instead of returning a session whose transaction state is unknown.
        const disposal = rollbackErr instanceof Error
          ? rollbackErr
          : new Error(`ROLLBACK failed: ${String(rollbackErr)}`);
        try { await release(disposal); } catch { /* preserve the original error */ }
        throw err;
      }
    }
    try { await release(); } catch { /* preserve the original error */ }
    throw err;
  }
}

// ── invocation guards ─────────────────────────────────────────────────────────────────────

/**
 * The ONLY hosts this tool may connect to.
 *
 * An ALLOW-list, not a deny-list. The first draft rejected three Supabase host patterns and
 * called itself local-only, which meant a self-hosted production database, a bare IP, an SSH
 * tunnel or any hostname the list did not anticipate was accepted as "local". A deny-list
 * cannot express "local"; enumerating loopback can.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Decide whether a connection string may be used, and say exactly why not when it may not.
 *
 * Exported so a test can exercise every branch without opening a socket.
 *
 * Under the current ABC-16 approval this tool is LOCAL ONLY. The guard is deliberately an
 * allow-nothing-by-default check on the HOST rather than a flag the caller can set: a flag
 * that disables a production guard is the same thing as no guard.
 */
export function assertInvocationAllowed({ connectionString, ack } = {}) {
  if (ack !== 'local-read-only') {
    throw new InventoryExecutorError(
      'ACK_REQUIRED',
      'Set ABC16_INVENTORY_ACK=local-read-only to confirm this is a LOCAL, read-only run. '
      + 'ABC-16 does not authorize running this against production.',
    );
  }
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new InventoryExecutorError(
      'CONNECTION_REQUIRED',
      'Set ABC16_INVENTORY_DATABASE_URL. A dedicated variable is required on purpose: reading a '
      + 'generic DATABASE_URL/SUPABASE_DB_URL would let an ambient production credential be used by accident.',
    );
  }
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new InventoryExecutorError(
      'CONNECTION_UNPARSEABLE',
      'ABC16_INVENTORY_DATABASE_URL must be a parseable postgres:// URL.',
    );
  }
  if (!ALLOWED_HOSTS.has(host.toLowerCase())) {
    throw new InventoryExecutorError(
      'REMOTE_REFUSED',
      `Refusing to connect to ${host}: this tool is local-only and accepts loopback hosts exclusively `
      + `(${[...ALLOWED_HOSTS].join(', ')}). Running the inventory against any other database — including a `
      + 'self-hosted or tunnelled one — is a separate owner gate.',
    );
  }
  return { host };
}

/**
 * Summary safe for stdout: counts and codes, no ids. `rows`/`by_owner` are withheld here
 * because a UUID re-identifies a person for anyone holding the database; they go to the
 * artifact only.
 */
export function toStdoutSummary(result) {
  return {
    inventory_version: result.inventory_version,
    as_of: result.as_of,
    total_rows: result.total_rows,
    disposition_counts: result.disposition_counts,
    evidence_paths: result.report.evidence_paths?.[0] ?? {},
    removed_but_preserved: result.report.removed_but_preserved ?? [],
    environment: result.report.environment?.[0] ?? {},
    mutation_free: result.mutation_free,
    content_hash: result.content_hash,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
//
// Everything above is import-safe: no connection is opened and no environment is read at
// import time, so the rehearsal can drive the engine against PGlite without any of this.
//
//   ABC16_INVENTORY_ACK=local-read-only \
//   ABC16_INVENTORY_DATABASE_URL=postgres://... \
//   node scripts/db/abc16-metadata-authority-inventory.mjs --as-of 2026-08-11T00:00:00Z [--artifact out.json]
//
// stdout is the summary. Row-level detail is written ONLY to an explicitly requested
// artifact, created 0600 — never logged, so a verbose CI job cannot leak it into a shared log.

/**
 * Write the row-level artifact, refusing to clobber and refusing to follow a symlink.
 *
 * The artifact contains pseudonymous ids for every overlay row, so where it lands matters as
 * much as its mode:
 *
 *   O_EXCL     an existing path is an error, never an overwrite. A run must not silently
 *              destroy a previous run's evidence, and an attacker-planted path must not be
 *              quietly adopted.
 *   O_NOFOLLOW the final component is not followed if it is a symlink, so the file cannot be
 *              redirected into somewhere world-readable. (O_EXCL|O_CREAT already refuses a
 *              symlink per POSIX; O_NOFOLLOW states it rather than relying on it.)
 *   0600       at creation, not chmod-after: a world-readable window, however short, is a leak.
 *
 * Exported so the guardrail suite can exercise both refusals without a live database.
 */
export function writeArtifactSecurely(path, contents) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  let fd;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'ELOOP')) {
      // EEXIST covers BOTH refusals: with O_CREAT|O_EXCL a symlink — even a dangling one —
      // reports EEXIST rather than ELOOP on macOS and Linux alike, so the message must not
      // claim to know which of the two happened.
      throw new InventoryExecutorError(
        'ARTIFACT_UNSAFE',
        `Refusing to write ${path}: the path already exists or is a symlink. This run will neither `
        + 'overwrite another run\'s evidence nor follow a link that could redirect pseudonymous '
        + 'personal data somewhere world-readable. Choose a fresh path.',
      );
    }
    throw err;
  }
  try {
    writeFileSync(fd, contents, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}

function parseArgs(argv) {
  const out = { asOf: null, artifact: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--as-of') { out.asOf = argv[i + 1] ?? null; i += 1; }
    else if (argv[i] === '--artifact') { out.artifact = argv[i + 1] ?? null; i += 1; }
  }
  return out;
}

async function main() {
  const { asOf, artifact } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.ABC16_INVENTORY_DATABASE_URL ?? '';
  const ack = process.env.ABC16_INVENTORY_ACK ?? '';

  const { host } = assertInvocationAllowed({ connectionString, ack });

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await runAbc16Inventory(pool, { asOf });

    if (artifact) {
      writeArtifactSecurely(artifact, `${JSON.stringify(result, null, 2)}\n`);
    }

    process.stdout.write(`${JSON.stringify(toStdoutSummary(result), null, 2)}\n`);
    process.stdout.write(
      `\n[abc16] host=${host} rows=${result.total_rows} mutation_free=${result.mutation_free}`
      + `${artifact ? ` artifact=${artifact} (0600, contains pseudonymous ids)` : ' (no artifact requested — summary only)'}\n`,
    );
    if (!result.mutation_free) {
      process.stderr.write('[abc16] FAIL: source fingerprints changed during a READ ONLY run.\n');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Run only when executed directly, never when imported by the rehearsal or a test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`[abc16] ${err?.code ? `${err.code}: ` : ''}${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
}
