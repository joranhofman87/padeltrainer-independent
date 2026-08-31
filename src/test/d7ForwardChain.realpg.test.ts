// @vitest-environment node
//
// D7 RUNTIME — FORWARD-CHAIN EVIDENCE (E-4, E-4b, E-11), on real embedded PostgreSQL.
//
// THE PROPERTY THIS FILE EXISTS FOR. The two D7 migrations sit on OPPOSITE sides of ABC-27, and
// every post-ABC-27 migration carries a prerequisite guard — because the frozen ABC-27 suite
// replays the directory MINUS the file under test and would otherwise run those files BEFORE the
// objects they depend on. A guard that skips is a FAIL-OPEN: nothing in that suite can distinguish
// "correctly skipped an impossible order" from "skips unconditionally and does nothing at all". So
// this file replays the lineage in TRUE FILENAME ORDER and measures the schema that produces.
//
// NOTHING HERE DEPENDS ON TAIL POSITION. There is no assertion that any D7 file is the last in the
// lineage, and there must never be one: "is last" is a proxy that says nothing about what a file
// DOES and stops being true the moment the composed A-and-D lineage grows another migration. The
// invariants asserted instead are ORDER RELATIVE TO ABC-27, version uniqueness across the whole
// composed union, guard PRESENCE on every post-ABC-27 file, and the guard never firing in true
// filename order.
//
// EVERY POSITIVE ASSERTION IS PAIRED WITH A CONTROL. A test that only looks at the "after" state
// cannot tell a working migration from an assertion that was already true.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABC27, AGGREGATE_PROBE, bootD7Chain, catalogObjects, COLUMN_PROBE, CONSTRAINT_PROBE, D7_CRONS,
  D7_BOOKING_HOLD, D7_CUTOFF_REASON, D7_GUARD_HARDENING, D7_LINEARIZE, D7_PAID_GROUP,
  D7_RETIRE, D7_SELECTION, D7_SELECTION_APPLY, D7_SELECTION_SURFACE, D7_HUMAN_NAMES,
  armDdlWitness, armDmlWitness, DB_ROLE_SETTING_PROBE,
  DEFAULT_ACL_PROBE, diffObjects,
  DATABASE_PROBE, ENUM_PROBE, EVENT_TRIGGER_PROBE, EXTENSION_PROBE, PARAMETER_ACL_PROBE,
  PUBLICATION_PROBE, RULE_PROBE, SEQUENCE_PROBE, SYSTEM_ROUTINE_PROBE,
  INDEX_PROBE, lineage, migrationSql, POLICY_PROBE, RELATION_PROBE, ROLE_PROBE, ROUTINE_DEF_PROBE,
  readDdlWitness, readDmlWitness, ROUTINE_SHAPE_PROBE, SCHEMA_PROBE, TRIGGER_PROBE, VIEW_PROBE, type D7Chain,
} from './d7RealChain';

const PORT = 54502;
const PREFIX = 'd7fwd';

/**
 * The exact reviewed text of the region `20261203130000` inserts into `begin_dispatch`, by digest.
 *
 * Measured, then pinned. It is the ONE part of that body this release is allowed to change, so it
 * is also the one part a byte-identity comparison against ABC-27 cannot cover — and therefore the
 * only place an unreviewed edit could hide. Changing it is meant to be a re-review, not a diff
 * nobody reads.
 */

/**
 * The line-level difference between two function bodies, as inserted and deleted blocks.
 *
 * WHY A DIFF AND NOT STRING ANCHORS. An earlier revision located the inserted region by searching
 * for a comment line and an end marker. That works until the region moves, until its first line is
 * reworded, or until a second closure inserts at a different place — and when it stops working it
 * does so by finding nothing and reporting `-1`, which is a test that fails for the wrong reason.
 * A diff needs no anchors and states the stronger property directly: these bodies are the ORIGINAL
 * plus insertions, with nothing removed.
 */
function bodyDiff(before: string, after: string): { inserted: string[]; deleted: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence over lines. These bodies are a few hundred lines, so the quadratic
  // table is trivial and the exactness is worth more than the cleverness.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const inserted: string[] = [];
  const deleted: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      deleted.push(a[i]); i += 1;
    } else { inserted.push(b[j]); j += 1; }
  }
  while (i < a.length) { deleted.push(a[i]); i += 1; }
  while (j < b.length) { inserted.push(b[j]); j += 1; }
  return { inserted, deleted };
}

/** The body of one routine, as installed. */
const installedBody = async (c: pg.Client, ident: string): Promise<string> =>
  (await c.query(`SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1)`,
    [ident])).rows[0].prosrc as string;

/**
 * Both closures nest their `CREATE OR REPLACE` inside a `DO` block, so every line of the installed
 * body carries two extra leading spaces. That is the only systematic difference, and undoing it is
 * what lets the comparison be exact instead of whitespace-insensitive — which would forgive real
 * edits along with the harmless one.
 */
const dedent2 = (t: string): string =>
  t.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');

// RE-PINNED BY THE CANONICAL-OUTBOX GENERALIZATION, which is what re-pinning these is FOR.
//
// 106 -> 107 lines, and the one added line is the widened event-type predicate: `begin_dispatch`'s
// test moved from the single member-open literal to the closed protected set, so one transport
// machine serves a second event type. The deleted original is named line-for-line in the delta test
// below, which also proves it returned in widened form rather than simply vanishing.
//
// Updating these two constants is meant to be a re-review. It was one.
const REVIEWED_INSERTION_SHA256 = 'ce02438ed6e16dc9c3444b925ef29c8fe9a1932b83de5d8a936d972979c2859c';
const REVIEWED_INSERTION_LINES = 122;

/** The same, for the hold region the two eligibility closures introduce. Measured, then pinned. */
const REVIEWED_HOLD_REGION_SHA256 = 'ffd13eabaa55e4637aa0153808ea5f4ef834fc063a33a35beb0fac9ad8e4a5a6';
const REVIEWED_HOLD_REGION_LINES = 53;

/**
 * A SQL body with its COMMENTS removed and its LITERALS intact, in one leftmost-first pass.
 *
 * Every `prosrc` assertion in this file goes through it. A raw substring check over a function body
 * is satisfiable by a comment — keep the reviewed text as prose, change the executable arm beside
 * it, and the pin stays green over a body that no longer does what it says. Literals survive
 * because the predicates being looked for contain them; the alternation recognises a literal so a
 * `--` inside one cannot eat the code that follows.
 */
const strip = (sql: string): string =>
  sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => (m.startsWith("'") ? m : ' '));

/** The four §10a member-open shims this release retires, by exact reviewed identity. */
const RETIRED_SHIMS = [
  'claim_rebook_member_open_notice(uuid)',
  'unclaim_rebook_member_open_notice(uuid)',
  'append_rebook_member_open_notified(uuid,text[])',
  'rebook_cycles_needing_member_open_notice()',
] as const;
const RETIRED_SHIM_NAMES = [
  'claim_rebook_member_open_notice', 'unclaim_rebook_member_open_notice',
  'append_rebook_member_open_notified', 'rebook_cycles_needing_member_open_notice',
] as const;

/** The eight machine surfaces `service_role` is granted, and the only ones the workers may call. */
const GRANTED_MACHINE = [
  'rebook_round_materialize',
  'rebook_member_open_claim_batch',
  'rebook_member_open_pre_dispatch_resolve',
  'rebook_member_open_begin_dispatch',
  'rebook_member_open_record_dispatch_outcome',
  'rebook_member_open_recover_expired_leases',
  'rebook_member_open_close_unresolved',
  'rebook_member_open_dispatch_status_by_capability',
] as const;

/**
 * The D7 surfaces `service_role` must NOT reach — the negative space.
 *
 * Least privilege is only proved when it is proved in BOTH directions: a test that shows the eight
 * granted functions work says nothing about the twenty-odd that must not. This is the half that
 * keeps a future blanket grant, or an ownership transfer that rewrites owner ACL entries, from
 * quietly handing the workers the authority surface.
 */
const ABSENT_FOR_SERVICE_ROLE = [
  // the enqueue core, the classifier and the renderer: the write, decide and render authorities
  'rebook_member_open_enqueue_core',
  'rebook_member_open_classify_provider_result',
  'rebook_member_open_render_payload',
  'rebook_member_open_trusted_payload',
  // the five operator cores behind the wrappers
  'rebook_round_preview_normalized_core',
  'rebook_round_apply_normalized_core',
  'rebook_round_apply_lifecycle_command_core',
  'rebook_round_command_status_core',
  'rebook_round_command_lookup_by_review_core',
  // the BARE-UUID status read: a UUID is not an authorization, so no role holds it
  'rebook_member_open_dispatch_status',
  // the freeze, the recipient enumeration, the sibling page and the legacy review summary
  'rebook_round_freeze_and_snapshot',
  'rebook_round_eligible_recipients',
  'rebook_round_siblings_page',
  'rebook_round_legacy_review_summary',
] as const;

/** The five operator wrappers. `service_role` holds EXECUTE on none of them (S-2). */
const OPERATOR_WRAPPERS = [
  'rebook_round_preview_command_as_actor',
  'rebook_round_apply_command_as_actor',
  'rebook_round_apply_lifecycle_command_as_actor',
  'rebook_round_command_status_as_actor',
  'rebook_round_command_lookup_by_review_as_actor',
] as const;

const D7_JOBS = [
  ['rebook-member-open-worker', '*/2 * * * *'],
  ['rebook-round-materializer', '*/5 * * * *'],
  ['rebook-member-open-janitor', '*/10 * * * *'],
] as const;

let chain: D7Chain;
/**
 * The lineage up to and including ABC-27 — the cron half HAS run, neither post-ABC-27 file has.
 * This is the control for every schema change the two of them make.
 */
let pre: pg.Client;
/** The complete chain, in true filename order. */
let main: pg.Client;
/**
 * THE COUNTERFACTUAL: the same lineage with the cron migration OMITTED ENTIRELY.
 *
 * The cron half now sorts BEFORE ABC-27, so it is mid-lineage and cannot be held back — which
 * means the only honest way to show it is the thing producing the cron effects is to replay
 * without it and measure the difference. This database is NOT a claim about any real order; it is
 * a control, and nothing below reads it as anything else.
 */
let noCron: pg.Client;
/** The full chain replayed with an EMPTY vault — the no-Vault-guard arm. */
let novault: pg.Client;
/**
 * THE SHARED (CLUSTER-WIDE) CATALOGS, AND WHY THEY NEED THEIR OWN TREATMENT.
 *
 * `pg_roles`, `pg_auth_members` and `pg_db_role_setting` are shared across the whole cluster, not
 * per-database. `pre`, `main`, the counterfactual and the witness clone all live in ONE cluster, so
 * anything a held-back file does to them is visible from every database at once — a `pre` vs `main`
 * diff of them is empty BY CONSTRUCTION, and so is a before/after bracket taken on a clone that is
 * built after another database has already applied the same files. Both shapes are probes that
 * cannot fail.
 *
 * The only reading that works is one taken while NO held-back file has run anywhere in the cluster,
 * which is what `beforeAll` does below.
 */
const SHARED_CATALOGS: [string, string][] = [
  ['roles and memberships', ROLE_PROBE],
  ['per-role / per-database session settings', DB_ROLE_SETTING_PROBE],
  ['databases', DATABASE_PROBE],
  ['parameter ACLs', PARAMETER_ACL_PROBE],
];
const sharedBeforeAnyApply = new Map<string, Map<string, string>>();
/** The same catalogs immediately after the FIRST held-back apply, and before any other. */
const sharedAfterFirstApply = new Map<string, Map<string, string>>();

beforeAll(async () => {
  chain = await bootD7Chain({
    port: PORT,
    prefix: PREFIX,
    // Everything from the first post-ABC-27 file onward, DERIVED from the directory. Naming a
    // start rather than a list is what keeps this from depending on which migration is last.
    holdBackFrom: D7_RETIRE,
    // LOAD-BEARING. `20260722100000_rebook_crons_use_vault.sql` RETURNS EARLY when the Vault secret
    // is missing, so without it the legacy `notify-rebook-member-open` job is never scheduled and
    // "the retirement removed it" would be a vacuous pass over a job that never existed.
    vaultServiceRoleKey: 'd7-forward-chain-test-key',
  });
  pre = await chain.clone(`${PREFIX}_pre`);
  main = await chain.clone(`${PREFIX}_main`);
  // ROLES ARE CLUSTER-WIDE, SO THEY MUST BE CAPTURED BEFORE THE FIRST APPLY OF ANYTHING.
  // `pg_roles` is not per-database: an `ALTER ROLE authenticated BYPASSRLS` performed while
  // applying the held-back files to ANY database in this cluster is immediately visible from every
  // other one, so a `pre` vs `main` diff of roles is empty by construction — a probe that cannot
  // fail. This snapshot is taken while no held-back file has run anywhere.
  for (const [label, sql] of SHARED_CATALOGS) {
    sharedBeforeAnyApply.set(label, await catalogObjects(pre, sql));
  }
  await chain.applyHeldBack(main);
  // …AND THE "AFTER" SIDE IS READ HERE, immediately after the FIRST apply and before the tail runs
  // on any other database. Reading it later would compare a value the same files had produced
  // FOUR times: a migration whose effect toggles ("if it is set, unset it; otherwise set it") ends
  // production in one state and this cluster in the other, and an endpoint comparison taken after
  // an even number of applies would report no difference at all.
  for (const [label, sql] of SHARED_CATALOGS) {
    sharedAfterFirstApply.set(label, await catalogObjects(main, sql));
  }

  await chain.buildTemplate(`${PREFIX}_nocron_tpl`, { omit: [D7_CRONS] });
  noCron = await chain.cloneFrom(`${PREFIX}_nocron_tpl`, `${PREFIX}_nocron`);
  await chain.applyHeldBack(noCron);

  // The Vault secret has to be absent BEFORE the cron migration runs, and that migration is now
  // mid-lineage — so this arm needs its own replay rather than a DELETE on a clone.
  await chain.buildTemplate(`${PREFIX}_novault_tpl`, { vaultServiceRoleKey: null });
  novault = await chain.cloneFrom(`${PREFIX}_novault_tpl`, `${PREFIX}_novault`);
  await chain.applyHeldBack(novault);
}, 600_000);

afterAll(async () => {
  await chain?.shutdown();
});

// ── The order itself ─────────────────────────────────────────────────────────────────────────

describe('D7 forward chain — composed order, version uniqueness, and guards that really run', () => {
  it('EVERY migration version in the COMPOSED lineage is globally unique', () => {
    // `supabase_migrations.schema_migrations` is keyed by the VERSION prefix, so two files sharing
    // one would be a duplicate-key failure at push time — after part of the lineage had already
    // been applied. Reissuing a migration at a new version is exactly the operation that can
    // introduce one, and the A and D work streams reissue independently, so this checks the WHOLE
    // directory — the composed A ∪ D union as it stands on disk — rather than the files that moved.
    const versions = lineage().map((f) => f.slice(0, 14));
    const seen = new Map<string, number>();
    for (const v of versions) seen.set(v, (seen.get(v) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1), 'duplicate migration versions').toEqual([]);
    expect(versions.every((v) => /^\d{14}$/.test(v)), 'every version is a 14-digit timestamp').toBe(true);
  });

  it('places the cron half BEFORE ABC-27 and the schema half AFTER it, by filename', () => {
    const all = lineage();
    expect(all.length).toBeGreaterThan(600);
    const iCron = all.indexOf(D7_CRONS);
    const iAbc = all.indexOf(ABC27);
    const iRetire = all.indexOf(D7_RETIRE);
    expect(iCron, 'the cron migration must be in the lineage').toBeGreaterThan(-1);
    // THE ORDER IS THE SAFETY PROPERTY. The legacy job's first RPC loses `service_role` EXECUTE the
    // instant ABC-27 applies, so the retirement has to be earlier — and encoding that as a filename
    // makes `supabase db push` enforce it, rather than a runbook step someone has to remember.
    expect(iCron, 'the cron retirement must apply BEFORE ABC-27').toBeLessThan(iAbc);
    expect(iRetire, 'the schema half must apply AFTER ABC-27').toBeGreaterThan(iAbc);
    // DELIBERATELY ABSENT: any assertion that D7_RETIRE is the LAST file. It is "after", not
    // "last", and the composed lineage is expected to grow behind it.
    //
    // `holdBack` is validated as a CONTIGUOUS SUFFIX by the harness, which is what makes applying
    // it after the template true filename order — a property that survives new files joining, as a
    // tail-count check would not.
    // The paid-group closure REPLACES an ABC-27-owned body, so it cannot precede ABC-27 either.
    expect(all.indexOf(D7_PAID_GROUP), 'the paid-group closure must apply AFTER ABC-27')
      .toBeGreaterThan(iAbc);
    // …and so does the dispatch linearization closure, which replaces a different ABC-27 body.
    expect(all.indexOf(D7_LINEARIZE), 'the linearization closure must apply AFTER ABC-27')
      .toBeGreaterThan(iAbc);
    // ORDER BETWEEN THE TWO CLOSURES IS NOT A SAFETY PROPERTY and is deliberately not asserted as
    // one: they replace DIFFERENT bodies and neither reads the other's. What IS asserted is that
    // both land after ABC-27, and that the catalog they jointly produce is exactly the reviewed
    // one — proved from the installed catalog further down, not from where the files sit.
    // THE HELD-BACK SET IS DERIVED, NOT ENUMERATED. It is every file at or after the named start,
    // so a migration joining behind these is swept into the same tail automatically. Nothing here
    // asserts which file is LAST — that would be a tail-position proxy, and one new migration
    // would invalidate it.
    expect(chain.heldBack, 'the held-back set is the lineage suffix from the named start')
      .toEqual(all.filter((f) => f >= D7_RETIRE));
    // ALL SIX, NAMED. The list had drifted to three while the release grew to six, which made the
    // claim in its own message untrue — a suffix that happened to contain them would have passed
    // while a file silently went missing from the tail.
    expect(chain.heldBack, 'and it contains every post-ABC-27 file this release ships')
      .toEqual(expect.arrayContaining([D7_RETIRE, D7_PAID_GROUP, D7_LINEARIZE, D7_BOOKING_HOLD,
        D7_CUTOFF_REASON, D7_GUARD_HARDENING, D7_SELECTION, D7_SELECTION_SURFACE,
        D7_HUMAN_NAMES, D7_SELECTION_APPLY]));
    // …and every held-back file really does sort after every applied one, which is the property
    // that makes applying them afterwards true filename order.
    const applied = all.filter((f) => !chain.heldBack.includes(f));
    expect(applied.every((a) => chain.heldBack.every((h) => h > a)),
      'every held-back migration must sort after every applied one').toBe(true);
  });

  it('every POST-ABC-27 migration carries the prerequisite guard, and the guard never fires', async () => {
    // THE STRONGER INVARIANT, in place of "ABC-27 is last". A file that runs after ABC-27 is swept
    // into the frozen suite's predecessor and replayed BEFORE it, so it MUST refuse to act when
    // ABC-27's objects are absent — and it must equally NOT refuse on the real chain, or the
    // migration is a fail-open that reports itself applied over nothing.
    const post = lineage().filter((f) => f > ABC27);
    expect(post.length, 'there is at least one post-ABC-27 migration to check').toBeGreaterThan(0);
    // TWO DIFFERENT STRIPS, because the two halves of this check need different things.
    //
    // `uncommented` blanks comments and KEEPS literals: the guard anchors below ARE literals
    // (`to_regclass('public.rebook_rounds')`, `a.attname = 'transport_state'`), so erasing literals
    // would erase the very thing being looked for — while reading the RAW file would let a file
    // satisfy the anchors from a COMMENT and guard nothing.
    //
    // `executable` blanks both, and is used only for the negative assertion, where a mention inside
    // a comment or a message string is harmless and a mention in code is not.
    //
    // Both share ONE leftmost-first alternation. A comments-first sweep destroys any literal that
    // contains `--` — and the retirement migration ships exactly such a literal — leaving an
    // unterminated quote that desynchronises every literal after it.
    const uncommented = strip;
    const executable = (sql: string) =>
      sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ');
    for (const file of post) {
      const sql = migrationSql(file);
      const code = uncommented(sql);
      expect(code, `${file}: must guard on the ABC-27 authority relation`)
        .toContain("to_regclass('public.rebook_rounds')");
      expect(code, `${file}: must guard on the column ONLY ABC-27 creates`)
        .toContain("a.attname = 'transport_state'");
      // AND IT MUST ASK `pg_catalog`, NOT `information_schema`. Those views are PRIVILEGE-FILTERED:
      // they show a column only to a role that owns the relation or holds a privilege on it. A
      // deployment role able to assume the Domain-P owner but holding nothing on the Domain-N
      // `notification_outbox` would read the column as ABSENT, take the skip, and let the migration
      // be recorded as applied over nothing — a fail-open that no amount of replaying as a
      // superuser can reveal, because a superuser always sees the column.
      expect(code, `${file}: the guard must not depend on the applying role's privileges`)
        .toContain('pg_catalog.pg_attribute');
      // CASE-INSENSITIVELY, because `INFORMATION_SCHEMA.COLUMNS` folds to the same privilege-
      // filtered view that `information_schema.columns` names, and a lower-case-only negative
      // check reads the upper-case spelling as absent.
      expect(executable(sql), `${file}: information_schema is privilege-filtered and must not gate a guard`)
        .not.toMatch(/information_schema/i);
      // THE GUARD HAS TO BE IN EVERY EXECUTABLE BLOCK, not just the first, and the check is now
      // per-block rather than a count comparison: one guarded block plus one unguarded one
      // satisfied `guards >= blocks` while the unguarded half raised on the inverted replay.
      //
      // ANY dollar-quote tag, INCLUDING THE BARE `$$`. The paid-group closure names its block
      // `$d7_paid_group_hold$`, and a `$do$`-only count read it as ZERO blocks; a tagged-only
      // pattern would equally miss a perfectly valid `DO $$ … $$`.
      const starts = [...code.matchAll(/^[ \t]*DO\s+\$[A-Za-z_][A-Za-z0-9_]*\$|^[ \t]*DO\s+\$\$/gm)]
        .map((m) => m.index ?? 0);
      expect(starts.length, `${file}: the scan must find its DO blocks`).toBeGreaterThan(0);
      starts.forEach((from, i) => {
        const body = code.slice(from, starts[i + 1] ?? code.length);
        expect(body, `${file}: DO block ${i + 1} of ${starts.length} carries no prerequisite guard`)
          .toContain("to_regclass('public.rebook_rounds')");
      });
      // …and nothing executable may sit OUTSIDE a guarded block. Everything before the first `DO`
      // is prologue, and it must be prose and nothing else — an unguarded statement there runs on
      // the inverted replay however well guarded the blocks below it are.
      const prologue = executable(code.slice(0, starts[0]));
      expect(prologue.replace(/\s+/g, ''), `${file}: executable text precedes the first guarded block`)
        .toBe('');
    }
    // AND IT DOES NOT FIRE HERE. `main` replayed the whole directory in filename order; if the
    // guard had skipped, none of these would exist.
    const { rows } = await main.query(`
      SELECT to_regclass('public.idx_notification_outbox_d7_member_open_claim')::text AS idx,
             to_regprocedure('public.claim_rebook_member_open_notice(uuid)')::text     AS shim`);
    expect(rows[0].idx, 'the guard did not fire: the index exists on the real chain').not.toBeNull();
    expect(rows[0].shim, 'the guard did not fire: the drops happened on the real chain').toBeNull();
    // …and the paid-group closure's guard did not fire either: its replacement really happened.
    const { rows: elig } = await main.query(`
      SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])')`);
    // COMMENTS STRIPPED, LITERALS KEPT: a body that merely MENTIONS the hold in a comment would
    // satisfy a raw `LIKE`, and this assertion is what proves the guard did not silently skip.
    expect(strip(elig[0].prosrc as string),
      'the guard did not fire: the eligibility authority carries the booking-anchored hold')
      .toContain('hb.paid_by_player_id IS NOT NULL OR hb.paid_by_guest_player_id IS NOT NULL');
  });

  it('the paid-group closure replaces the authority and moves NOTHING else about it', async () => {
    // The migration asserts all of this in its own transaction; this is the independent reading,
    // taken from the catalog of a database that replayed the whole directory in filename order.
    const probe = `
      SELECT p.oid::text                                    AS oid,
             p.proowner::regrole::name                      AS owner,
             coalesce(p.proacl::text, '<default>')          AS acl,
             p.prosecdef                                    AS secdef,
             p.provolatile                                  AS volatility,
             coalesce(p.proconfig::text, '<none>')          AS config,
             pg_get_function_identity_arguments(p.oid)      AS args,
             pg_get_function_result(p.oid)                  AS result
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])')`;
    const before = (await pre.query(probe)).rows[0];
    const after = (await main.query(probe)).rows[0];
    expect(before, 'ABC-27 must have installed the authority before the closure replaces it')
      .toBeTruthy();
    // `oid` IS IN THIS LIST, AND IT IS THE ONE THAT CANNOT BE FAKED. `pre` and `main` are both
    // TEMPLATE clones of the SAME replayed template, so ABC-27's function carries an identical OID
    // in each. `CREATE OR REPLACE` preserves that OID; a DROP-and-recreate — which would silently
    // reset the ACL to the schema default and re-run every default-privilege rule — cannot. The
    // migration's own internal post-conditions run BEFORE its transaction ends, so a later
    // statement in the same file could satisfy them and then drop and recreate; this reading is
    // taken from outside, after the whole directory applied, and sees that.
    for (const field of ['oid', 'owner', 'acl', 'secdef', 'volatility', 'config', 'args', 'result']) {
      expect(after[field], `${field} must be untouched by the replacement`).toEqual(before[field]);
    }
    // The exact shipped ACL, spelled out: non-grantable EXECUTE to the Domain-A owner and the
    // Domain-P owner, and NOTHING for anon, authenticated or service_role.
    expect(after.acl).toContain('padeltrainer_abc27_owner=X/');
    for (const role of ['anon=', 'authenticated=', 'service_role=']) {
      expect(after.acl, `${role} must hold nothing on the eligibility authority`).not.toContain(role);
    }
    expect(after.secdef).toBe(true);
    expect(after.volatility, 'STABLE').toBe('s');
    expect(after.config).toContain('search_path=public');
    // …and the BODY did change, in exactly the one way the closure is for.
    const bodies = async (c: pg.Client) => {
      const src = strip((await c.query(`
        SELECT p.prosrc FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])')`)
      ).rows[0].prosrc as string);
      return {
        // The booking-anchored hold this release installs…
        hold: src.includes('hb.paid_by_player_id IS NOT NULL OR hb.paid_by_guest_player_id IS NOT NULL'),
        // …the claim/invoice anchor it REPLACES, which must be gone rather than sitting beside it…
        claimAnchor: src.includes('hi.rebook_group_id = hspc.rebook_group_id'),
        // …and the frozen cycle-wide upfront rule, retained throughout.
        upfront: src.includes('rebook_payment_mode'),
      };
    };
    expect(await bodies(pre), 'CONTROL — ABC-27 alone carries the cycle rule and neither slot hold')
      .toEqual({ hold: false, claimAnchor: false, upfront: true });
    expect(await bodies(main),
      'after the composed closures: the BOOKING anchor is live, the claim anchor is GONE, upfront RETAINED')
      .toEqual({ hold: true, claimAnchor: false, upfront: true });
  });

  it('CONTROL — after the cron half but before the schema half, the schema changes are absent', async () => {
    const { rows } = await pre.query(`
      SELECT to_regclass('public.idx_notification_outbox_d7_member_open_claim')::text AS idx,
             to_regprocedure('public.claim_rebook_member_open_notice(uuid)')::text     AS shim,
             (SELECT count(*)::int FROM cron.job WHERE jobname = 'notify-rebook-member-open') AS legacy_job,
             (SELECT count(*)::int FROM cron.job
               WHERE jobname IN ('rebook-member-open-worker','rebook-round-materializer','rebook-member-open-janitor')) AS d7_jobs`);
    expect(rows[0].idx, 'the claim index must not exist before the retirement migration').toBeNull();
    expect(rows[0].shim, 'the shims must still exist before the retirement migration').not.toBeNull();
    // The cron half has ALREADY run at this point — that is the whole point of it sorting earlier.
    expect(rows[0].legacy_job, 'the legacy cron is retired before ABC-27 lands').toBe(0);
    expect(rows[0].d7_jobs, 'and the three D7 jobs are installed before ABC-27 lands').toBe(3);
  });

  it('CONTROL — with the cron migration OMITTED, the legacy job survives and no D7 job exists', async () => {
    // The counterfactual replay. Without it, every cron assertion below could be describing a
    // lineage that already had those jobs for some other reason.
    const { rows } = await noCron.query(`
      SELECT (SELECT count(*)::int FROM cron.job WHERE jobname = 'notify-rebook-member-open') AS legacy_job,
             (SELECT count(*)::int FROM cron.job
               WHERE jobname IN ('rebook-member-open-worker','rebook-round-materializer','rebook-member-open-janitor')) AS d7_jobs,
             (SELECT count(*)::int FROM cron.job WHERE jobname = 'auto-rebook-reminder') AS sibling`);
    expect(rows[0].legacy_job, 'the legacy job is scheduled by the historical vault migration').toBe(1);
    expect(rows[0].d7_jobs, 'and nothing else installs the D7 jobs').toBe(0);
    expect(rows[0].sibling, 'its sibling is scheduled by the same historical DO block').toBe(1);
  });
});

// ── E-11: the prerequisite guard is not silently skipping ────────────────────────────────────

// ── THE INSTALLED-CATALOG AUTHORITY ──────────────────────────────────────────────────────────
//
// THIS BLOCK IS THE COMPOSITION PROOF. It replaces the source-text pins that used to carry it —
// a `CREATE OR REPLACE FUNCTION public.<name>(` regex, a `GRANT|REVOKE|ALTER FUNCTION` statement
// sweep, and a scan of the string literals a comment-stripper had erased. Each of those was a
// hand-written parser for a language with more spellings than a denylist can hold, and each was
// demonstrably out-spellable: `CREATE PROCEDURE` at the protected name, the `U&"…\005F…"` Unicode
// escape form, and a `format('CREATE FUNCTION public.%I…', '<name>', …)` that puts the verb and the
// name in different literals all sailed through.
//
// Nothing here reads a migration. `pre` is the lineage up to and including ABC-27; `main` is the
// whole directory in true filename order. Whatever spelling a post-ABC-27 file used, the server
// resolved it into `pg_proc` rows — and a diff of those rows cannot be out-spelled.
describe('CATALOG AUTHORITY — what the post-ABC-27 files did, read from the catalog they produced', () => {
  /** The four §10a member-open shims, keyed exactly as the catalog spells their identity. */
  const RETIRED_KEYS = [
    // The 8-argument issuing authority, superseded by the 9-argument one below. This is the ONLY
    // signature this release retires, and it is retired rather than overloaded because a defaulted
    // subject domain is exactly the implicit subject the transport model exists to forbid.
    'public.abc27_a_authorize_transition(p_purpose text, p_academy uuid, p_round uuid, p_member uuid, p_outbox uuid, p_action text, p_from text, p_to text)',
    'public.abc27_a_consume_transition_grant(p_grant uuid, p_action text, p_outbox uuid, p_member uuid, p_academy uuid, p_round uuid, p_old_state text, p_new_state text)',
    'public.append_rebook_member_open_notified(_cycle_id uuid, _keys text[])',
    'public.claim_rebook_member_open_notice(_cycle_id uuid)',
    // The 18-argument entrypoint, superseded by the 19-argument one. Dropped rather than left as
    // an overload: with the new tail defaulted, every existing 18-argument call would be
    // ambiguous between the two. ABC-27 retired the previous signature here the same way.
    'public.enqueue_notification(p_event_key text, p_recipient_person_id uuid, p_recipient_user_id uuid, p_recipient_guest_player_id uuid, p_tenant_academy_profile_id uuid, p_tenant_trainer_id uuid, p_idempotency_subject text, p_related_booking_ids uuid[], p_related_invoice_id uuid, p_related_payment_id text, p_template_key text, p_payload jsonb, p_public_summary jsonb, p_scheduled_for timestamp with time zone, p_occurred_at timestamp with time zone, p_related_rebook_round_id uuid, p_related_rebook_round_recipient_id uuid, p_terminal_skip_reason text)',
    'public.rebook_cycles_needing_member_open_notice()',
    'public.unclaim_rebook_member_open_notice(_cycle_id uuid)',
  ];
  /** The two ABC-27 bodies this release is authorised to replace, same keying. */
  const REPLACED_KEYS = [
    // EVERY ROUTINE THIS RELEASE REPLACES IN PLACE, in the order the probe returns them — this list
    // is compared with `toEqual`, so its SORT is part of the assertion and not a formatting choice.
    //
    // Three groups. `abc27_p_live_eligibility`, both normalized cores and `begin_dispatch` are the
    // earlier D7 files re-issuing behaviour.
    //
    // The four `abc27_a_*` grant routines are the subject generalization: each now reads the renamed
    // `subject_uuid` and, on the two consumption paths, matches the operation target's domain against
    // the GRANT's own domain, so a grant and its target must agree rather than each being checked
    // against a literal.
    //
    // The rest are the canonical-outbox generalization: each one's event-type test moved from a
    // single literal to the closed protected SET, so ONE transport machine serves a second event
    // type. A catalog diff cannot show that the member-open behaviour is unchanged — the delta test
    // below reads those bodies line by line for that.
    //
    // `close_unresolved` is DELIBERATELY ABSENT. The superseded widening file included it; it writes
    // a `rebook_round_recipient_decisions` row on both arms, and that table's composite FK to
    // `rebook_round_recipients` makes every path through it unreachable for an invitation. It stays
    // member-open, and an unresolved invitation waits for an operator instead.
    'public.abc27_a_consume_delete_grant(p_grant uuid, p_outbox uuid, p_member uuid, p_academy uuid, p_round uuid, p_old_state text)',
    'public.abc27_a_issue_delete_pair(p_academy uuid, p_round uuid, p_member uuid, p_outbox uuid, p_old_state text, p_outcome text, p_at timestamp with time zone)',
    'public.abc27_a_validate_arm_stamp(p_arm_grant uuid, p_del_grant uuid, p_outbox uuid, p_member uuid, p_old_state text)',
    'public.abc27_p_live_eligibility(p_academy uuid, p_round uuid, p_recipient uuid[], p_cycle uuid[], p_key text[], p_claim uuid[])',
    'public.claim_notification_outbox_batch(p_channel text, p_worker text, p_limit integer, p_stale_after_minutes integer)',
    'public.guard_notification_event_type_authority()',
    // The unconditional outbox authority, split along the subject: its UPDATE and DELETE arms now
    // consult the protected vocabulary, and both grant consumption paths name the row's subject
    // rather than its snapshot recipient. Its member-open INSERT validation is untouched.
    'public.notification_outbox_round_ref_guard()',
    'public.rebook_member_open_begin_dispatch(p_outbox_id uuid, p_worker_token text, p_lease_generation integer, p_request_hash bytea, p_canonical_request_bytes text, p_provider_idempotency_key text, p_leased_from_state text)',
    'public.rebook_member_open_claim_batch(p_worker text, p_limit integer)',
    'public.rebook_member_open_close_unresolved(p_limit integer)',
    'public.rebook_member_open_dispatch_status(p_outbox_id uuid)',
    'public.rebook_member_open_dispatch_status_by_capability(p_outbox_id uuid, p_lease_generation integer, p_request_hash bytea, p_provider_idempotency_key text)',
    'public.rebook_member_open_pre_dispatch_resolve(p_outbox_id uuid, p_worker_token text, p_lease_generation integer)',
    'public.rebook_member_open_record_dispatch_outcome(p_outbox_id uuid, p_worker_token text, p_lease_generation integer, p_request_hash bytea, p_http_status integer, p_provider_error_code text, p_provider_message_id text, p_transport_fault text, p_structurally_valid boolean)',
    'public.rebook_member_open_recover_expired_leases(p_limit integer, p_stale_after_minutes integer)',
    'public.rebook_round_apply_normalized_core(p_actor uuid, p_academy uuid, p_contract_version text, p_command_kind text, p_command_id uuid, p_round_id uuid, p_expected_version integer, p_label text, p_target_start date, p_target_end date, p_term_weeks integer, p_priority_days integer, p_member_days integer, p_payment_mode text, p_strict_mollie boolean, p_public_open_mode text, p_public_open_split boolean, p_require_admin_review boolean, p_session_price numeric, p_auto_reminder boolean, p_reminder_lead_hours integer, p_invitation_subject text, p_invitation_body text, p_reminder_subject text, p_reminder_body text, p_rebook_rules text, p_claim_info text, p_holiday_from date[], p_holiday_to date[], p_holiday_label text[], p_source_slot_ids uuid[], p_child_cycle_ids uuid[], p_target_slot_ids uuid[], p_review_fingerprint bytea)',
    'public.rebook_round_preview_normalized_core(p_actor uuid, p_academy uuid, p_contract_version text, p_command_kind text, p_round_id uuid, p_expected_version integer, p_label text, p_target_start date, p_target_end date, p_term_weeks integer, p_priority_days integer, p_member_days integer, p_payment_mode text, p_strict_mollie boolean, p_public_open_mode text, p_public_open_split boolean, p_require_admin_review boolean, p_session_price numeric, p_auto_reminder boolean, p_reminder_lead_hours integer, p_invitation_subject text, p_invitation_body text, p_reminder_subject text, p_reminder_body text, p_rebook_rules text, p_claim_info text, p_holiday_from date[], p_holiday_to date[], p_holiday_label text[], p_source_slot_ids uuid[], p_child_cycle_ids uuid[], p_target_slot_ids uuid[])',
    'public.release_notification_claims_on_kill(p_channel text, p_worker text)',
  ];
  /** The two objects this release is authorised to create. */
  const NEW_INDEX = 'public.idx_notification_outbox_d7_member_open_claim';
  /**
   * The invitation's own claim lookup. The cross-tenant uniqueness check runs once per invitation
   * and the column had no index, so a large round against a mature outbox could scan the table N
   * times and exhaust the edge's budget before enqueueing anything. PARTIAL, because only
   * invitations carry the column at all.
   */
  const INVITE_INDEX = 'public.idx_notification_outbox_d7_invite_claim';
  /** The one-live-grant key, dropped and re-added so the subject domain joins it. */
  const RESHAPED_KEY = 'public.uq_rrtt_live_transition';
  /**
   * THE SUBJECT COLUMNS. `subject_uuid` is a RENAME of `rebook_round_recipient_id`, which a catalog
   * diff can only show as a removal plus an addition — the migration asserts the rename moved no
   * data, and the compatibility test proves an existing member-open row still transitions.
   */
  const NEW_COLUMNS = [
    'public.notification_outbox.related_slot_priority_claim_id',
    'public.rebook_round_transport_transitions.subject_domain',
    'public.rebook_round_transport_transitions.subject_uuid',
  ];
  const RENAMED_AWAY = ['public.rebook_round_transport_transitions.rebook_round_recipient_id'];
  const NEW_CONSTRAINTS = [
    'public.notification_outbox.chk_notification_outbox_priority_claim_invite_shape',
    'public.notification_outbox.chk_notification_outbox_transport_subject_exclusive',
    'public.rebook_round_transport_transitions.chk_rrtt_subject_domain',
    // PG17+ gives every NOT NULL its own `pg_constraint` row, so `ADD COLUMN ... NOT NULL` shows up
    // in this catalog under a server-generated name. It is listed rather than filtered out: a probe
    // that quietly ignored `%_not_null` would also ignore one being DROPPED.
    'public.rebook_round_transport_transitions.rebook_round_transport_transitions_subject_domain_not_null',
  ];
  const RESHAPED_CONSTRAINTS = [
    // The two constraints that scoped transport to a single event type. Widened to the protected
    // SET so an invitation may carry transport state at all, and may present a transition action —
    // without which it would have been created and then refused every dispatch it attempted.
    'public.notification_outbox.chk_notification_outbox_transition_action',
    'public.notification_outbox.chk_notification_outbox_transport_scope',
    'public.rebook_round_operation_targets.chk_rrot_domain_matches_kind',
    'public.rebook_round_operation_targets.chk_rrot_kind',
    // RENAMING A COLUMN DOES NOT RENAME ITS NOT NULL CONSTRAINT. PostgreSQL keeps the name minted
    // when the column was first declared, so this one still says `rebook_round_recipient_id` while
    // its definition now reads `subject_uuid IS NOT NULL` — a CHANGE under an unchanged key, which
    // is why it appears here and not in `NEW_CONSTRAINTS`.
    'public.rebook_round_transport_transitions.rebook_round_transport_trans_rebook_round_recipient_id_not_null',
    'public.rebook_round_transport_transitions.uq_rrtt_live_transition',
  ];
  /**
   * EVERY ROUTINE THIS RELEASE ADDS, NAMED — because the value of `added` being an exact list is
   * that a TWENTY-FIRST would fail. They fall into four groups, and the grouping is the design:
   *
   *   • TWO ACTOR SURFACES (`rebook_round_selection_*_as_actor`), granted to `authenticated` and
   *     to nothing else. ABC-27 pins five operator wrappers; these deliberately make seven.
   *   • THE DOMAIN-P BRIDGES (`d7_p_*`), granted to the Domain-A owner alone. Everything that
   *     reads a product relation is here, because an A-owned body reading `public.cycles` dies on
   *     that table's RLS policy — measured, and recorded in the migration header.
   *   • THE PURE RENDERERS (`d7_series_label`, `d7_name_*`, `d7_child_target_names`), which are
   *     the legacy naming chain and touch nothing.
   *   • ONE A-OWNED COUNTER (`d7_series_session_count`), which wraps the A vocabulary Domain P
   *     cannot execute.
   */
  const NEW_ROUTINES = [
    // The re-created issuing authority. Its ninth argument is required and undefaulted, so every
    // caller must state the subject domain it derived from the outbox row.
    'public.abc27_a_authorize_transition(p_purpose text, p_academy uuid, p_round uuid, p_member uuid, p_subject_domain text, p_outbox uuid, p_action text, p_from text, p_to text)',
    // The Domain-A reader that answers which round a claim was captured for. Granted to Domain N
    // alone — the same shape ABC-27 uses for every A fact its N-owned writers need. It exists
    // because three live callers invite a claim without naming a round, and the relation that knows
    // is A-owned and absent from the generated Supabase types, so the edge cannot read it.
    'public.abc27_a_claim_round(p_academy uuid, p_claim uuid)',
    'public.abc27_a_consume_transition_grant(p_grant uuid, p_action text, p_outbox uuid, p_member uuid, p_academy uuid, p_round uuid, p_old_state text, p_new_state text, p_row_domain text)',
    // The round resolver. A supplied round is accepted only when it AGREES with the round that
    // captured this claim, and — when the claim has no capture record — only when it is
    // genuinely this academy's round. Review round 1 found the previous `coalesce` trusted a
    // supplied round completely, so academy A could attribute an invitation to academy B's round.
    'public.abc27_a_resolve_invite_round(p_academy uuid, p_claim uuid, p_round uuid)',
    'public.d7_child_cycle_id(p_round uuid, p_series_key text)',
    'public.d7_child_target_names(p_label text, p_keys text[], p_weekday integer[], p_time time without time zone[], p_trainer text[], p_location text[], p_taken text[])',
    'public.d7_name_colliding(p_counts jsonb, p_name text, p_taken text[])',
    'public.d7_name_counts(p_names text[])',
    'public.d7_p_academy_timezone(p_academy uuid)',
    'public.d7_p_cohort_candidates(p_academy uuid, p_location_ids uuid[], p_term_end date)',
    'public.d7_p_cyclus_candidates(p_academy uuid, p_source_cycle uuid)',
    'public.d7_p_display_names(p_trainer_ids uuid[], p_location_ids uuid[])',
    'public.d7_p_first_names(p_trainer_ids uuid[])',
    // ── The canonical outbox transport generalization ──
    //
    // THREE new routines and no more. Everything else that batch touched is a RE-ISSUE of a name
    // that already existed, which is why they do not appear here — and why this list is the thing
    // that would catch a fourth arriving unannounced.
    // The routing bridge. It answers WHERE a claim routes (the shipped guest-then-profile rule);
    // the snapshot bridge beside it answers WHO the claim's person is. Two questions.
    'public.d7_p_invite_contact(p_academy uuid, p_claim uuid)',
    // The sealed offer contract. Every fact the invitation asserts is enumerated here once, and the
    // digest is computed over ALL of it — so a future fact either enters the digest or is not part
    // of the offer. Five review rounds each found one more fact that dispatch had not re-read.
    'public.d7_p_invite_offer(p_academy uuid, p_claim uuid)',
    'public.d7_p_invite_recipient_snapshot(p_academy uuid, p_claim uuid)',
    'public.d7_p_invite_round_claims(p_academy uuid, p_cyclus uuid, p_limit integer)',
    'public.d7_p_location_names(p_location_ids uuid[])',
    'public.d7_p_round_label(p_academy uuid, p_round uuid)',
    'public.d7_p_round_taken_names(p_academy uuid, p_round uuid, p_start date)',
    'public.d7_p_selection_digest(p_academy uuid, p_candidates uuid[], p_mode text, p_term_end date, p_round uuid, p_round_label text, p_excluded_keys text[], p_target_start date, p_round_version integer)',
    'public.d7_p_series_cluster(p_academy uuid, p_candidates uuid[], p_mode text, p_term_end date, p_round uuid, p_round_label text, p_excluded_keys text[])',
    'public.d7_p_subject_display(p_academy uuid, p_slot_ids uuid[])',
    'public.d7_p_taken_names(p_academy uuid, p_round uuid, p_start date)',
    'public.d7_series_label(p_weekday integer, p_time time without time zone)',
    'public.d7_series_session_count(p_zone text, p_start date, p_weekday integer, p_time time without time zone, p_minutes integer, p_weeks integer, p_end date, p_holiday_from date[], p_holiday_to date[])',
    'public.d7_trim_ws(p_text text)',
    // The protected-event vocabulary sorts here, among the `rebook_` names rather than the `d7_`
    // ones — this list is compared with `toEqual`, so its ORDER is part of the assertion.
    // Sorts here, after every `d7_` name and before the `rebook_` ones.
    'public.enqueue_notification(p_event_key text, p_recipient_person_id uuid, p_recipient_user_id uuid, p_recipient_guest_player_id uuid, p_tenant_academy_profile_id uuid, p_tenant_trainer_id uuid, p_idempotency_subject text, p_related_booking_ids uuid[], p_related_invoice_id uuid, p_related_payment_id text, p_template_key text, p_payload jsonb, p_public_summary jsonb, p_scheduled_for timestamp with time zone, p_occurred_at timestamp with time zone, p_related_rebook_round_id uuid, p_related_rebook_round_recipient_id uuid, p_terminal_skip_reason text, p_related_slot_priority_claim_id uuid)',
    // The private invitation enqueue core — Domain N, and revoked from `service_role` exactly as
    // `rebook_member_open_enqueue_core` is. It is a writer, not an entrypoint.
    'public.rebook_priority_claim_invite_enqueue_core(p_academy uuid, p_claim uuid, p_round uuid, p_occurred_at timestamp with time zone, p_payload jsonb, p_user uuid, p_guest uuid, p_person uuid)',
    // The ONE typed verdict. `pre_dispatch_resolve`, `begin_dispatch` and `recover_expired_leases`
    // all ask it; none carries its own copy of the gates any more, which is what made three rounds
    // of fixes reach one call site at a time.
    'public.rebook_priority_claim_invite_verdict(p_outbox uuid)',
    'public.rebook_round_protected_event_types()',
    'public.rebook_round_selection_apply_as_actor(p_academy_profile_id uuid, p_command_id uuid, p_contract_version text, p_command_kind text, p_selection_mode text, p_source_cycle_id uuid, p_location_ids uuid[], p_term_end date, p_excluded_series_keys text[], p_selection_digest bytea, p_round_id uuid, p_expected_version integer, p_label text, p_target_start date, p_target_end date, p_term_weeks integer, p_priority_days integer, p_member_days integer, p_payment_mode text, p_strict_mollie boolean, p_public_open_mode text, p_public_open_split boolean, p_require_admin_review boolean, p_session_price numeric, p_auto_reminder boolean, p_reminder_lead_hours integer, p_invitation_subject text, p_invitation_body text, p_reminder_subject text, p_reminder_body text, p_rebook_rules text, p_claim_info text, p_holiday_from date[], p_holiday_to date[], p_holiday_label text[], p_target_slot_ids uuid[], p_review_fingerprint bytea)',
    'public.rebook_round_selection_preview_as_actor(p_academy_profile_id uuid, p_contract_version text, p_command_kind text, p_selection_mode text, p_projection text, p_source_cycle_id uuid, p_location_ids uuid[], p_term_end date, p_excluded_series_keys text[], p_selection_digest bytea, p_round_id uuid, p_expected_version integer, p_label text, p_target_start date, p_target_end date, p_term_weeks integer, p_priority_days integer, p_member_days integer, p_payment_mode text, p_strict_mollie boolean, p_public_open_mode text, p_public_open_split boolean, p_require_admin_review boolean, p_session_price numeric, p_auto_reminder boolean, p_reminder_lead_hours integer, p_invitation_subject text, p_invitation_body text, p_reminder_subject text, p_reminder_body text, p_rebook_rules text, p_claim_info text, p_holiday_from date[], p_holiday_to date[], p_holiday_label text[], p_target_slot_ids uuid[])',
    // The closed transport-subject vocabulary. `_domains()` is the membership test the CHECK
    // constraint is sourced from; `_domain_for_event()` is the TOTAL map every entrypoint derives
    // its subject domain through, returning NULL — never a default — outside the protected set.
    'public.rebook_round_transport_subject_domain_for_event(p_event_type text)',
    'public.rebook_round_transport_subject_domains()',
  ];

  /**
   * EVERY probe, with the EXACT diff each one is allowed to show.  /**
   * EVERY probe, with the EXACT diff each one is allowed to show.
   *
   * The table is the proof. A probe with `{ added: [], removed: [], changed: [] }` is a statement
   * that the composed chain moved nothing at all in that catalog, and the three that are not empty
   * name precisely what this release is authorised to do — nothing is tolerated as "some change".
   */
  interface Expect { added: string[]; removed: string[]; changed: string[]; minSize: number }
  const PROBES: [string, string, Expect][] = [
    // Shape: owner, ACL (grantee/privilege/grant-option/grantor), prokind, language, result,
    // arguments INCLUDING defaults, SECURITY DEFINER, volatility, leakproof, STRICT, PARALLEL,
    // set-returning, cost, rows, support function and every `SET`. Across EVERY user schema, so
    // replacing `auth.uid()` is not invisible.
    ['routine shape', ROUTINE_SHAPE_PROBE,
      { added: NEW_ROUTINES, removed: RETIRED_KEYS, changed: [], minSize: 400 }],
    // Definition: the hash may differ for exactly the two authorised replacements and nothing else.
    ['routine definitions', ROUTINE_DEF_PROBE,
      { added: NEW_ROUTINES, removed: RETIRED_KEYS, changed: REPLACED_KEYS, minSize: 400 }],
    // EMPTY IS THE REAL ANSWER HERE, and it is asserted as one rather than passed over: this
    // lineage defines no aggregate in any user schema, which is why excluding aggregates from the
    // renderable-definition probes narrows nothing.
    ['aggregates', AGGREGATE_PROBE, { added: [], removed: [], changed: [], minSize: 0 }],
    // `uq_rrtt_live_transition` is DROPPED AND RE-ADDED, so its index gets a new OID — that is what
    // `changed` reports here. The owner's `FROZEN_SUITE` allowance covers exactly this pin and the
    // two `chk_rrot_` ones; nothing else in this table moves.
    ['relations', RELATION_PROBE, { added: [INVITE_INDEX, NEW_INDEX], removed: [], changed: [RESHAPED_KEY], minSize: 100 }],
    ['columns', COLUMN_PROBE, { added: NEW_COLUMNS, removed: RENAMED_AWAY, changed: [], minSize: 500 }],
    ['policies', POLICY_PROBE, { added: [], removed: [], changed: [], minSize: 50 }],
    ['triggers', TRIGGER_PROBE, { added: [], removed: [], changed: [], minSize: 20 }],
    ['indexes', INDEX_PROBE, { added: [INVITE_INDEX, NEW_INDEX], removed: [], changed: [RESHAPED_KEY], minSize: 100 }],
    // NO CONSTRAINT CHANGES, AND THAT IS A CORRECTION WORTH KEEPING.
    //
    // A draft widened `chk_net_trusted_payload_builder` so the invite could name its own trusted
    // payload builder. That had the column backwards: SETTING it means the server builds the
    // payload and a caller may not, and an invite is rendered by the sender that owns its template.
    // With the builder left NULL — as every caller-rendered event has it — the constraint needs no
    // change at all. The constraints that DO move here are the subject model's, and they are named
    // one by one below rather than tolerated as "some change".
    ['constraints', CONSTRAINT_PROBE, { added: NEW_CONSTRAINTS, removed: [], changed: RESHAPED_CONSTRAINTS, minSize: 100 }],
    ['views', VIEW_PROBE, { added: [], removed: [], changed: [], minSize: 1 }],
    ['schemas', SCHEMA_PROBE, { added: [], removed: [], changed: [], minSize: 2 }],
    ['rules', RULE_PROBE, { added: [], removed: [], changed: [], minSize: 1 }],
    ['sequences', SEQUENCE_PROBE, { added: [], removed: [], changed: [], minSize: 1 }],
    // THE SYSTEM CATALOG'S OWN ROUTINES. `begin_dispatch` calls `clock_timestamp()` and
    // `current_setting()` unqualified, and `pg_catalog` resolves implicitly first, so a
    // replacement there would change what its fences measure while every probe above stayed
    // green. Definitions only — ownership of the system catalog is PostgreSQL's business.
    ['system-schema routines', SYSTEM_ROUTINE_PROBE, { added: [], removed: [], changed: [], minSize: 1000 }],
    ['enum types', ENUM_PROBE, { added: [], removed: [], changed: [], minSize: 7 }],
    ['publications', PUBLICATION_PROBE, { added: [], removed: [], changed: [], minSize: 1 }],
    ['event triggers', EVENT_TRIGGER_PROBE, { added: [], removed: [], changed: [], minSize: 0 }],
    ['extensions', EXTENSION_PROBE, { added: [], removed: [], changed: [], minSize: 3 }],
    // ROLES AND DEFAULT PRIVILEGES ARE DELIBERATELY NOT IN THIS TABLE. Roles are CLUSTER-wide, not
    // per-database: `pre` and `main` live in the SAME cluster, so an `ALTER ROLE authenticated
    // BYPASSRLS` performed while applying the held-back files is visible from BOTH sides and the
    // diff is empty by construction — a probe that cannot fail. They are bracketed around the
    // actual apply instead, in the test below, which is the only shape that can see them.
  ];

  // WHAT IS DELIBERATELY NOT PROBED, AND WHY. Object COMMENTS (this release writes two on purpose),
  // SEQUENCE counters, and physical column metadata — storage, compression, statistics targets — are
  // documentation and physical tuning rather than behaviour or privilege. Everything that decides
  // WHO MAY DO WHAT, WHAT THE DATA MEANS, or WHETHER A ROW WAS WRITTEN is probed above.
  it('EVERY catalog this release could touch shows EXACTLY the authorised difference', async () => {
    for (const [label, sql, expected] of PROBES) {
      const b = await catalogObjects(pre, sql);
      const a = await catalogObjects(main, sql);
      // A probe that silently returned nothing would make its three equalities vacuously true, so
      // every one carries the population it must at least see. Where the real answer IS zero the
      // expectation is written as zero on BOTH sides — an asserted fact, not a silent pass.
      if (expected.minSize === 0) {
        expect([b.size, a.size], `${label}: this catalog is expected to be empty on both sides`)
          .toEqual([0, 0]);
      } else {
        expect(b.size, `${label}: the ABC-27 population must be real`)
          .toBeGreaterThanOrEqual(expected.minSize);
      }
      const d = diffObjects(b, a);
      if (process.env.D7_DUMP_ADDED && JSON.stringify(d.added) !== JSON.stringify(expected.added)) {
        process.stdout.write(`ADDED ${label} ${JSON.stringify(d.added)}\n`);
      }
      expect(d.added, `${label}: something unlisted was created`).toEqual(expected.added);
      expect(d.removed, `${label}: something was removed`).toEqual(expected.removed);
      expect(d.changed, `${label}: something changed in place — ${d.detail.join(' | ')}`)
        .toEqual(expected.changed);
    }
  }, 300_000);

  it('the retired and replaced keys really existed to be retired and replaced', async () => {
    const shape = await catalogObjects(pre, ROUTINE_SHAPE_PROBE);
    for (const k of [...RETIRED_KEYS, ...REPLACED_KEYS]) {
      expect([...shape.keys()], `${k} must exist in ABC-27`).toContain(k);
    }
    // …and the two replacements SURVIVE, which is what makes "changed" mean replaced rather than
    // dropped and recreated under the same name.
    const after = await catalogObjects(main, ROUTINE_SHAPE_PROBE);
    for (const k of REPLACED_KEYS) expect([...after.keys()], `${k} must survive`).toContain(k);
    for (const k of RETIRED_KEYS) expect([...after.keys()], `${k} must be gone`).not.toContain(k);
  }, 120_000);

  /**
   * EVERY DDL ACTION THE THREE POST-ABC-27 FILES PERFORM, IN EXECUTION ORDER.
   *
   * This is the strongest statement in the file, and it is the one an endpoint diff cannot make:
   * not "no unexpected difference remains" but "these nine statements ran and nothing else did".
   * A migration that dropped a unique index, wrote duplicates and recreated it would leave an
   * identical final catalog and appear here as three extra lines.
   *
   * Read left to right it is also the release, described: the claim index and its comment, the four
   * §10a shim retirements, the `cycles.settings` residue comment, and the two authorised body
   * replacements — one for the paid-group hold, one for the dispatch linearization.
   */
  const EXPECTED_DDL: string[] = [
    // `20261118115000` + `20261203110000`: the claim index, then the four §10a shim drops.
    "CREATE INDEX public.idx_notification_outbox_d7_member_open_claim",
    "COMMENT public.idx_notification_outbox_d7_member_open_claim",
    "DROP function public.claim_rebook_member_open_notice(pg_catalog.uuid)",
    "DROP function public.unclaim_rebook_member_open_notice(pg_catalog.uuid)",
    "DROP function public.append_rebook_member_open_notified(pg_catalog.uuid,pg_catalog.text[])",
    "DROP function public.rebook_cycles_needing_member_open_notice()",
    "COMMENT public.cycles.settings",
    // …and each authority is replaced a SECOND time by `20261203140000` / `20261203150000` — the
    // booking-anchored hold and the `after_cutoff` distinction. The census shows each replacement
    // twice because it happened twice; that is the point of recording ACTIONS, not end state.
    "CREATE FUNCTION public.abc27_p_live_eligibility(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.uuid[],pg_catalog.text[],pg_catalog.uuid[])",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_p_live_eligibility(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.uuid[],pg_catalog.text[],pg_catalog.uuid[])",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    // `20261203180000` — THE SELECTION AUTHORITY. Eleven routines created, transferred to the
    // product owner, revoked from PUBLIC and all three runtime roles, then granted to the
    // Domain-A owner. `REVOKE`/`GRANT` render without an object identity, which is why they read
    // `<none>`: the census proves HOW MANY privilege statements ran and in what order, while
    // WHICH grantee each names is proved by the ACL half of the routine-shape probe.
    "CREATE FUNCTION public.d7_series_label(integer,time without time zone)",
    "CREATE FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "CREATE FUNCTION public.d7_name_counts(pg_catalog.text[])",
    "CREATE FUNCTION public.d7_name_colliding(pg_catalog.jsonb,pg_catalog.text,pg_catalog.text[])",
    "CREATE FUNCTION public.d7_p_academy_timezone(pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_cyclus_candidates(pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_cohort_candidates(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date)",
    "CREATE FUNCTION public.d7_p_display_names(pg_catalog.uuid[],pg_catalog.uuid[])",
    "CREATE FUNCTION public.d7_p_subject_display(pg_catalog.uuid,pg_catalog.uuid[])",
    "CREATE FUNCTION public.d7_p_round_taken_names(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.date)",
    "CREATE FUNCTION public.d7_p_round_label(pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_series_cluster(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[])",
    "CREATE FUNCTION public.d7_child_cycle_id(pg_catalog.uuid,pg_catalog.text)",
    "CREATE FUNCTION public.d7_p_selection_digest(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.date)",
    "ALTER FUNCTION public.d7_series_label(integer,time without time zone)",
    "ALTER FUNCTION public.d7_name_counts(pg_catalog.text[])",
    "ALTER FUNCTION public.d7_name_colliding(pg_catalog.jsonb,pg_catalog.text,pg_catalog.text[])",
    "ALTER FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "ALTER FUNCTION public.d7_p_academy_timezone(pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_cyclus_candidates(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_cohort_candidates(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date)",
    "ALTER FUNCTION public.d7_p_display_names(pg_catalog.uuid[],pg_catalog.uuid[])",
    "ALTER FUNCTION public.d7_p_subject_display(pg_catalog.uuid,pg_catalog.uuid[])",
    "ALTER FUNCTION public.d7_p_round_taken_names(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.date)",
    "ALTER FUNCTION public.d7_p_round_label(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_child_cycle_id(pg_catalog.uuid,pg_catalog.text)",
    "ALTER FUNCTION public.d7_p_selection_digest(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.date)",
    "ALTER FUNCTION public.d7_p_series_cluster(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[])",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    // `20261203190000` — the A-owned occurrence counter and the ONE actor preview surface.
    "CREATE FUNCTION public.d7_series_session_count(pg_catalog.text,pg_catalog.date,integer,time without time zone,integer,integer,pg_catalog.date,pg_catalog.date[],pg_catalog.date[])",
    "CREATE FUNCTION public.rebook_round_selection_preview_as_actor(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[])",
    "ALTER FUNCTION public.d7_series_session_count(pg_catalog.text,pg_catalog.date,integer,time without time zone,integer,integer,pg_catalog.date,pg_catalog.date[],pg_catalog.date[])",
    "REVOKE <none>",
    "ALTER FUNCTION public.rebook_round_selection_preview_as_actor(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[])",
    "REVOKE <none>",
    "GRANT <none>",
    // `20261203200000` — the three array-shaped name inputs, the four grants that let the A cores
    // reach the naming chain, and then BOTH normalized cores re-issued with it.
    "CREATE FUNCTION public.d7_p_first_names(pg_catalog.uuid[])",
    "CREATE FUNCTION public.d7_p_location_names(pg_catalog.uuid[])",
    "CREATE FUNCTION public.d7_p_taken_names(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.date)",
    "ALTER FUNCTION public.d7_p_first_names(pg_catalog.uuid[])",
    "ALTER FUNCTION public.d7_p_location_names(pg_catalog.uuid[])",
    "ALTER FUNCTION public.d7_p_taken_names(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.date)",
    "REVOKE <none>",
    "REVOKE <none>",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_round_preview_normalized_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.uuid[],pg_catalog.uuid[])",
    "CREATE FUNCTION public.rebook_round_apply_normalized_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.uuid[],pg_catalog.uuid[],pg_catalog.bytea)",
    // `20261203210000` — the apply mirror the client rule requires.
    "CREATE FUNCTION public.rebook_round_selection_apply_as_actor(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.bytea)",
    "ALTER FUNCTION public.rebook_round_selection_apply_as_actor(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.bytea)",
    "REVOKE <none>",
    "GRANT <none>",

    // ── D7 TERMINAL SEMANTICS CLOSURE (20261203220000, 20261203230000) ──
    //
    // Nineteen further actions. The naming chain is REPLACED in place (`CREATE OR REPLACE`, so no
    // DROP); the digest and both selection surfaces are DROPPED and recreated, because each gains
    // a parameter or a returned column and PostgreSQL will not replace either in place. Every drop
    // is paired with its recreation in the SAME transaction, and each recreation re-asserts the
    // ownership and the single grant the drop discarded.
    "CREATE FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "ALTER FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "REVOKE <none>",
    "GRANT <none>",
    "DROP function public.d7_p_selection_digest(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.date)",
    "CREATE FUNCTION public.d7_p_selection_digest(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.date,integer)",
    "ALTER FUNCTION public.d7_p_selection_digest(pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.text,pg_catalog.date,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.date,integer)",
    "REVOKE <none>",
    "GRANT <none>",
    "DROP function public.rebook_round_selection_preview_as_actor(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[])",
    "CREATE FUNCTION public.rebook_round_selection_preview_as_actor(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[])",
    "ALTER FUNCTION public.rebook_round_selection_preview_as_actor(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[])",
    "REVOKE <none>",
    "GRANT <none>",
    "DROP function public.rebook_round_selection_apply_as_actor(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.bytea)",
    "CREATE FUNCTION public.rebook_round_selection_apply_as_actor(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.bytea)",
    "ALTER FUNCTION public.rebook_round_selection_apply_as_actor(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid[],pg_catalog.date,pg_catalog.text[],pg_catalog.bytea,pg_catalog.uuid,integer,pg_catalog.text,pg_catalog.date,pg_catalog.date,integer,integer,integer,pg_catalog.text,boolean,pg_catalog.text,boolean,boolean,numeric,boolean,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.date[],pg_catalog.date[],pg_catalog.text[],pg_catalog.uuid[],pg_catalog.bytea)",
    "REVOKE <none>",
    "GRANT <none>",

    // ── THE CANONICAL OUTBOX TRANSPORT GENERALIZATION (20261203240000 … 20261203260000) ──
    //
    // Twenty-five further actions, and their shape is the design:
    //
    //   * ONE new vocabulary function, and TWO product bridges. Nothing else is created.
    //   * The trusted-payload-builder CHECK is dropped and re-added — a closed VOCABULARY gaining
    //     its second member, under the same constraint name ABC-27 asserts by name.
    //   * Everything else is a `CREATE FUNCTION` of a name that ALREADY EXISTED: eleven routines
    //     re-issued from the catalog with one substitution each. A re-issue looks identical to a
    //     creation here, which is exactly why the count and the names are pinned — a genuinely NEW
    //     routine would be indistinguishable otherwise.
    //   * NO new service-role entrypoint. The nine are re-issued, never added to.

    "CREATE FUNCTION public.rebook_round_protected_event_types()",
    "ALTER FUNCTION public.rebook_round_protected_event_types()",
    "REVOKE <none>",
    "CREATE FUNCTION public.claim_notification_outbox_batch(pg_catalog.text,pg_catalog.text,integer,integer)",
    "CREATE FUNCTION public.release_notification_claims_on_kill(pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.guard_notification_event_type_authority()",
    "CREATE FUNCTION public.d7_p_invite_recipient_snapshot(pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_invite_round_claims(pg_catalog.uuid,pg_catalog.uuid,integer)",
    "ALTER FUNCTION public.d7_p_invite_recipient_snapshot(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_invite_round_claims(pg_catalog.uuid,pg_catalog.uuid,integer)",
    "REVOKE <none>",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    // ── `20261203260000` + `20261203270000`: the closed transport subject ──────────────
    //
    // The subject model reshapes two authority tables and adds the invitation's own FK-free
    // subject column to the outbox, then the authority re-issues every routine that touches a
    // grant. The 8-argument `abc27_a_authorize_transition` is DROPPED and a 9-argument one
    // created: the census records both, which is exactly the evidence that the subject domain
    // became required rather than defaulted.
    //
    // Several routines appear more than once because each substitution re-issues the body it
    // targets, and a routine carrying three substitutions is re-issued three times. Recording
    // ACTIONS rather than end state is what makes that visible instead of collapsing it.
    // `rebook_member_open_close_unresolved` appears NOWHERE below — the one member-open routine
    // this release deliberately does not touch.
    "CREATE FUNCTION public.rebook_round_transport_subject_domains()",
    "CREATE FUNCTION public.rebook_round_transport_subject_domain_for_event(pg_catalog.text)",
    "ALTER FUNCTION public.rebook_round_transport_subject_domains()",
    "ALTER FUNCTION public.rebook_round_transport_subject_domain_for_event(pg_catalog.text)",
    "REVOKE <none>",
    "REVOKE <none>",
    "ALTER TABLE public.rebook_round_transport_transitions.subject_uuid",
    "ALTER TABLE public.rebook_round_transport_transitions",
    "DROP default value for public.rebook_round_transport_transitions.subject_domain",
    "ALTER TABLE public.rebook_round_transport_transitions",
    "ALTER TABLE public.rebook_round_transport_transitions",
    "DROP table constraint uq_rrtt_live_transition on public.rebook_round_transport_transitions",
    "DROP index public.uq_rrtt_live_transition",
    "ALTER TABLE public.rebook_round_transport_transitions",
    "ALTER TABLE public.rebook_round_transport_transitions",
    "DROP table constraint chk_rrot_kind on public.rebook_round_operation_targets",
    "ALTER TABLE public.rebook_round_operation_targets",
    "ALTER TABLE public.rebook_round_operation_targets",
    "DROP table constraint chk_rrot_domain_matches_kind on public.rebook_round_operation_targets",
    "ALTER TABLE public.rebook_round_operation_targets",
    "ALTER TABLE public.rebook_round_operation_targets",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "DROP function public.abc27_a_authorize_transition(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_authorize_transition(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "ALTER FUNCTION public.abc27_a_authorize_transition(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.abc27_a_consume_transition_grant(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_consume_transition_grant(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_consume_delete_grant(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_consume_delete_grant(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_validate_arm_stamp(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_issue_delete_pair(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,timestamp with time zone)",
    "CREATE FUNCTION public.abc27_a_issue_delete_pair(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,timestamp with time zone)",
    "CREATE FUNCTION public.abc27_a_issue_delete_pair(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,timestamp with time zone)",
    "CREATE FUNCTION public.rebook_member_open_claim_batch(pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_record_dispatch_outcome(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,boolean)",
    "CREATE FUNCTION public.rebook_member_open_recover_expired_leases(integer,integer)",
    "CREATE FUNCTION public.rebook_member_open_claim_batch(pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_record_dispatch_outcome(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,boolean)",
    "CREATE FUNCTION public.rebook_member_open_recover_expired_leases(integer,integer)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_close_unresolved(integer)",
    "CREATE FUNCTION public.rebook_member_open_claim_batch(pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_record_dispatch_outcome(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,boolean)",
    "CREATE FUNCTION public.rebook_member_open_record_dispatch_outcome(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,boolean)",
    "CREATE FUNCTION public.rebook_member_open_claim_batch(pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_record_dispatch_outcome(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,integer,pg_catalog.text,pg_catalog.text,pg_catalog.text,boolean)",
    "CREATE FUNCTION public.rebook_member_open_recover_expired_leases(integer,integer)",
    "CREATE FUNCTION public.rebook_member_open_dispatch_status(pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_member_open_dispatch_status_by_capability(pg_catalog.uuid,integer,pg_catalog.bytea,pg_catalog.text)",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "DROP table constraint chk_notification_outbox_transport_scope on public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "DROP table constraint chk_notification_outbox_transition_action on public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "ALTER TABLE public.notification_outbox",
    "CREATE FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.abc27_a_claim_round(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.abc27_a_claim_round(pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "DROP function public.enqueue_notification(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid[],pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,pg_catalog.jsonb,timestamp with time zone,timestamp with time zone,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)",
    "CREATE FUNCTION public.enqueue_notification(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid[],pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,pg_catalog.jsonb,timestamp with time zone,timestamp with time zone,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid)",
    "ALTER FUNCTION public.enqueue_notification(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid[],pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,pg_catalog.jsonb,timestamp with time zone,timestamp with time zone,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "CREATE FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "CREATE FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "ALTER FUNCTION public.d7_child_target_names(pg_catalog.text,pg_catalog.text[],integer[],time without time zone[],pg_catalog.text[],pg_catalog.text[],pg_catalog.text[])",
    "REVOKE <none>",
    "GRANT <none>",
    // ── `20261203310000`: review round 1's corrections ─────────────────────────────────
    // The round resolver, the consume path DROPPED and re-created with the row's own domain,
    // the guard re-issued to pass it, and the claimer/resolver/begin/core substitutions.
    "CREATE FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "DROP function public.abc27_a_consume_transition_grant(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.abc27_a_consume_transition_grant(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "ALTER FUNCTION public.abc27_a_consume_transition_grant(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "REVOKE <none>",
    "GRANT <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.notification_outbox_round_ref_guard()",
    "CREATE FUNCTION public.rebook_member_open_claim_batch(pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.abc27_a_consume_delete_grant(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)",
    // ── `20261203320000`: review round 2's corrections ─────────────────────────────────
    // The round resolver re-issued to read provenance for the CLAIM, and the two dispatch
    // re-reads taught to compare identity as well as status.
    "CREATE FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    // ── `20261203330000`: review round 3's corrections ─────────────────────────────────
    // The bridge dropped and re-created with the account and the slot, the enqueue re-issued
    // for the cross-tenant refusal and the stamped slot, and both dispatch re-reads widened.
    "DROP function public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    // ── `20261203340000`: review round 4's corrections ─────────────────────────────────
    // The invitation claim index, the bridge re-created with an offer fingerprint, the round
    // resolver's deterministic order, and the enqueue/resolver/begin re-issues.
    "CREATE INDEX public.idx_notification_outbox_d7_invite_claim",
    "DROP function public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_invite_contact(pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.abc27_a_resolve_invite_round(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.d7_trim_ws(pg_catalog.text)",
    "ALTER FUNCTION public.d7_trim_ws(pg_catalog.text)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.d7_p_invite_offer(pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.d7_p_invite_offer(pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
    "GRANT <none>",
    "CREATE FUNCTION public.rebook_priority_claim_invite_verdict(pg_catalog.uuid)",
    "ALTER FUNCTION public.rebook_priority_claim_invite_verdict(pg_catalog.uuid)",
    "REVOKE <none>",
    "CREATE FUNCTION public.rebook_member_open_pre_dispatch_resolve(pg_catalog.uuid,pg_catalog.text,integer)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_begin_dispatch(pg_catalog.uuid,pg_catalog.text,integer,pg_catalog.bytea,pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "CREATE FUNCTION public.rebook_member_open_recover_expired_leases(integer,integer)",
    "CREATE FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "ALTER FUNCTION public.rebook_priority_claim_invite_enqueue_core(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,timestamp with time zone,pg_catalog.jsonb,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)",
    "REVOKE <none>",
  ];

  it('THE POST-ABC-27 FILES WRITE NO ROW — a statement-level DML witness across the apply', async () => {
    // NO CATALOG DIFF CAN SEE A DELETE, and on a clean replay neither can a row count or a
    // statistics counter: the tables are empty, so `DELETE FROM public.notification_outbox` removes
    // nothing and leaves nothing behind. A STATEMENT-level trigger fires once per statement
    // whatever the row count — including zero — so it sees the statement rather than its effect.
    //
    // This runs on its own clone, armed BEFORE the held-back files are applied, so the witness
    // brackets exactly that apply and the mutation it performs is never compared by anything else.
    const probe = await chain.clone(`${PREFIX}_dmlwitness`);
    const armed = await armDmlWitness(probe);
    expect(armed, 'the witness must be armed on a real population of tables').toBeGreaterThan(50);
    const armedState = await catalogObjects(probe, `
      SELECT t.tgrelid::regclass::text AS key, t.tgenabled::text AS enabled
        FROM pg_catalog.pg_trigger t
       WHERE t.tgname = 'zzz_d7_dml_witness' AND NOT t.tgisinternal`);
    // CONTROL — the witness really does fire, including for a statement that touches NO row. This
    // is what makes the empty result below evidence instead of an untested apparatus.
    await probe.query(`DELETE FROM public.academy_profiles WHERE id = gen_random_uuid()`);
    expect(await readDmlWitness(probe), 'the witness sees a zero-row DELETE')
      .toEqual(['public.academy_profiles/DELETE x1']);
    await probe.query(`TRUNCATE public.d7_dml_witness`);
    // …and a DDL census, armed AFTER the DML witness so it does not record its own installation.
    // Endpoint catalog equality cannot distinguish "nothing happened" from "something happened and
    // was put back": disable a trigger, delete history, re-enable it, and every diff is green. The
    // census records the STATEMENTS, so the middle of the apply is visible too.
    await armDdlWitness(probe);

    // ── THE TIME-BRACKETED PROBES ──────────────────────────────────────────────────────────
    // Everything here is either CLUSTER-wide or otherwise invisible to a `pre` vs `main` diff, so
    // it is snapshotted immediately before and immediately after THIS apply and nothing else.
    const bracketed: [string, string, number][] = [
      ['default privileges', DEFAULT_ACL_PROBE, 3],
    ];
    const beforeShots = new Map<string, Map<string, string>>();
    for (const [label, sql] of bracketed) beforeShots.set(label, await catalogObjects(probe, sql));

    await chain.applyHeldBack(probe);

    // ── THE ONE PERMITTED WRITE, AND WHY IT IS EXACTLY ONE ────────────────────────────────
    //
    // This assertion was `toEqual([])`: post-ABC-27 migrations are DDL, and a file that writes a row
    // is a file doing something its reviewers did not sign up for. That is still the rule.
    //
    // `20261203240000` writes ONE row, and it cannot not: a protected event type is a row in
    // `notification_event_types`, the outbox's `event_type` is a foreign key to it, and ABC-27
    // itself inserts its own key the same way. The alternative to this row is no second event type,
    // which is the whole batch.
    //
    // So the allowance is a LIST, not a relaxation. One relation, one operation, one statement —
    // anything else, including a second write to this same table, still fails. A `toEqual` rather
    // than a `toContain` is what keeps it that way.
    expect(await readDmlWitness(probe),
      'a post-ABC-27 migration executed a data-modifying statement other than the reviewed event-type row')
      .toEqual(['public.notification_event_types/INSERT x1']);
    // THE COMPLETE LIST OF DDL ACTIONS, IN ORDER. Not "no unexpected diff" — every statement these
    // three files execute, named. Anything else they did, however briefly and however carefully
    // reverted, appears here.
    const census = await readDdlWitness(probe);
    if (process.env.D7_DUMP_CENSUS) process.stdout.write(`CENSUS ${JSON.stringify(census)}\n`);
    expect(census, 'the DDL census is the exact reviewed action list').toEqual(EXPECTED_DDL);
    // …AND THE WITNESS IS STILL ARMED ON THE SAME POPULATION. A table dropped and recreated under
    // its own name loses its trigger silently, and every statement against the replacement would
    // then go unseen — an empty result that means "not watching" rather than "nothing happened".
    // ON THE SAME RELATIONS, IN THE SAME STATE — not merely the same number. A count survives
    // `ALTER TABLE … DISABLE TRIGGER`, which leaves the trigger in place and silent, and it equally
    // survives one table losing its witness while another gains one.
    const witnessState = async (): Promise<Map<string, string>> => catalogObjects(probe, `
      SELECT t.tgrelid::regclass::text AS key, t.tgenabled::text AS enabled
        FROM pg_catalog.pg_trigger t
       WHERE t.tgname = 'zzz_d7_dml_witness' AND NOT t.tgisinternal`);
    expect(armedState.size, 'the witness must have been armed on a real population').toBe(armed);
    const wd = diffObjects(armedState, await witnessState());
    expect([wd.added, wd.removed, wd.changed],
      `the witness moved during the apply — ${wd.detail.join(' | ')}`).toEqual([[], [], []]);
    for (const [label, sql, minSize] of bracketed) {
      const b = beforeShots.get(label)!;
      if (minSize > 0) {
        expect(b.size, `${label}: the population must be real`).toBeGreaterThanOrEqual(minSize);
      }
      const d = diffObjects(b, await catalogObjects(probe, sql));
      expect([d.added, d.removed, d.changed],
        `${label}: a post-ABC-27 migration moved it — ${d.detail.join(' | ')}`)
        .toEqual([[], [], []]);
    }
  }, 300_000);

  it('NO SHARED CATALOG MOVED — roles, memberships and session settings, captured before any apply', async () => {
    // Compared against the snapshots taken in `beforeAll`, before ANY held-back file ran anywhere in
    // this cluster. See `SHARED_CATALOGS` for why no later reading can work.
    //
    // `pg_db_role_setting` is the one that guards this release's own contract from outside it:
    // `ALTER ROLE service_role SET default_transaction_isolation = 'repeatable read'` makes every
    // future session reuse one snapshot, which would turn the linearization re-read into a stale
    // observation — without touching a single routine, relation, privilege or role attribute.
    for (const [label] of SHARED_CATALOGS) {
      const d = diffObjects(sharedBeforeAnyApply.get(label)!, sharedAfterFirstApply.get(label)!);
      expect([d.added, d.removed, d.changed],
        `${label}: a post-ABC-27 migration moved it — ${d.detail.join(' | ')}`)
        .toEqual([[], [], []]);
    }
    expect(sharedBeforeAnyApply.get('roles and memberships')!.size,
      'the role population must be real').toBeGreaterThanOrEqual(5);
  });

  it('THE HOLD INDEX is exactly the reviewed definition, valid and live, and ABC-27 did not have it', async () => {
    const IDX = 'public.idx_notification_outbox_d7_member_open_claim';
    expect((await pre.query(`SELECT to_regclass($1)::text AS c`, [IDX])).rows[0].c,
      'CONTROL — ABC-27 alone does not carry the claim index').toBeNull();
    const { rows } = await main.query(`
      SELECT pg_catalog.pg_get_indexdef(i.indexrelid)                        AS def,
             pg_catalog.pg_get_expr(i.indpred, i.indrelid)                   AS predicate,
             i.indisvalid, i.indisready, i.indislive, i.indisunique,
             i.indrelid::regclass::text                                      AS onrel
        FROM pg_catalog.pg_index i
       WHERE i.indexrelid = to_regclass($1)`, [IDX]);
    expect(rows, 'the composed chain must carry the claim index').toHaveLength(1);
    const r = rows[0];
    // THE EXACT DEFINITION, not a substring sweep. A same-named index over the right columns with
    // an inverted predicate (`channel <> 'email'`) is valid, live and completely useless to the
    // claim scan; only equality against the whole reviewed rendering refuses it.
    expect(r.def).toBe(
      "CREATE INDEX idx_notification_outbox_d7_member_open_claim ON public.notification_outbox "
      + "USING btree (scheduled_for, id) WHERE ((event_type = 'rebook_member_open_player'::text) "
      + "AND (channel = 'email'::text) AND (transport_state = ANY (ARRAY['queued'::text, "
      + "'retry_wait'::text, 'quiet_hours_deferred'::text, 'channel_kill_deferred'::text])))");
    // The predicate is ALSO read on its own, from `indpred` rather than from the rendered DDL, so
    // the partiality is proved by the catalog's own expression tree and not by parsing a string.
    expect(r.predicate).toBe(
      "((event_type = 'rebook_member_open_player'::text) AND (channel = 'email'::text) "
      + "AND (transport_state = ANY (ARRAY['queued'::text, 'retry_wait'::text, "
      + "'quiet_hours_deferred'::text, 'channel_kill_deferred'::text])))");
    expect(r.onrel).toBe('notification_outbox');
    expect([r.indisvalid, r.indisready, r.indislive, r.indisunique],
      'valid, ready, live, and NOT unique').toEqual([true, true, true, false]);
  });

  it('EFFECTIVE REACHABILITY: who can execute each affected authority, asked of the server', async () => {
    // `has_function_privilege` is the server's own answer, so it accounts for role membership,
    // inheritance and PUBLIC — none of which reading `proacl` as text can see. This is the
    // reachability claim; the ACL strings above are the shape claim, and they are different claims.
    const SUBJECTS = [
      'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
      'public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
      'public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])',
      'public.abc27_a_live_eligible(uuid,uuid)',
    ];
    // `postgres` IS DELIBERATELY ABSENT. It is a superuser, so `has_function_privilege` answers
    // `true` for every function in the cluster whatever the ACL says — including for a surface
    // nobody granted it. A row of unconditional `true` carries no information and would make this
    // matrix look more complete than it is.
    const ROLES = ['anon', 'authenticated', 'service_role', 'runtime_bridge', 'padeltrainer_abc27_owner'];
    const { rows } = await main.query(`
      SELECT s.ident, r.role,
             pg_catalog.has_function_privilege(r.role, to_regprocedure(s.ident), 'EXECUTE') AS can
        FROM unnest($1::text[]) AS s(ident) CROSS JOIN unnest($2::text[]) AS r(role)
       ORDER BY s.ident, r.role`, [SUBJECTS, ROLES]);
    const grid = Object.fromEntries(
      SUBJECTS.map((s) => [s, Object.fromEntries(
        rows.filter((x) => x.ident === s).map((x) => [x.role, x.can as boolean]))]));
    // THE WHOLE MATRIX, STATED. Only the two machine entrypoints are reachable, and only by
    // `service_role`; the two eligibility authorities are reachable by neither the browser roles
    // nor the machine role, and `runtime_bridge` — which `anon`, `authenticated` and `service_role`
    // are all members of — holds nothing anywhere.
    expect(grid).toEqual({
      'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)': {
        anon: false, authenticated: false, service_role: true, runtime_bridge: false,
        padeltrainer_abc27_owner: false,
      },
      'public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)': {
        anon: false, authenticated: false, service_role: true, runtime_bridge: false,
        padeltrainer_abc27_owner: false,
      },
      'public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])': {
        anon: false, authenticated: false, service_role: false, runtime_bridge: false,
        padeltrainer_abc27_owner: true,
      },
      'public.abc27_a_live_eligible(uuid,uuid)': {
        anon: false, authenticated: false, service_role: false, runtime_bridge: false,
        padeltrainer_abc27_owner: true,
      },
    });
    // …and the composed chain did not move ANY of it: the same matrix on the ABC-27-only database.
    const { rows: was } = await pre.query(`
      SELECT s.ident, r.role,
             pg_catalog.has_function_privilege(r.role, to_regprocedure(s.ident), 'EXECUTE') AS can
        FROM unnest($1::text[]) AS s(ident) CROSS JOIN unnest($2::text[]) AS r(role)
       ORDER BY s.ident, r.role`, [SUBJECTS, ROLES]);
    expect(was.map((r) => [r.ident, r.role, r.can]))
      .toEqual(rows.map((r) => [r.ident, r.role, r.can]));
  });

  it('THE NEW ROUTINES: each owned by its own domain, and reachable by exactly one role', async () => {
    // The catalog diff proves eighteen routines were ADDED. It does not prove WHO owns them or who
    // may call them — an `added` entry is compared by identity, so a Domain-P bridge granted to
    // `anon` would appear in that list looking exactly the same. This is the claim the diff cannot
    // make, and the one that decides whether the browser can derive a source set for itself.
    //
    // NEITHER OWNER IS NAMED. Both are resolved from the installed catalog the way the migrations
    // resolve them — Domain P from `public.cycles`, Domain A from the wrapper the surfaces front —
    // so this cannot pass by agreeing with a hardcoded role that drifted.
    const { rows: o } = await main.query(`
      SELECT (SELECT c.relowner::regrole::name FROM pg_catalog.pg_class c
               WHERE c.oid = to_regclass('public.cycles')) AS domain_p,
             (SELECT p.proowner::regrole::name FROM pg_catalog.pg_proc p
               WHERE p.oid = to_regprocedure('public.rebook_round_preview_command_as_actor(uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])')) AS domain_a`);
    const domainP = o[0].domain_p as string;
    const domainA = o[0].domain_a as string;
    expect(domainA, 'the two domains must be DIFFERENT roles, or the split proves nothing')
      .not.toBe(domainP);

    // EVERY routine this release adds, by the domain its name declares.
    const P_BRIDGES = [
      'd7_p_academy_timezone', 'd7_p_cyclus_candidates', 'd7_p_cohort_candidates',
      'd7_p_display_names', 'd7_p_subject_display', 'd7_p_round_taken_names',
      'd7_p_round_label', 'd7_p_series_cluster', 'd7_p_first_names', 'd7_p_location_names',
      // REVIEW ROUND 4 (P3): THE LIST IS THE WHOLE FAMILY, NOT A SAMPLE. `d7_p_selection_digest`
      // and `d7_child_cycle_id` were both absent, so making either client-executable would not
      // have failed this loop — and the digest is the one thing a client must never be able to
      // recompute for a selection it was not shown.
      'd7_p_taken_names', 'd7_p_selection_digest', 'd7_child_cycle_id',
      // The pure renderers are P-owned too: they belong with the bridges they are called beside,
      // and nothing about them wants to live in the authority domain.
      'd7_series_label', 'd7_name_counts', 'd7_name_colliding', 'd7_child_target_names',
    ];
    // ── THE INVITE BRIDGES ARE A THIRD BUCKET, and the reason is worth stating ──────────────
    //
    // Every other `d7_p_*` bridge exists so a DOMAIN-A body can read a product relation, and is
    // granted to the A owner. These two serve the TRANSPORT, whose owner is the owner of
    // `notification_outbox` — measured to be the same role as Domain P, not a third one.
    //
    // So they cannot be asserted as "granted to A": A holds nothing on them, and should not. What
    // they must satisfy is the property that actually matters and is identical for every bridge —
    // P-owned, and closed to every runtime role.
    // `d7_p_invite_contact` joins them: same bucket, same property. It answers WHERE a claim
    // routes, using the shipped guest-then-profile rule, while the snapshot bridge answers WHO
    // the claim's person is — the enqueue needs the first, the outbox guard the second.
    // `d7_p_invite_offer` joins them and supersedes `d7_p_invite_contact` as the routing and
    // offer authority: same bucket, same property — P-owned, closed to every runtime role.
    // `d7_trim_ws` sits in this bucket for the same reason, though it is not a bridge at all: it
    // reads no relation. It exists because PostgreSQL's `btrim` strips ASCII spaces while the
    // sender's JavaScript `.trim()` strips the whole Unicode whitespace set, and an address wrapped
    // in tabs or a non-breaking space was therefore clean on one side and decorated on the other —
    // refusing every enqueue for that recipient (review round 1). It is called from the offer, so
    // it is granted to the transport owner and to nobody else.
    const N_BRIDGES = ['d7_p_invite_recipient_snapshot', 'd7_p_invite_round_claims',
                       'd7_p_invite_contact', 'd7_p_invite_offer', 'd7_trim_ws'];
    const A_ROUTINES = [
      'd7_series_session_count',
      'rebook_round_selection_preview_as_actor', 'rebook_round_selection_apply_as_actor',
    ];
    // ONE NAME MUST MEAN ONE ROUTINE.
    //
    // REVIEW ROUND 5 (P3): every map below was keyed on `proname`, so two routines sharing a name
    // overwrote each other and whichever the server returned last decided the verdict. There is no
    // overload in the family today, but this matrix could not have proved that — it would have
    // reported on one of the pair and said nothing about the other. Collapsing is now a failure
    // that names the offender, rather than a silent choice between them.
    const { rows: owners } = await main.query(`
      SELECT p.proname, p.oid::regprocedure::text AS ident, p.proowner::regrole::name AS owner
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [[...P_BRIDGES, ...N_BRIDGES, ...A_ROUTINES]]);
    for (const fn of [...P_BRIDGES, ...A_ROUTINES]) {
      const sigs = owners.filter((r) => r.proname === fn).map((r) => r.ident as string);
      expect(sigs.length,
        `${fn} must resolve to exactly one routine — an overload has to be listed and judged on its own signature, not folded into this one: ${sigs.join(' | ')}`)
        .toBe(1);
    }
    const ownerOf = Object.fromEntries(owners.map((r) => [r.proname, r.owner]));
    for (const fn of [...P_BRIDGES, ...N_BRIDGES]) {
      expect(ownerOf[fn], `${fn} reads product relations, so Domain P must own it`).toBe(domainP);
    }
    for (const fn of A_ROUTINES) {
      expect(ownerOf[fn], `${fn} is authority-side, so Domain A must own it`).toBe(domainA);
    }

    // REACHABILITY, ASKED OF THE SERVER. `postgres` is deliberately absent: a superuser answers
    // `true` everywhere and would make the matrix look stronger than it is. The Domain-A owner IS
    // asked and is not a superuser, so its `true` on a bridge is the grant and its `false`
    // elsewhere is real negative space.
    const { rows: reach } = await main.query(`
      SELECT p.proname, p.oid::regprocedure::text AS ident, r.role,
             pg_catalog.has_function_privilege(r.role, p.oid, 'EXECUTE') AS can
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN unnest(ARRAY['anon','authenticated','service_role','runtime_bridge',$2::text]) AS r(role)
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [[...P_BRIDGES, ...N_BRIDGES, ...A_ROUTINES], domainA]);
    // Keyed by SIGNATURE, then folded back to the name only once the check above has established
    // that the name identifies exactly one routine.
    const byIdent: Record<string, Record<string, boolean>> = {};
    const identName: Record<string, string> = {};
    for (const r of reach) {
      byIdent[r.ident] = { ...(byIdent[r.ident] ?? {}), [r.role]: r.can as boolean };
      identName[r.ident] = r.proname as string;
    }
    const grid: Record<string, Record<string, boolean>> = {};
    for (const [ident, roles] of Object.entries(byIdent)) grid[identName[ident]] = roles;
    for (const fn of P_BRIDGES) {
      expect(grid[fn], `${fn} is private to Domain A — no client role may derive`).toEqual({
        anon: false, authenticated: false, service_role: false, runtime_bridge: false,
        [domainA]: true,
      });
    }
    // THE INVITE BRIDGES: same negative space, different consumer. Domain A answers FALSE here — it
    // holds nothing on them and needs nothing — while every runtime role is refused exactly as it is
    // for the A-facing bridges. That Domain A cannot reach them is a property, not an oversight: a
    // second owner able to read a claim's contact facts would be a second path to them.
    for (const fn of N_BRIDGES) {
      expect(grid[fn], `${fn} is closed to every client role and to Domain A`).toEqual({
        anon: false, authenticated: false, service_role: false, runtime_bridge: false,
        [domainA]: false,
      });
    }
    // The counter is A's own and is granted to nobody; the OWNER still answers true, for the
    // ordinary reason an owner does — `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`
    // names no owner and PostgreSQL seeds the owner its own EXECUTE. That is recorded rather than
    // asserted away: the claim is about GRANTED roles.
    expect(grid.d7_series_session_count).toEqual({
      anon: false, authenticated: false, service_role: false, runtime_bridge: false,
      [domainA]: true,
    });
    for (const fn of ['rebook_round_selection_preview_as_actor', 'rebook_round_selection_apply_as_actor']) {
      expect(grid[fn], `${fn} is the browser surface, and only that`).toEqual({
        anon: false, authenticated: true, service_role: false, runtime_bridge: false,
        [domainA]: true,
      });
    }

    // NOTHING IN THE FAMILY IS MISSING FROM THE LIST. Derived from the catalog rather than typed
    // out, so a new `d7_p_*` bridge cannot be added without appearing here.
    const { rows: family } = await main.query(`
      SELECT p.proname FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'd7\\_%'
       ORDER BY p.proname`);
    // NOT de-duplicated: a second routine sharing a listed name would have been silently absorbed
    // by the old `new Set(...)`, which is exactly the collapse this round closed above.
    expect(family.map((r) => r.proname as string).sort(),
      'every d7_ routine — each distinct signature — is covered by the matrix above')
      .toEqual([...P_BRIDGES, ...N_BRIDGES, ...A_ROUTINES].filter((x) => x.startsWith('d7_')).sort());

    // …and every one of them is genuinely NEW: absent from the ABC-27-only database, which is why
    // the pre/main comparison every other reachability claim makes is inapplicable here and is
    // replaced by an absolute matrix rather than quietly skipped.
    const { rows: before } = await pre.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [[...P_BRIDGES, ...N_BRIDGES, ...A_ROUTINES]]);
    expect(before[0].n, 'none of these routines may exist before the composed chain').toBe(0);
  });

  it('FORBIDDEN-CALLER NEGATIVE SPACE: the retired names resolve to nothing, in ANY schema', async () => {
    // A dynamically composed caller — `EXECUTE 'SELECT public.claim_…(' || v || ')'` — carries no
    // `pg_depend` edge and cannot be found by reading source: the string may be assembled from
    // fragments, spelled in any case, or built with `format('%I', …)`. So the guarantee is NOT "we
    // found no caller", and this test does not claim to be one. It is that THE NAME RESOLVES TO
    // NOTHING: whatever such a caller runs, it raises `undefined_function`, loudly, instead of
    // quietly doing something. A surviving caller fails; it does not misbehave.
    const { rows } = await main.query(`
      SELECT p.proname, n.nspname
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname IN ('claim_rebook_member_open_notice','unclaim_rebook_member_open_notice',
                           'append_rebook_member_open_notified','rebook_cycles_needing_member_open_notice')`);
    expect(rows, 'no routine of any retired name survives, at any signature, in any schema')
      .toEqual([]);
    // …and the runtime agrees, which is the control that makes the catalog reading mean something.
    await expect(main.query(`SELECT public.claim_rebook_member_open_notice(gen_random_uuid())`))
      .rejects.toMatchObject({ code: '42883' });
    // CONTROL — the same statement on the ABC-27-only database RESOLVES. §10a's shim exists there
    // and raises from INSIDE its own body ("… is retired (ABC-27)", `insufficient_privilege`), so
    // the error is `42501`. That distinction is the whole control: the statement is identical, and
    // `42883` above therefore means the NAME IS GONE rather than that the call was always broken.
    await expect(pre.query(`SELECT public.claim_rebook_member_open_notice(gen_random_uuid())`))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('E-11 — the §7.1 prerequisite guard does not fire on the real chain', () => {
  it('creates the claim index with the exact reviewed definition', async () => {
    const { rows } = await main.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      ['idx_notification_outbox_d7_member_open_claim']);
    expect(rows).toHaveLength(1);
    // THE EXACT DEFINITION, not a substring match. The key is the claim's own ORDER BY (so no Sort
    // node is planned) and the predicate is exactly the three constant conjuncts — a widened
    // predicate or a reordered key would still be "an index called that" and would silently stop
    // serving the query.
    expect(rows[0].indexdef).toBe(
      'CREATE INDEX idx_notification_outbox_d7_member_open_claim ON public.notification_outbox '
      + 'USING btree (scheduled_for, id) WHERE ((event_type = \'rebook_member_open_player\'::text) '
      + 'AND (channel = \'email\'::text) AND (transport_state = ANY (ARRAY[\'queued\'::text, '
      + '\'retry_wait\'::text, \'quiet_hours_deferred\'::text, \'channel_kill_deferred\'::text])))',
    );
  });

  it('retires all four shims by EXACT identity, and leaves no same-named overload behind', async () => {
    const { rows } = await main.query(
      `SELECT ident, to_regprocedure('public.' || ident)::text AS oid FROM unnest($1::text[]) ident`,
      [RETIRED_SHIMS as unknown as string[]]);
    expect(rows.map((r) => r.oid)).toEqual([null, null, null, null]);
    // ...and not merely at that signature: no function of any signature carries these names.
    const { rows: any } = await main.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [RETIRED_SHIM_NAMES as unknown as string[]]);
    expect(any, 'a same-named overload would satisfy an exact-signature probe and still be callable')
      .toEqual([]);
  });

  it('records the legacy settings-residue comment on cycles.settings', async () => {
    const { rows } = await main.query(`
      SELECT col_description('public.cycles'::regclass,
               (SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'public.cycles'::regclass AND attname = 'settings')) AS c`);
    expect(rows[0].c).toContain('HISTORICAL RESIDUE');
    expect(rows[0].c).toContain('do not delete the stored values');
    const { rows: before } = await pre.query(`
      SELECT col_description('public.cycles'::regclass,
               (SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'public.cycles'::regclass AND attname = 'settings')) AS c`);
    expect(before[0].c, 'CONTROL — the comment is written by the retirement migration').toBeNull();
  });
});

// ── The cron half: exactly one retirement, three inactive installs ───────────────────────────

describe('D7 crons — one job retired, three installed INACTIVE, nothing else touched', () => {
  it('unschedules notify-rebook-member-open and leaves auto-rebook-reminder alone', async () => {
    const { rows } = await main.query(
      `SELECT jobname, active FROM cron.job
        WHERE jobname IN ('notify-rebook-member-open','auto-rebook-reminder') ORDER BY jobname`);
    expect(rows, 'the retired job is gone; its sibling from the SAME DO block survives, still armed')
      .toEqual([{ jobname: 'auto-rebook-reminder', active: true }]);
  });

  it('installs exactly three D7 jobs, at the OD-5 cadences, ALL INACTIVE', async () => {
    const { rows } = await main.query(
      `SELECT jobname, schedule, active FROM cron.job WHERE jobname = ANY($1::text[]) ORDER BY jobname`,
      [D7_JOBS.map(([n]) => n)]);
    expect(rows).toHaveLength(3);
    for (const [name, schedule] of D7_JOBS) {
      const row = rows.find((r) => r.jobname === name);
      expect(row, `${name} must be installed`).toBeTruthy();
      expect(row.schedule, `${name} cadence`).toBe(schedule);
      expect(row.active, `${name} must ship INACTIVE — arming it is an owner gate`).toBe(false);
    }
  });

  it('does not disturb any other job in the inventory', async () => {
    // Measured against the COUNTERFACTUAL, not against `pre`: the cron migration is mid-lineage
    // now, so `pre` has already been through it and could not show what it changed.
    const before = (await noCron.query(`SELECT jobname, active FROM cron.job ORDER BY jobname`)).rows;
    const after = (await main.query(`SELECT jobname, active FROM cron.job ORDER BY jobname`)).rows;
    const d7 = new Set<string>(D7_JOBS.map(([n]) => n));
    expect(after.filter((r) => !d7.has(r.jobname)),
      'every pre-existing job except the retired one is byte-identical afterwards')
      .toEqual(before.filter((r) => r.jobname !== 'notify-rebook-member-open'));
  });

  it('schema-qualifies every resolvable name in each stored command', async () => {
    const { rows } = await main.query(
      `SELECT jobname, command FROM cron.job WHERE jobname = ANY($1::text[]) ORDER BY jobname`,
      [D7_JOBS.map(([n]) => n)]);
    for (const r of rows) {
      // A cron tick runs under its owner's search_path, and function resolution does NOT prefer
      // pg_catalog: an exact-arity overload in `public` beats pg_catalog's VARIADIC "any" even
      // after an explicit pg_catalog. An unqualified builder would receive the decrypted
      // service-role bearer as an argument on the very next tick.
      expect(r.command, `${r.jobname}: jsonb_build_object must be qualified`)
        .toContain('pg_catalog.jsonb_build_object(');
      expect(r.command, `${r.jobname}: the || operator must be qualified`)
        .toContain('OPERATOR(pg_catalog.||)');
      expect(r.command, `${r.jobname}: the = operator must be qualified`)
        .toContain('OPERATOR(pg_catalog.=)');
      expect(r.command, `${r.jobname}: the jsonb cast must be qualified`)
        .toContain("'{}'::pg_catalog.jsonb");
      // ...and no UNQUALIFIED form of any of them survives.
      expect(r.command, `${r.jobname}: an unqualified jsonb_build_object remains`)
        .not.toMatch(/(^|[^.\w])jsonb_build_object\s*\(/);
      expect(r.command, `${r.jobname}: an unqualified ::jsonb cast remains`)
        .not.toMatch(/::\s*jsonb(?!\w)/);
    }
  });

  it('installs the three INACTIVE even when the Vault secret is absent (no Vault guard)', async () => {
    // The job is created DISABLED and its stored command reads the secret at TICK time. Skipping on
    // a missing secret would record the migration as applied over nothing: on a restore where
    // migrations run before out-of-band secrets, adding the key later would never create the job.
    const { rows } = await novault.query(
      `SELECT jobname, active FROM cron.job WHERE jobname = ANY($1::text[]) ORDER BY jobname`,
      [D7_JOBS.map(([n]) => n)]);
    expect(rows.map((r) => r.jobname).sort()).toEqual([...D7_JOBS.map(([n]) => n)].sort());
    expect(rows.every((r) => r.active === false)).toBe(true);
  });

  it('is idempotent, and NEVER re-arms or disarms a job the owner already touched', async () => {
    const armed = await chain.clone(`${PREFIX}_rerun`);
    // The owner arms one job by hand, exactly as the runbook's activation step does.
    await armed.query(
      `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rebook-member-open-worker'), active := true)`);
    // A re-apply (a re-run, a restore, a replayed lineage) must leave it exactly as the owner left
    // it. The cron migration's text is re-executed directly here because it is mid-lineage.
    await armed.query('BEGIN');
    await armed.query(migrationSql(D7_CRONS));
    await armed.query('COMMIT');
    const { rows } = await armed.query(
      `SELECT jobname, active FROM cron.job WHERE jobname = ANY($1::text[]) ORDER BY jobname`,
      [D7_JOBS.map(([n]) => n)]);
    expect(rows.find((r) => r.jobname === 'rebook-member-open-worker').active,
      'a re-apply must not disarm a job the owner armed').toBe(true);
    expect(rows.filter((r) => r.jobname !== 'rebook-member-open-worker').every((r) => r.active === false))
      .toBe(true);
    // And re-running the retirement half is a clean no-op rather than an error.
    expect((await armed.query(
      `SELECT count(*)::int n FROM cron.job WHERE jobname = 'notify-rebook-member-open'`)).rows[0].n)
      .toBe(0);
  });
});

// ── E-4: least privilege, proved in BOTH directions ──────────────────────────────────────────

describe('E-4 — service_role reaches exactly the eight machine surfaces and nothing else', () => {
  it('holds EXECUTE on all eight, on every overload', async () => {
    const { rows } = await main.query(`
      SELECT p.proname,
             bool_and(has_function_privilege('service_role', p.oid, 'execute')) AS granted,
             count(*)::int AS overloads
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       GROUP BY p.proname ORDER BY p.proname`, [GRANTED_MACHINE as unknown as string[]]);
    expect(rows.map((r) => r.proname)).toEqual([...GRANTED_MACHINE].sort());
    for (const r of rows) expect(r.granted, `${r.proname} must be executable by service_role`).toBe(true);
  });

  it('EXECUTES all eight as service_role — the grant is real, not merely catalogued', async () => {
    const probe = await chain.clone(`${PREFIX}_probe`);
    await chain.applyHeldBack(probe);
    await probe.query('SET ROLE service_role');
    const NOWHERE = '00000000-0000-4000-8000-000000000000';
    // Every call below is a deliberate no-op or a closed refusal on an empty database: zero-limit
    // batches, and single-row surfaces addressed at an id that exists nowhere.
    await probe.query(`SELECT * FROM public.rebook_round_materialize(1, 1)`);
    await probe.query(`SELECT * FROM public.rebook_member_open_claim_batch('e4-probe', 0)`);
    await probe.query(`SELECT * FROM public.rebook_member_open_recover_expired_leases(0, 15)`);
    await probe.query(`SELECT * FROM public.rebook_member_open_close_unresolved(0)`);
    const resolved = await probe.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1, 'e4-probe', 1)`, [NOWHERE]);
    expect(resolved.rows[0].disposition, 'an unknown row is a closed refusal, never an error').toBe('refused');
    const begun = await probe.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1, 'e4-probe', 1, '\\x00'::bytea, 'b', 'k', 'queued')`,
      [NOWHERE]);
    expect(begun.rows[0].outcome).toBe('refused');
    const recorded = await probe.query(
      `SELECT * FROM public.rebook_member_open_record_dispatch_outcome($1, 'e4-probe', 1, '\\x00'::bytea, 202, NULL, NULL, 'none', true)`,
      [NOWHERE]);
    expect(recorded.rows[0].outcome).toBe('refused');
    const status = await probe.query(
      `SELECT * FROM public.rebook_member_open_dispatch_status_by_capability($1, 1, '\\x00'::bytea, 'k')`,
      [NOWHERE]);
    expect(status.rows, 'exactly one row on every path — a closed envelope never returns nothing')
      .toHaveLength(1);
    expect(status.rows[0].outcome).toBe('refused');
    await probe.query('RESET ROLE');
  });

  it('holds EXECUTE on NONE of the authority surfaces, on any overload', async () => {
    const { rows } = await main.query(`
      SELECT p.proname,
             bool_or(has_function_privilege('service_role', p.oid, 'execute')) AS any_granted
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       GROUP BY p.proname ORDER BY p.proname`, [ABSENT_FOR_SERVICE_ROLE as unknown as string[]]);
    // The names must all still EXIST — a privilege test over a function that was quietly deleted
    // would pass while proving nothing.
    expect(rows.map((r) => r.proname)).toEqual([...ABSENT_FOR_SERVICE_ROLE].sort());
    for (const r of rows) {
      expect(r.any_granted, `service_role must NOT reach ${r.proname}`).toBe(false);
    }
  });

  it('holds EXECUTE on none of the five operator wrappers (S-2)', async () => {
    const { rows } = await main.query(`
      SELECT p.proname,
             bool_or(has_function_privilege('service_role', p.oid, 'execute'))  AS service_role,
             bool_or(has_function_privilege('anon', p.oid, 'execute'))          AS anon,
             bool_or(has_function_privilege('authenticated', p.oid, 'execute')) AS authenticated
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       GROUP BY p.proname ORDER BY p.proname`, [OPERATOR_WRAPPERS as unknown as string[]]);
    expect(rows.map((r) => r.proname)).toEqual([...OPERATOR_WRAPPERS].sort());
    for (const r of rows) {
      expect(r.service_role, `${r.proname}: the operator path is NEVER reachable by service_role`).toBe(false);
      expect(r.anon, `${r.proname}: anon holds nothing`).toBe(false);
      expect(r.authenticated, `${r.proname}: authenticated is the ONE grantee`).toBe(true);
    }
  });

  it('RAISES 42501 when service_role calls an authority surface', async () => {
    const probe = await chain.clone(`${PREFIX}_denied`);
    await chain.applyHeldBack(probe);
    await probe.query('SET ROLE service_role');
    const NOWHERE = '00000000-0000-4000-8000-000000000000';
    const denied: [string, string, unknown[]][] = [
      ['rebook_member_open_dispatch_status', 'SELECT * FROM public.rebook_member_open_dispatch_status($1)', [NOWHERE]],
      ['rebook_round_freeze_and_snapshot', 'SELECT * FROM public.rebook_round_freeze_and_snapshot($1)', [NOWHERE]],
      ['rebook_round_legacy_review_summary', 'SELECT * FROM public.rebook_round_legacy_review_summary(1)', []],
      ['rebook_round_siblings_page', 'SELECT * FROM public.rebook_round_siblings_page($1,$1,NULL,10)', [NOWHERE]],
      ['rebook_round_eligible_recipients', 'SELECT * FROM public.rebook_round_eligible_recipients($1, NULL)', [NOWHERE]],
      ['rebook_member_open_classify_provider_result',
        "SELECT public.rebook_member_open_classify_provider_result(202, NULL, NULL, 'none', true)", []],
      ['rebook_round_command_status_core',
        'SELECT * FROM public.rebook_round_command_status_core($1,$1,$1)', [NOWHERE]],
      ['rebook_round_preview_command_as_actor',
        `SELECT * FROM public.rebook_round_preview_command_as_actor($1,'abc27.wire.v1','create',NULL,NULL,NULL,
           NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
           NULL,NULL,NULL,NULL,NULL,NULL)`, [NOWHERE]],
    ];
    for (const [name, sql, params] of denied) {
      // A refusal must be a PRIVILEGE error, not a validation error that happens to fail: only
      // 42501 proves the surface was unreachable rather than merely unhappy with its arguments.
      await expect(probe.query(sql, params), `${name} must be denied`).rejects.toMatchObject({ code: '42501' });
    }
    await probe.query('RESET ROLE');
  });
});

// ── THE LINEARIZATION POINT ──────────────────────────────────────────────────────────────────

describe('LINEARIZATION — begin_dispatch re-reads live eligibility at the durable decision', () => {
  it('consults the SAME eligibility authority the resolver does, with the same arguments', async () => {
    // This test used to record the OPPOSITE as a residual: `begin_dispatch` re-verified the
    // capability, the frozen request and the window, and did NOT re-read eligibility — so a payment
    // committing between the resolver and the send was invisible to it. `20261203130000` closes
    // that, and the pin is inverted here rather than deleted, so a regression is a failure and not
    // a silence.
    const bodyOf = async (c: pg.Client): Promise<string> => strip((await c.query(`
      SELECT p.prosrc FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(
         'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')`)
    ).rows[0].prosrc as string);

    const body = await bodyOf(main);
    // The SAME authority, not a second implementation of the same idea. `pre_dispatch_resolve`
    // reads eligibility through `abc27_a_live_eligible(round, member)`; if this body reached for
    // anything else the two surfaces could disagree about what eligibility MEANS, and the release
    // would have bought a second opinion instead of a later observation.
    expect(body, 'begin_dispatch must consult the live-eligibility authority')
      .toContain('abc27_a_live_eligible');
    expect(body, 'with the round and the member of the row it holds')
      .toMatch(/abc27_a_live_eligible\s*\(\s*r\.round_id\s*,\s*r\.member_id\s*\)/);
    // BOTH NON-ANSWERS ARE HANDLED, AND THE WHOLE ARM IS PINNED, not just its condition. A pin on
    // `/v_eligible IS NULL/` alone is satisfied by `IF v_eligible IS NULL AND false THEN` — the
    // mutant that turns a fail-closed branch into dead code while leaving the text that describes
    // it in place. So the condition, the refusal it returns and the `RETURN` that ends the row are
    // matched as one contiguous shape.
    expect(body, 'an UNREADABLE answer refuses as `unreadable_policy_state`, never read as eligible')
      .toMatch(/IF\s+v_eligible\s+IS\s+NULL\s+THEN\s*\n\s*RETURN QUERY SELECT 'refused'::text[^\n]*'unreadable_policy_state'::text;\s*\n\s*RETURN;\s*\n\s*END IF;/);
    expect(body, 'and a FALSE answer refuses as `ineligible`')
      .toMatch(/IF\s+NOT\s+v_eligible\s+THEN\s*\n\s*RETURN QUERY SELECT 'refused'::text[^\n]*'ineligible'::text;\s*\n\s*RETURN;\s*\n\s*END IF;/);

    // …AND THE POSITION IS THE PROPERTY. The re-read has to come after every other fence and before
    // the first durable artifact: a refusal issued after `abc27_a_authorize_transition` would leave
    // a stray unconsumed grant behind — standing authority for a transition just judged
    // inadmissible. The behavioural proof that a refusal writes NOTHING is in
    // `src/test/d7RuntimeContract.realpg.test.ts`; this is the structural half.
    expect(body.indexOf('abc27_a_live_eligible'),
      'the eligibility re-read must precede the grant issuance')
      .toBeLessThan(body.indexOf('abc27_a_authorize_transition'));
    expect(body.indexOf('abc27_a_authorize_transition'), 'and the grant issuance must still be there')
      .toBeGreaterThan(-1);

    // The window is STILL re-read — this file adds an authority, it does not trade one for another.
    expect(body, 'the member window is still re-read at authorization').toContain('member_window_ends_at');
    expect(body, 'and the value read from it is still COMPARED against the sampled clock')
      .toMatch(/v_window\s*<=\s*v_sampled_now/);

    // …AND THE DEADLINE IS FENCED AGAIN AFTER THE ELIGIBILITY READ. Before this file the window
    // check WAS the last fence, so "checked at v_sampled_now" and "checked immediately before
    // authorizing" were one instant. The eligibility read separates them by milliseconds that grow
    // with the recipient's provenance, so a row whose window expires during it would otherwise be
    // authorized after the window closed. The re-fence uses a SECOND clock sample and must sit
    // AFTER the eligibility read and BEFORE the grant.
    expect(body, 'the clock is re-sampled after the eligibility read')
      .toMatch(/v_after\s*:=\s*clock_timestamp\(\)/);
    // THE WHOLE ARM, not just its expression: `IF false AND (v_window <= v_after OR …) THEN` still
    // contains the expression while never refusing anything, and that is the mutant this shape
    // exists to catch.
    // TWO ARMS, NOT ONE. The window closing and this row's own cutoff passing are different facts
    // and this unit has a reason for each; `20261203150000` split them so an operator reading
    // `window_invalid` is not sent to look for a finished round that is still open.
    expect(body, 'a closed window is refused as `window_invalid` against the second sample')
      .toMatch(/IF\s+v_window\s*<=\s*v_after\s+THEN\s*\n\s*RETURN QUERY SELECT 'refused'::text[^\n]*'window_invalid'::text;/);
    expect(body, 'and a crossed cutoff on a later generation is refused as `after_cutoff`')
      .toMatch(/IF\s+r\.first_dispatch_at\s+IS\s+NOT\s+NULL\s+AND\s+v_after\s*>=\s*v_cutoff\s+THEN\s*\n\s*RETURN QUERY SELECT 'refused'::text[^\n]*'after_cutoff'::text;/);
    expect(body.indexOf('v_after := clock_timestamp()'),
      'the re-fence must come AFTER the eligibility read')
      .toBeGreaterThan(body.indexOf('abc27_a_live_eligible'));
    expect(body.indexOf('v_after := clock_timestamp()'),
      '…and BEFORE the grant issuance')
      .toBeLessThan(body.indexOf('abc27_a_authorize_transition'));

    // THE ISOLATION GUARD. The freshness the whole file depends on is a property of READ COMMITTED,
    // and the isolation level is ambient — settable per role or per database without touching this
    // body. It is therefore verified inside the transaction that needs it, and refused fail-closed.
    expect(body, 'the isolation level the contract depends on is checked, not assumed')
      .toMatch(/IF\s+current_setting\('transaction_isolation'\)\s*<>\s*'read committed'\s+THEN\s*\n\s*RETURN QUERY SELECT 'refused'::text[^\n]*'unreadable_policy_state'::text;/);
    expect(body.indexOf("current_setting('transaction_isolation')"),
      'and it is checked BEFORE the eligibility read it protects')
      .toBeLessThan(body.indexOf('abc27_a_live_eligible'));

    // CONTROL — ABC-27 ALONE DOES NOT DO THIS. Without it, "the body contains the call" would be
    // true of the original too and the pin would prove nothing about what this release changed.
    const wasBody = await bodyOf(pre);
    expect(wasBody, 'CONTROL — the ABC-27 body does NOT re-read eligibility')
      .not.toContain('abc27_a_live_eligible');
    expect(wasBody, 'CONTROL — but it always did re-read the window').toContain('member_window_ends_at');
  });

  it('DISCLOSED: the UNREADABLE arm is fail-closed defence in depth, not a reachable state', async () => {
    // WHY THIS IS WRITTEN DOWN INSTEAD OF EXERCISED. `abc27_a_live_eligible` answers NULL only for a
    // member the authority cannot speak for at all, and `begin_dispatch` reads its member id from
    // the outbox row it holds. Two shipped invariants stand between those:
    //
    //   • `abc27_a_validate_member_open_insert` refuses an outbox row whose recipient is absent or
    //     belongs to another round or academy, so a row naming an unknown member cannot be written;
    //   • the recipient snapshot is APPEND-ONLY, so the row cannot be removed afterwards either.
    //
    // Both are measured here rather than asserted, because "unreachable" is a claim that rots. The
    // arm therefore has a STRUCTURAL sensor only (the contiguous-shape pin above) and no
    // behavioural one, and that is stated plainly rather than papered over with a fixture that
    // reaches the branch by doing something the product cannot do.
    const { rows: known } = await main.query(`
      SELECT public.abc27_a_live_eligible(r.rebook_round_id, r.id) AS answer
        FROM public.rebook_round_recipients r LIMIT 1`);
    if (known.length === 1) {
      expect(known[0].answer, 'a real recipient is answered `true` or `false`, never NULL')
        .not.toBeNull();
    }
    // The append-only refusal, measured on a DISPOSABLE CLONE — a row has to exist for the trigger
    // to have anything to refuse, and `main` is read-only for every other test in this file.
    const probe = await chain.clone(`${PREFIX}_appendonly`);
    const ACADEMY = '11111111-1111-4111-8111-111111111111';
    await probe.query(
      `INSERT INTO public.academy_profiles(id,name) VALUES ($1,'append-only probe') ON CONFLICT DO NOTHING`,
      [ACADEMY]);
    const round = (await probe.query(`
      INSERT INTO public.rebook_rounds (academy_profile_id,label,priority_window_ends_at,member_window_ends_at)
      VALUES ($1,'append-only probe',now()-interval '1 hour',now()+interval '7 days') RETURNING id`,
    [ACADEMY])).rows[0].id;
    const user = (await probe.query(
      `INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const profile = (await probe.query(
      `SELECT id FROM public.profiles WHERE user_id=$1`, [user])).rows[0].id;
    const rec = (await probe.query(`
      INSERT INTO public.rebook_round_recipients
        (rebook_round_id, academy_profile_id, recipient_player_profile_id, captured_at)
      VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`, [round, ACADEMY, profile])).rows[0].id;
    await expect(probe.query(`DELETE FROM public.rebook_round_recipients WHERE id = $1`, [rec]),
      'the snapshot refuses DELETE, so a written outbox row can never be orphaned')
      .rejects.toMatchObject({ message: expect.stringContaining('append-only') });
    // …and a recipient with NO provenance at all is answered `false`, not NULL: even the emptiest
    // real recipient is a member the authority can speak for.
    expect((await probe.query(`SELECT public.abc27_a_live_eligible($1,$2) AS a`, [round, rec])).rows[0].a,
      'an existing recipient is always answered').toBe(false);
    // NULL is what an id the authority does not know produces — and the insert validator is what
    // stops such an id ever reaching the outbox.
    expect((await probe.query(`SELECT public.abc27_a_live_eligible($1, gen_random_uuid()) AS a`,
      [round])).rows[0].a, 'an UNKNOWN id is the only NULL producer').toBeNull();
  });

  it('EXACT DELTA: both replaced bodies are ABC-27\'s, plus insertions, with NOTHING removed', async () => {
    // ROUND-4 P2-7, and the stronger form of the check `begin_dispatch` already had. Each of these
    // bodies has been replaced — `begin_dispatch` twice, `abc27_p_live_eligibility` twice — and the
    // property that matters is not "it contains the new text" but "it is the reviewed original with
    // known insertions and no deletions". A line diff states that directly and needs no anchors.
    //
    // The digests pin the inserted text itself, which is the one part of each body this release is
    // allowed to change, and therefore the only place an unreviewed edit could hide. Changing either
    // is meant to be a re-review rather than a diff nobody reads.
    // ── THE ONE PERMITTED DELETION, NAMED LINE FOR LINE ────────────────────────────────────
    //
    // `toEqual([])` was the rule, and it is still the rule for everything except a SUBSTITUTION
    // that was reviewed as one. The canonical-outbox generalization moves `begin_dispatch`'s
    // event-type test from a single literal to the closed protected set, and a substitution is a
    // deletion plus an insertion however carefully it is done.
    //
    // So the allowance is the exact line, quoted. Anything else ABC-27 wrote that goes missing —
    // one of its own fences, say — still fails, which is the property this test exists for. And
    // the paired assertion below proves the deleted line came BACK in widened form rather than
    // simply vanishing.
    //
    // EACH SUBSTITUTION IS A TRIPLE: the line that goes, the exact line that must come back, and
    // whether the line was ABC-27'S OWN. That last flag is not bookkeeping — the deletion assertion
    // below exists to catch one of ABC-27's fences being dropped, and a line a PREDECESSOR migration
    // inserted was never ABC-27's to lose. Counting it as one would make the assertion fail for a
    // correct change, and pinning it as ABC-27's would let a real ABC-27 deletion hide behind it.
    // An earlier version derived the returned line by applying one fixed event-type transform to the
    // deleted one, which worked while the only substitution WAS the event-type widening. The subject
    // generalization makes three different substitutions to this body, so the returned form is now
    // stated per pair — otherwise "came back widened" silently stops proving anything for the two it
    // cannot describe.
    const SUBSTITUTIONS: [string, string, boolean][] = [
      // The subject: derived from the row, never chosen. `coalesce` is unambiguous because
      // `chk_notification_outbox_transport_subject_exclusive` makes two subjects unrepresentable.
      ["  SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,",
       "  SELECT o.id, o.related_rebook_round_id AS round_id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id) AS member_id, public.rebook_round_transport_subject_domain_for_event(o.event_type) AS subject_domain,", true],
      // Review round 2: the linearization point must re-read the claim's IDENTITY as well as its
      // status, so `begin_dispatch` needs the row's destination and guest in scope to compare them.
      ["         o.canonical_request_bytes, o.provider_idempotency_key",
       "         o.canonical_request_bytes, o.provider_idempotency_key,", true],
      // The event-type test: one literal becomes the closed protected set.
      ["     AND o.event_type = 'rebook_member_open_player'",
       "     AND o.event_type = ANY (public.rebook_round_protected_event_types())", true],
      // The linearization eligibility re-read, answered per subject domain.
      //
      // It first became `… ELSE NULL END`, which begin_dispatch turns into `refused` /
      // `unreadable_policy_state` — correct while no invitation eligibility authority existed, and
      // the reason review round 1 found that an invitation could never dispatch. There is one now:
      // the claim's own pending state, through the bridge Domain N already holds. A claim this
      // academy does not own returns no row, which is NULL, which still refuses without writing.
      ["  v_eligible := public.abc27_a_live_eligible(r.round_id, r.member_id);",
       "  v_eligible := CASE WHEN r.subject_domain = 'snapshot_member'", false],
      // The derived domain, handed to the issuing authority as its required ninth argument.
      ["           'dispatch_outcome', r.academy, r.round_id, r.member_id,",
       "           'dispatch_outcome', r.academy, r.round_id, r.member_id, r.subject_domain,", true],
    ];
    const SUBJECTS: [string, string, string, number, [string, string, boolean][]][] = [
      ['begin_dispatch',
        'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
        REVIEWED_INSERTION_SHA256, REVIEWED_INSERTION_LINES, SUBSTITUTIONS],
      ['live eligibility',
        'public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])',
        REVIEWED_HOLD_REGION_SHA256, REVIEWED_HOLD_REGION_LINES, []],
    ];

    for (const [label, ident, wantSha, wantLines, wantSubs] of SUBJECTS) {
      const original = await installedBody(pre, ident);
      const now = dedent2(await installedBody(main, ident));
      const d = bodyDiff(original, now);

      // NOTHING WAS REMOVED. This is the half a "contains the new predicate" check cannot make: a
      // replacement that quietly dropped one of ABC-27's own fences would satisfy every other
      // assertion in this file.
      expect(d.deleted,
        `${label}: the replacement deleted ${d.deleted.length} of ABC-27's own lines, and only a reviewed substitution may delete any`)
        .toEqual(wantSubs.filter(([, , ownedByAbc27]) => ownedByAbc27).map(([gone]) => gone));
      // A DELETED LINE MUST COME BACK IN ITS REVIEWED FORM. Without this, "allow three deletions"
      // would permit those lines to be dropped outright — which is precisely the fence-removal the
      // empty expectation was protecting against.
      for (const [gone, returned] of wantSubs) {  // every substitution, whoever wrote the old line
        expect(d.inserted, `${label}: "${gone.trim().slice(0, 48)}…" did not return in its reviewed form`)
          .toContain(returned);
      }
      expect(d.inserted.length, `${label}: the replacement must actually insert something`)
        .toBeGreaterThan(0);
      expect(d.inserted.length, `${label}: the insertion is not the size it was reviewed at`)
        .toBe(wantLines);
      // Same escape hatch as `D7_DUMP_CENSUS` above: the digest below pins REVIEWED text, so there
      // has to be a way to read that text before pinning it. Pasting a hash the failure message
      // handed you is not a review.
      if (process.env.D7_DUMP_INSERTED) {
        process.stdout.write(`INSERTED ${label}\n${d.inserted.join('\n')}\n<<<END\n`);
      }
      expect(createHash('sha256').update(d.inserted.join('\n'), 'utf8').digest('hex'),
        `${label}: the inserted text is not the reviewed text — re-review it and update this digest`)
        .toBe(wantSha);
    }
  });

  it('the resolver still reads the same authority, so the two observations differ only in WHEN', async () => {
    const { rows } = await main.query(`
      SELECT p.prosrc FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')`);
    expect(strip(rows[0].prosrc as string),
      'the resolver is unchanged in this respect and still consults the one authority')
      .toMatch(/abc27_a_live_eligible\s*\(\s*r\.round_id\s*,\s*r\.member_id\s*\)/);
  });

  it('THE RESIDUAL, STATED HONESTLY: the observation-to-commit interval, and nothing wider', () => {
    // ⚠ WHAT IS NOT CLOSED, AND CANNOT BE CLOSED HERE.
    //
    // The re-read above is a snapshot taken inside the durable transaction, microseconds before the
    // authorization write. A payment committing in THAT interval is still not seen. Driving it to
    // zero would mean taking a lock the payment path must also take, and holding a payment or
    // booking lock across an external provider call is a deadlock-and-latency hazard this design
    // refuses. An eligibility read and an outbound email cannot be made atomic by anyone.
    //
    // So the contract is a LINEARIZATION POINT, not an impossibility claim: everything committed
    // before the observation is honoured; a payment committed after it does not retroactively
    // invalidate an already-authorized send, and a sent email cannot be recalled.
    //
    // THIS TEST HAS NO DATABASE ASSERTION ON PURPOSE. It pins the WORDING, in the two places an
    // operator reads it, so the release cannot quietly drift back to claiming an absolute.
    const runbook = readFileSync(join(process.cwd(), 'docs', 'ABC27_ROLLOUT_RUNBOOK.md'), 'utf8');
    const migration = migrationSql(D7_LINEARIZE);
    for (const [label, text] of [['the runbook', runbook], ['the migration header', migration]] as const) {
      expect(text, `${label} must state the linearization point`)
        .toMatch(/linearization point/i);
      expect(text, `${label} must say what a later payment does NOT do`)
        .toMatch(/does not retroactively invalidate/i);
    }
    // …and NEITHER may claim a send can be taken back. The test is for an AFFIRMATIVE claim, not
    // for the words: both texts say in so many words that an authorized send CANNOT be recalled,
    // and a pin that banned the vocabulary would have banned the honest sentence along with the
    // dishonest one.
    for (const [label, text] of [['the runbook', runbook], ['the migration header', migration]] as const) {
      expect(text, `${label} must not claim an authorized send can be taken back`)
        .not.toMatch(/\b(?:can|could|will|may|might)\s+(?:still\s+)?be\s+(?:recalled|retracted|un-?sent|cancelled|canceled)\b/i);
    }
    // …and the honest negative really is present, so the check above is not passing over silence.
    for (const [label, text] of [['the runbook', runbook], ['the migration header', migration]] as const) {
      expect(text, `${label} must say outright that an authorized send cannot be taken back`)
        .toMatch(/cannot be (?:recalled|taken back)/i);
    }
  });
});

// ── E-4b — DEFENCE IN DEPTH, NOT THE GUARANTEE ───────────────────────────────────────────────
//
// WHERE THE GUARANTEE ACTUALLY LIVES. "No caller survives the retirement" is carried by the
// CATALOG block above, and by one fact rather than by a search: after the retirement the four names
// resolve to NOTHING, in any schema, at any signature — so whatever a surviving caller runs, it
// raises `undefined_function` loudly instead of quietly doing something. That is a property of the
// catalog and it is complete.
//
// WHY THE SCAN BELOW IS NOT THAT GUARANTEE, STATED SO NOBODY LEANS ON IT. It reads source text, and
// source text is defeatable exactly the way the retired composition pins were: `EXECUTE 'SELECT
// PUBLIC.CLAIM_…($1)'` is folded by the parser but not by a case-sensitive `~`; `format('%I', …)`
// never spells the name at all; a literal split across a concatenation carries no whole name in any
// one piece; and a caller in a schema other than `public` is outside the query's own WHERE clause.
// The scan is kept because a body that DOES spell a retired name is worth catching early and
// cheaply — an early warning, with its planted-caller control to show it can still see. Nothing in
// this release depends on it finding everything, because it cannot.
describe('E-4b — the four retired shims leave nothing behind (defence in depth)', () => {
  it('carries no pg_depend edge to any of them (they are gone, and nothing referenced them)', async () => {
    const { rows } = await main.query(`
      SELECT count(*)::int AS n
        FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
        JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [RETIRED_SHIM_NAMES as unknown as string[]]);
    expect(rows[0].n).toBe(0);
  });

  it('ADVISORY: no function body, view definition or constraint expression spells one of them', async () => {
    const pattern = RETIRED_SHIM_NAMES.join('|');
    const { rows } = await main.query(`
      WITH bodies AS (
        SELECT 'function:' || p.proname AS site,
               -- Comments and quoted literals stripped leftmost-first. IT CAN MISS A CALL, and the
               -- header above says how: a call composed inside a literal is erased by this very
               -- strip, and one built with format %I or from concatenated fragments never spells
               -- the name at all. What it cannot do is miss a call written out plainly in
               -- executable text, which is what it is kept for.
               regexp_replace(p.prosrc, '(--[^\n]*)|(''([^'']|'''')*'')', ' ', 'g') AS body
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
        UNION ALL
        SELECT 'view:' || c.relname, pg_get_viewdef(c.oid)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
        UNION ALL
        SELECT 'constraint:' || con.conname, pg_get_constraintdef(con.oid)
          FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT 'default:' || c.relname || '.' || a.attname, pg_get_expr(ad.adbin, ad.adrelid)
          FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid
          JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT 'policy:' || pol.polname,
               coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
               coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
          FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
      )
      SELECT site FROM bodies WHERE body ~ $1 ORDER BY site`, [`(${pattern})`]);
    expect(rows.map((r) => r.site), 'nothing that survives may name a retired shim').toEqual([]);
  });

  it('CONTROL — the scan finds a PLANTED caller, so a clean result means clean', async () => {
    // The scan above returns an empty list. That is only evidence if the query can produce a
    // non-empty one, and the pre-D7 chain cannot supply the proof: §4's whole finding is that
    // NOTHING in the lineage ever called these four — every reference is DDL. So the control
    // plants callers on a disposable pre-D7 clone (where the shims still exist to be called) and
    // requires the exact same query to name them.
    const ctl = await chain.clone(`${PREFIX}_scanctl`);
    await ctl.query(`
      CREATE FUNCTION public._d7_ctl_fn() RETURNS boolean LANGUAGE sql AS
        $f$ SELECT public.claim_rebook_member_open_notice('00000000-0000-4000-8000-000000000000'::uuid) $f$;
      CREATE VIEW public._d7_ctl_view AS
        SELECT cycle_id FROM public.rebook_cycles_needing_member_open_notice();`);
    const pattern = RETIRED_SHIM_NAMES.join('|');
    const { rows } = await ctl.query(`
      WITH bodies AS (
        SELECT 'function:' || p.proname AS site,
               regexp_replace(p.prosrc, '(--[^\n]*)|(''([^'']|'''')*'')', ' ', 'g') AS body
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
        UNION ALL
        SELECT 'view:' || c.relname, pg_get_viewdef(c.oid)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
      )
      SELECT site FROM bodies WHERE body ~ $1 ORDER BY site`, [`(${pattern})`]);
    expect(rows.map((r) => r.site),
      'both the function arm and the view arm of the scan must see a planted caller')
      .toEqual(['function:_d7_ctl_fn', 'view:_d7_ctl_view']);
  });

  it('CONTROL — every arm of the scan actually has something to scan', async () => {
    // The other way the scan could pass for the wrong reason: an arm whose FROM clause is broken
    // and silently contributes no rows at all. Each arm is required to produce a plausible
    // population on the real chain, so none of them can be quietly empty.
    const { rows } = await main.query(`
      SELECT
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind IN ('f','p'))                       AS functions,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('v','m'))                        AS views,
        (SELECT count(*)::int FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
          WHERE n.nspname = 'public')                                                   AS constraints,
        (SELECT count(*)::int FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')     AS defaults,
        (SELECT count(*)::int FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')     AS policies`);
    for (const [arm, n] of Object.entries(rows[0])) {
      expect(n as number, `the ${arm} arm of the scan is empty — it can hide a hit`).toBeGreaterThan(0);
    }
  });

  /**
   * THE OVERLOAD CHECK, PROVED AGAINST AN ACTUAL OVERLOAD.
   *
   * REVIEW ROUND 5 (P3): the family matrix now refuses a collapsed name, but with no overload in
   * the catalog that refusal cannot be exercised — it would pass whether or not it worked. This
   * creates one inside a transaction, runs the very same detection the matrix runs, and rolls it
   * back, so the guard is shown to discriminate without leaving anything behind.
   */
  it('AN OVERLOAD OF A LISTED ROUTINE is caught by the matrix, not folded into it', async () => {
    const detect = `
      SELECT p.proname, p.oid::regprocedure::text AS ident
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'd7_series_label'`;

    const clean = await main.query(detect);
    expect(clean.rows.length, 'the shipped catalog carries exactly one d7_series_label').toBe(1);

    await main.query('BEGIN');
    try {
      await main.query(
        `CREATE FUNCTION public.d7_series_label(p_probe int)
           RETURNS text LANGUAGE sql IMMUTABLE AS $probe$ SELECT 'overloaded'::text $probe$`);
      const shadowed = await main.query(detect);
      expect(shadowed.rows.length, 'two routines now answer to the one name').toBe(2);
      // The old matrix keyed on `proname` and would have kept whichever row came last, reporting a
      // verdict for one signature while saying nothing about the other. Keyed on the signature,
      // both are visible and the count check fails loudly.
      expect(new Set(shadowed.rows.map((r) => r.ident as string)).size).toBe(2);
      expect(new Set(shadowed.rows.map((r) => r.proname as string)).size,
        'which is precisely what a proname key collapses to').toBe(1);
    } finally {
      await main.query('ROLLBACK');
    }

    expect((await main.query(detect)).rows.length, 'and the probe left nothing behind').toBe(1);
  });
});
