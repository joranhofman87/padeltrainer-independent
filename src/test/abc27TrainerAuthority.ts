// @vitest-environment node
//
// ══ THE ABC-27 FIXTURE TRAINER SOURCE AUTHORITY ══════════════════════════════════════════════
//
// `check_trainer_slot_overlap` is one of the 44 shipped triggers, it is live on the ABC-27
// predecessor, Stage-0 pins every one of them `tgenabled='O'`, and it is scoped to `trainer_id`
// ALONE. Nothing truncates between tests. So two fixtures that share a trainer share ONE overlap
// namespace and collide whenever the calendar walks one onto the other — which is exactly what
// happened on 2026-08-29.
//
// WHY THIS IS A SOURCE AUTHORITY AND NOT AN OBSERVER. The predecessor of this module watched the
// property from the client: every statement was bracketed by an exact `slot_id → trainer_id` map
// and the diff was the proof. Its terminal review refused it, and the core judgment was
// structural rather than a list of bugs — a statement-boundary observer can only ever speak about
// state that SURVIVES a statement, so the claim it made was wider than the mechanism could carry.
// Patching the bracketing would have moved the hole, not closed it.
//
// The replacement does not observe writes at all. It makes the offending write UNCONSTRUCTIBLE:
//
//   1. A trainer id that may reach `availability_slots` is a value of the branded type
//      `IsolatedTrainerId`, and the brand can be minted only in this file.
//   2. Minting registers the id against the CURRENT TEST in a process-wide, EXCLUSIVE registry.
//      A second identity asking for the same id throws AT ACQUISITION — before any row exists,
//      in every database and every clone, with no `database` key to lose across a rename or a
//      DROP/CREATE cycle.
//   3. `scripts/check-abc27-trainer-source-authority.mjs` proves, from the TypeScript program,
//      that every write site in the ABC-27 suite binds `trainer_id` to a value of that type —
//      and refuses, by default, anything it cannot classify.
//
// The honest claim, which is the reviewer's own narrowing adopted verbatim: reuse is IMPOSSIBLE
// for every construction the type-checker and the guard can classify; unclassifiable
// constructions are REFUSED at CI; the registry refuses reuse at acquisition in EVERY run; and
// the suite's committed-residue census proves the end state clean. Nothing is claimed about
// mid-statement transient states — with no obtainable foreign trainer id there is no source for
// one to draw on.
//
// NO DATABASE OBJECT, NO EXTRA CONNECTION, NO LOCK. That is not a preference. The frozen ABC-27
// migration checks the Domain-P DML trigger inventory against a pinned baseline by SYMMETRIC
// DIFFERENCE and RAISES on any extra trigger, and it holds `LOCK TABLE ONLY
// public.availability_slots` for its whole install (measured: two 300 s hook timeouts when a
// second session tried to `CREATE TRIGGER` behind it). A held per-database connection is out for
// a third reason: it makes the suite's own `DROP DATABASE` fail with "is being accessed by other
// users". This module owns nothing but a `Map`.
import { afterEach, beforeEach, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * THE BRAND. `unique symbol` in a `declare const` that is never exported, so the property key
 * cannot be named — let alone produced — outside this module. An `as IsolatedTrainerId` cast is
 * the only way to forge one, and the AST guard refuses those everywhere but here.
 *
 * It is an INTERSECTION with `string`, which is what makes it usable at every existing call site
 * unchanged: a branded id still interpolates into SQL, still goes into a `uuid[]` parameter, and
 * still compares with `===`. Intersection assignability is not gated on `strict`, so this holds
 * under this repository's `strict: false`.
 */
declare const isolatedTrainerBrand: unique symbol;
export type IsolatedTrainerId = string & { readonly [isolatedTrainerBrand]: true };

/**
 * ══ THE SECOND BRAND: A STRUCTURALLY INERT SQL FRAGMENT ══════════════════════════════════════
 *
 * Three fixture helpers build one slot INSERT from a fixed column list and a bag of caller-supplied
 * SQL FRAGMENTS — `o.court ?? "'indoor'"`, `o.extra ?? "'[]'::jsonb"`, and so on. A fragment is a
 * SQL expression, not a value, so it cannot be a bound parameter; it is interpolated.
 *
 * A REVIEW ROUND SHOWED WHY THAT MATTERS. The static reader models an interpolation it cannot
 * resolve as one inert token, and the argument for admitting one in a non-trainer VALUE was that
 * the separating commas are static text, so an atom can only ADD an expression and PostgreSQL
 * refuses a row with more expressions than columns. That argument is WRONG: a fragment can close
 * its own row and open another of exactly the right arity — `x), (foreign_trainer, …` — and the
 * second row's trainer is invisible to any reader looking at the first.
 *
 * So the fragment is validated where it becomes SQL. `sqlFragment` accepts a SINGLE SQL EXPRESSION
 * and nothing else: balanced parentheses, no top-level comma, no statement separator, no comment
 * marker, no unterminated string or dollar-quote. Such a text cannot close a row, open a row, end
 * a statement, or comment away what follows — so it cannot move which expression lands in
 * `trainer_id`, which is the whole property. The brand is what lets the static reader KNOW the
 * value went through here, and the AST guard refuses casts to or from it exactly as it does for
 * `IsolatedTrainerId`.
 */
declare const sqlFragmentBrand: unique symbol;
export type SqlFragment = string & { readonly [sqlFragmentBrand]: true };

/**
 * Validate one SQL expression fragment, or throw. Returns the same text, branded.
 *
 * LEXED, NOT MATCHED. `--` inside `'…'` is not a comment and a `,` inside `'…'` is not a
 * separator, so the scan tracks single quotes (with the doubling rule), `E'…'` backslash escapes,
 * double-quoted identifiers and dollar quotes. Everything it cannot finish reading is a refusal.
 */
export function sqlFragment(text: string): SqlFragment {
  const refuse = (why: string): never => {
    throw new Error(
      `abc27 sql fragment: ${JSON.stringify(String(text).slice(0, 60))} ${why} — a fixture override `
      + 'must be ONE SQL expression, so that it cannot change which expression lands in a column.');
  };
  if (typeof text !== 'string') refuse('is not a string');
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || (/[Ee]/.test(ch) && text[i + 1] === "'")) {
      const escaped = ch !== "'";
      let j = i + (escaped ? 2 : 1);
      for (;;) {
        if (j >= text.length) refuse('carries an unterminated string');
        if (escaped && text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) refuse('carries an unterminated quoted identifier');
        if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } break; }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        if (end === -1) refuse('carries an unterminated dollar-quoted string');
        i = end + m[0].length;
        continue;
      }
    }
    if (ch === '-' && text[i + 1] === '-') refuse('carries a line comment');
    if (ch === '/' && text[i + 1] === '*') refuse('carries a block comment');
    if (ch === ';') refuse('carries a statement separator');
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth < 0) refuse('closes a parenthesis it did not open'); }
    if (ch === ',' && depth === 0) refuse('carries a top-level comma, so it is more than one expression');
    i += 1;
  }
  if (depth !== 0) refuse('leaves a parenthesis open');
  return text as SqlFragment;
}

/**
 * ...AND A THIRD, FOR INTERPOLATION *INSIDE* QUOTES.
 *
 * `SqlFragment` guarantees ONE SQL EXPRESSION, which is the right invariant for an UNQUOTED
 * position — `VALUES (…, <fragment>, …)`. It is the wrong one inside static quotes. A review round
 * found the case exactly: `sqlFragment("x', 'y")` is a single valid expression, and dropping it
 * into `'…'` yields `'x', 'y'`, which is two. The guard now refuses a fragment inside a string
 * literal, and a value meant to sit there uses this instead.
 *
 * The invariant here is far narrower and needs no lexing at all: a canonical UUID. It contains
 * only hex digits and hyphens, so it cannot close a quote, open a comment, separate a statement or
 * add an expression — in a quoted position or an unquoted one.
 */
declare const sqlQuotedBrand: unique symbol;
export type SqlQuotedLiteral = string & { readonly [sqlQuotedBrand]: true };

/** A UUID, canonicalised and branded for interpolation inside SQL quotes. Throws on anything else. */
export function sqlUuid(id: string): SqlQuotedLiteral {
  return canonicalTrainerId(id) as unknown as SqlQuotedLiteral;
}

/** Writes made before any test begins — suite setup and `beforeAll` hooks — belong to this. */
export const BOOTSTRAP_IDENTITY = '<bootstrap: suite setup and hooks>';

/**
 * `trainer_id → the identity that owns it`, for the whole suite process.
 *
 * DELIBERATELY NOT KEYED BY DATABASE. The observer's registry was, and that key was a defect in
 * its own right: `ALTER DATABASE … RENAME` carries the rows to a name whose registry is empty,
 * and a DROP/CREATE cycle resets one while the template it was cloned from still holds slots. A
 * trainer belongs to one test, full stop — in every database, in every clone, forever. Keying by
 * nothing at all is both simpler and strictly stronger, and it deletes that whole class.
 *
 * In memory: there is nothing to roll back, and no product row is created by registering.
 */
const owners = new Map<string, string>();

// PER TEST FILE, AND THAT IS THE RIGHT GRAIN. Vitest isolates modules per file, so each suite that
// imports this gets its own registry — which is exactly the scope of the collision: two fixtures
// in ONE file sharing one overlap namespace. Two different files run against different databases
// (and, in the db project, one at a time), so a shared registry across them would refuse
// legitimate work without protecting anything.

/**
 * Whether a TEST is currently running, as opposed to a hook between tests.
 *
 * `expect.getState().currentTestName` is set when a test starts and, in this Vitest version, is
 * NOT cleared when it ends — so a later `beforeAll` reads the PREVIOUS test's name and would
 * acquire trainers as if it were that test. The flag is what makes the hook identity real.
 */
let insideTest = false;

/**
 * ...AND A NAME IS NOT AN IDENTITY. Vitest permits two tests to carry the same full name — same
 * title, same describe chain — and `currentTestName` then reports one string for both. Keyed on
 * that alone the registry would consider them ONE test and hand them the same trainer, silently,
 * which is the collision it exists to refuse. So every test start takes the next ordinal and the
 * identity is `<ordinal>:<name>`: distinct for distinct tests however they are titled, and still
 * carrying the name so a refusal says which test holds the id.
 */
let testOrdinal = 0;

/**
 * Install the identity bookkeeping. Called at the top of a suite file, so the hooks are that
 * FILE's hooks — registering them at import time would attach them to whichever file happened to
 * import this module first.
 */
export function installTrainerAuthorityHooks(): void {
  beforeEach(() => { insideTest = true; testOrdinal += 1; });
  afterEach(() => { insideTest = false; });
}

/** The current test, or the bootstrap identity in a hook. Never null: an acquisition always has an owner. */
export const currentIdentity = (): string => (insideTest
  ? `${testOrdinal}:${expect.getState().currentTestName ?? '<unnamed>'}`
  : BOOTSTRAP_IDENTITY);

/** Who owns `id`, or `undefined` if no identity has ever acquired it. Keyed canonically, so a
 *  differently spelled UUID reports the same owner. */
export const trainerOwner = (id: string): string | undefined => {
  try { return owners.get(canonicalTrainerId(id)); } catch { return undefined; }
};

/**
 * THE ONE PLACE THE BRAND IS MINTED, and the point at which reuse is refused.
 *
 * OWNERSHIP IS EXCLUSIVE. Without that, "each test has its own namespace" is unenforceable: a
 * second test could simply ask for the first one's trainer and the registry would agree. The
 * refusal happens HERE — at acquisition, before the caller holds a value it could write with —
 * rather than after a row exists and has to be noticed.
 *
 * Re-acquisition by the SAME identity is the normal case and is silent: fixtures legitimately
 * share one trainer within a test (it is part of the template vector that makes several slots one
 * series), and `testTrainer` is re-derived on every call.
 */
/**
 * THE REGISTRY KEY IS THE UUID, NOT THE STRING THAT SPELLED IT.
 *
 * PostgreSQL accepts a `uuid` in several spellings — any case, with or without hyphens, and
 * optionally braced — and normalises them all to one value. A registry keyed on the raw string
 * would hand `AA000000-…` to one test and `aa000000-…` to another and consider them different,
 * while the database considers them the same row and the overlap trigger considers them the same
 * namespace. That is the exact defect this exists to prevent, arriving through the front door.
 *
 * Anything that is not a UUID at all is REFUSED rather than registered: a fixture that acquires a
 * non-uuid "trainer" has already lost the property, and the database would reject the write later
 * with an error that says nothing about ownership.
 */
export function canonicalTrainerId(id: string): string {
  const bare = String(id).trim().replace(/^\{(.*)\}$/, '$1').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(bare)) {
    throw new Error(
      `abc27 trainer namespace: ${JSON.stringify(id)} is not a UUID, so it cannot be a trainer `
      + 'namespace — the registry keys on the value PostgreSQL stores, not on the text that '
      + 'spelled it.');
  }
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

function declareTrainerFor(identity: string, id: string): IsolatedTrainerId {
  const key = canonicalTrainerId(id);
  const owner = owners.get(key);
  if (owner === undefined) {
    owners.set(key, identity);
    return key as IsolatedTrainerId;
  }
  if (owner !== identity) {
    throw new Error(
      `abc27 trainer namespace: ${key} is already owned by ${JSON.stringify(owner)} `
      + `and cannot be acquired by ${JSON.stringify(identity)} — a trainer belongs to one test.`);
  }
  // THE CANONICAL FORM IS WHAT IS ISSUED, so the value that reaches SQL is the value the registry
  // keyed on. Handing back the caller's spelling would leave two texts for one namespace.
  return key as IsolatedTrainerId;
}

/**
 * Ensure the `trainer_profiles` rows exist for ids this authority has already issued.
 *
 * ENSURED ON EVERY CALL, not once. Several fixtures do their work inside a transaction they then
 * roll back; a row created on the first call would disappear with it while the registry kept
 * handing the id out, and the next slot insert would fail its foreign key. `ON CONFLICT DO
 * NOTHING` makes the repeat free.
 *
 * REGISTRATION HAPPENS FIRST, ALWAYS. Every factory below acquires before it writes, so a
 * refusal costs no row and leaves no residue — which is the whole difference between preventing
 * the collision and noticing it.
 */
async function ensureProfiles(client: pg.Client, ids: readonly IsolatedTrainerId[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `INSERT INTO public.trainer_profiles(id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
    [ids]);
}

/**
 * THE TRAINER NAMESPACE OF THE CURRENT TEST.
 *
 * Sharing a trainer is meaningful only WITHIN a test, where it is part of the template vector
 * that makes slots one series. Deriving per test gives each fixture its own namespace while
 * preserving that intra-test sharing exactly, and it moves no timestamp.
 *
 * FAIL-CLOSED OUTSIDE A TEST: a `beforeAll` has no test name, and silently folding every hook
 * onto one fallback namespace would rebuild the very collision this removes. Those fixtures bind
 * a trainer explicitly instead.
 */
export async function testTrainer(client: pg.Client): Promise<IsolatedTrainerId> {
  // GATED BY `insideTest`, EXACTLY AS THE IDENTITY IS. Reading `currentTestName` on its own was a
  // second copy of the bug the flag exists for: Vitest does not clear it when a test ends, so a
  // later `beforeAll` would read the PREVIOUS test's name, derive that test's trainer and acquire
  // it under the bootstrap identity — leaving the test itself to be refused its own id when it ran.
  const key = insideTest ? expect.getState().currentTestName : undefined;
  if (!key) {
    throw new Error(
      'testTrainer() was called outside a test, where there is no per-test namespace to derive. '
      + 'Bind a fixture-local trainer with newTrainerId() and thread it through explicitly.');
  }
  // DERIVED, NOT ALLOCATED. A random trainer would make every fixture that pins a canonical
  // digest non-deterministic, because `trainer_id` is part of the reviewed intent those digests
  // are taken over. Deriving the id from the test name keeps it stable across runs while still
  // giving each test its own namespace. THE DERIVATION IS PINNED EVIDENCE: changing a byte of it
  // moves every digest-pinned fixture in the suite.
  // TWO TESTS WITH THE SAME FULL NAME DERIVE THE SAME ID, and the second one is refused. That is
  // the registry working rather than a limitation: `currentTestName` includes the describe chain,
  // so an exact collision means two tests a reader cannot tell apart either.
  const h = createHash('sha256').update(`abc27-test-trainer:${key}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const issued = declareTrainerFor(currentIdentity(), id);
  await ensureProfiles(client, [issued]);
  return issued;
}

/**
 * A fresh trainer, for a fixture whose slots must not share the overlap namespace with any other.
 *
 * MINTED IN JAVASCRIPT, not by `gen_random_uuid()` in a `RETURNING` clause as this used to be.
 * Two things follow. The id is registered BEFORE the row is written rather than after, so a
 * refusal never leaves a `trainer_profiles` row behind; and there is no SQL-side trainer source
 * left anywhere for the guard to have to reason about.
 */
export async function newTrainerId(client: pg.Client): Promise<IsolatedTrainerId> {
  const issued = declareTrainerFor(currentIdentity(), randomUUID());
  await ensureProfiles(client, [issued]);
  return issued;
}

/** Acquire one already-chosen id for the current test, and ensure its profile row exists. */
export async function declareTrainer(client: pg.Client, id: string): Promise<IsolatedTrainerId> {
  const issued = declareTrainerFor(currentIdentity(), id);
  await ensureProfiles(client, [issued]);
  return issued;
}

/** Acquire a list of already-chosen ids for the current test, in one round trip. */
export async function declareTrainers(
  client: pg.Client, ids: readonly string[],
): Promise<IsolatedTrainerId[]> {
  const issued = ids.map((id) => declareTrainerFor(currentIdentity(), id));
  await ensureProfiles(client, issued);
  return issued;
}

/**
 * A CONTIGUOUS RANGE, minted here rather than in SQL.
 *
 * Two fixtures need one trainer per child — the shipped overlap guard refuses many hour-long
 * windows a minute apart for a single trainer, and two children of one command may not share a
 * series key (`uq_rrcc_series`). They used to mint those ids inside the `INSERT … SELECT` itself,
 * with `('9e0f…' || lpad(g.i::text, 12, '0'))::uuid` over a `generate_series`, and then declare
 * the same range a second time in JavaScript by restating the rule. That was two implementations
 * of one identity, and the SQL one was a trainer source no type could reach.
 *
 * The ids are byte-identical to what that expression produced — `prefix` followed by `i` zero-
 * padded to twelve digits, for `i` in `1..count` — and they are now ordinary branded values that
 * travel as a `uuid[]` parameter. `WITH ORDINALITY` at the call site reproduces `g.i` exactly.
 */
export async function mintTrainerRange(
  client: pg.Client, prefix: string, count: number,
): Promise<IsolatedTrainerId[]> {
  const ids = Array.from({ length: count },
    (_unused, i) => `${prefix}${String(i + 1).padStart(12, '0')}`);
  return declareTrainers(client, ids);
}
