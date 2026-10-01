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
// WHAT THIS IS, IN ONE LINE: the REGISTRY of who owns which trainer, and which slot, right now.
//
// TWO PREDECESSORS FAILED HERE, AND THEIR FAILURES SHAPED IT. The first watched writes from the
// client, bracketing every statement with an exact `slot_id → trainer_id` map. Its review refused
// it structurally: a statement-boundary observer can only speak about state that SURVIVES a
// statement, so the claim was wider than the mechanism.
//
// The second — this module's own previous shape — made the claim STATIC instead: a trainer that
// may reach `availability_slots` is a branded value, and a checker proves from the TypeScript
// program that every write site binds `trainer_id` to one. That is a general dataflow question,
// and a review round answered it three ways at once: a brand acquired through a CONTAINING type
// (`{ t: IsolatedTrainerId }` annotated from an `any`); an array widened to `string[]` and then
// mutated through the alias; and source slots delivered to an apply driver through a GETTER no
// syntactic follower evaluates. Under `strict: false` none of those needs a cast.
//
// SO THE LOAD-BEARING CHECK IS NOW A RUNTIME CAPABILITY, and this module is where it lives:
//
//   1. `requireOwnedByCurrentIdentity()` — asked by every factory entrypoint that NAMES A
//      TRAINER, at the moment it writes. A forged brand is just a string by then, and a string
//      this test does not own is refused.
//   2. `assertSlotsNotForeign()` — asked by every factory entrypoint that names a SLOT, and by
//      the six writing apply paths about the SOURCE SLOTS they were actually handed, because
//      those cores derive the target trainer from them. That is the indirect path, and it is
//      closed on values rather than on syntax.
//   3. The registry itself refuses reuse AT ACQUISITION — before any row exists, in every
//      database and every clone, with no `database` key to lose across a rename or a DROP/CREATE.
//
//   DELETE IS OUTSIDE ALL OF THIS, deliberately: removing a row cannot create an overlap
//   namespace, which is the property these exist for. "Every slot write" below means every
//   INSERT, UPDATE, MERGE or COPY.
//
// THE BRAND SURVIVES, WITH A SMALLER JOB. It documents which values came from here and keeps an
// accidental raw string from reaching a fixture parameter. It is no longer asked to carry a
// proof.
//
// THE HONEST CLAIM, narrowed to what actually executes: every INSERT, UPDATE, MERGE or COPY
// against `availability_slots` in this suite goes through `src/test/abc27SlotFixtures.ts`, which
// asks this registry first, so reuse is refused in EVERY run whatever the calling expression
// looked like; the static guard (`scripts/check-abc27-trainer-source-authority.mjs`) refuses
// DIRECT bypasses it can read, and makes no dataflow claim at all; and the suite's
// committed-residue census proves the end state clean. Nothing is claimed about mid-statement
// transient states, and nothing about DELETE, which cannot create an overlap namespace.
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

/*
 * ══ THE TWO RETIRED BRANDS, AND WHY THEY ARE NOT HERE ════════════════════════════════════════
 *
 * This module used to export two more brands. `SqlFragment` marked a text that had been lexed and
 * proved to be ONE SQL expression, so the static guard could admit it as an interpolation into a
 * slot statement. `SqlQuotedLiteral` marked a canonical UUID, for interpolation INSIDE quotes,
 * because a fragment that is one expression unquoted (`x', 'y`) is two expressions quoted.
 *
 * Both existed only to make INTERPOLATION into slot SQL safe, and each was defeated in turn:
 * a fragment closed one VALUES row and opened another (`x), (foreign_trainer, …`), and once
 * commas inside parentheses were admitted to fix that, a fragment reached an `unnest` alias
 * carrying `union all values (…)` — where the hole was a single word token, so the arm counter
 * never saw the `union` at all.
 *
 * There is no interpolation into slot SQL any more. `src/test/abc27SlotFixtures.ts` holds every
 * statement as a complete fixed literal and passes every value as a bound parameter, so nothing
 * needs to say what a text may safely become. The brands are retired rather than repaired: a
 * mechanism nothing uses is a mechanism that will be reached for again.
 */

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
 * What a refused value IS, said without ever consulting it.
 *
 * A message that interpolated the value would call the very method the refusal is about, so the
 * value never reaches a template here: only `typeof` and the two nullish identities do.
 */
const describeCaptured = (v: unknown): string => {
  if (v === null) return '`null`';
  if (v === undefined) return '`undefined`';
  const kind = typeof v;
  return kind === 'object' ? 'an object' : `a ${kind}`;
};

/**
 * ══ THE PRIMITIVE CAPTURE — ONE READ, ONE VALUE, AND NO SECOND COERCION ══════════════════════
 *
 * `assertSlotsNotForeign` SKIPS an element that is not a string, deliberately: several fixtures
 * pass a `null` or a ghost UUID on purpose, and the registry's job is to refuse a foreign OWNER,
 * not to police shapes. `node-postgres` does not skip those values. It calls a `toPostgres()` the
 * value carries, and it coerces the rest — so an argument the registry ignored still reaches the
 * server as a slot id. That was measured against the installed driver at the APPLY boundary, and
 * closed there with a seal rather than by changing what the frozen registry ignores. This is the
 * same move, made at the SLOT-FACTORY boundary, where it was still open:
 * `ownedSlot(someObjectWithToPostgres)` checked nothing and returned the object, which the driver
 * then serialized into `WHERE id = $1`.
 *
 * IT TAKES A VALUE, NOT A PROPERTY, AND THAT IS THE OTHER HALF. Reading `s.id` is where a getter
 * answers; a getter that answers `<mine>` to the check and `<yours>` to the send needs the
 * property to be read TWICE. Every caller here reads each caller-supplied property exactly once,
 * into a local, and hands that local to this function — so there is no property access inside it
 * at all, and the value it returns is the identical primitive its caller will send.
 *
 * WHAT IS REFUSED, AND WHY EACH MATTERS. An object (a `toPostgres`, a `Symbol.toPrimitive`, a
 * two-faced `toString`, a boxed `String`), a number, a bigint, a boolean, a symbol, a function, a
 * `Buffer` — every one is a value the ownership check skips and the driver still serializes.
 * `null` and `undefined` are refused too: an absent id has an explicit spelling at every call
 * site that admits one, and whether this call has an id is decided before it gets here.
 */
export function capturedId(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  throw new Error(
    `abc27 slot namespace: ${what} was handed ${describeCaptured(value)}, and only a primitive `
    + 'string may be validated and then sent. A value that is not one is SKIPPED by the ownership '
    + 'check and may still be serialized by the driver — `toPostgres()`, `Symbol.toPrimitive` and '
    + 'a two-faced `toString` are each a way to be checked as one thing and sent as another.');
}

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
  // A NON-STRING IS REFUSED HERE RATHER THAN COERCED. This used to open with `String(id)`, which
  // is a CALL into the value: an object answers it through `Symbol.toPrimitive`, `valueOf` or
  // `toString`, and a stateful one answers the next call differently. Every caller now hands a
  // primitive it captured once (see `capturedId` below), so the coercion has nothing left to do
  // — and refusing it outright is what makes that true rather than merely intended.
  if (typeof id !== 'string') {
    throw new Error(
      `abc27 trainer namespace: a ${describeCaptured(id)} is not a UUID and may not be coerced `
      + 'into one — a value that decides what it becomes decides what is written.');
  }
  const bare = id.trim().replace(/^\{(.*)\}$/, '$1').replace(/-/g, '').toLowerCase();
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
 * AND EXPORTED, BECAUSE ACQUISITION AND WRITING CAME APART. Every acquisition used to sit inline
 * at its write site, so "on every call" and "before every write" were the same sentence. Fixtures
 * now acquire a trainer once and hand it to the factory later — sometimes in a different
 * transaction, sometimes after a rollback discarded the row. The factory therefore ensures the
 * row itself, immediately before it writes, which is where the invariant actually has to hold.
 * (Measured: a fixture that acquired inside a rolled-back transaction and wrote afterwards failed
 * `availability_slots_trainer_id_fkey`, exactly as this note predicts.)
 *
 * REGISTRATION HAPPENS FIRST, ALWAYS. Every factory below acquires before it writes, so a
 * refusal costs no row and leaves no residue — which is the whole difference between preventing
 * the collision and noticing it.
 */
export async function ensureProfiles(
  client: pg.Client, ids: readonly IsolatedTrainerId[],
): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `INSERT INTO public.trainer_profiles(id) SELECT pg_catalog.unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
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
 * ══ THE CAPABILITY CHECK: OWNED, BY THE IDENTITY THAT IS RUNNING, RIGHT NOW ══════════════════
 *
 * The brand says a value CAME FROM here. It does not say the value is still the current test's,
 * and it does not survive contact with `any` — under this repository's `strict: false` an `any`
 * satisfies a branded parameter with no cast at all, so a static reader that trusts the type has
 * trusted an argument the compiler never checked.
 *
 * A REVIEW ROUND MADE THAT CONCRETE rather than theoretical. The static guard's brand rules were
 * defeated three ways in one round — a containing type (`{ t: IsolatedTrainerId }` annotated from
 * an `any`), an annotation-widening alias (`const a: string[] = brandedArray`, then mutate `a`),
 * and a getter (`{ get slots() { return SHARED } }`) that no syntactic follower read. Each was
 * patched, and patching them is the same losing game the regex guard lost: the hole moves.
 *
 * So the load-bearing check is no longer static. Every write surface asks THE REGISTRY, at the
 * moment it writes, whether this exact id belongs to the identity now running. A forged brand
 * buys nothing: an id the registry never issued is refused, and an id issued to another test is
 * refused. This runs in EVERY invocation of the suite — there is no lane, no mode and no
 * environment variable — which is the difference between a claim about constructions a reader
 * could classify and a claim about what actually executes.
 *
 * The static guard keeps a narrower and honest job: it refuses DIRECT bypasses of the write
 * surface. It no longer claims to prove a dataflow.
 */
export function requireOwnedByCurrentIdentity(id: string): IsolatedTrainerId {
  const key = canonicalTrainerId(id);
  const owner = owners.get(key);
  const identity = currentIdentity();
  if (owner === undefined) {
    throw new Error(
      `abc27 trainer namespace: ${key} was never acquired from the authority, so ${JSON.stringify(identity)} `
      + 'may not write with it — a trainer that no test owns is a shared namespace by another name.');
  }
  if (owner !== identity) {
    throw new Error(
      `abc27 trainer namespace: ${key} is owned by ${JSON.stringify(owner)}, and `
      + `${JSON.stringify(identity)} is writing — a trainer belongs to one test.`);
  }
  return key as IsolatedTrainerId;
}

/** The same capability check over a list, preserving order. */
export const requireAllOwnedByCurrentIdentity = (
  ids: readonly string[],
): IsolatedTrainerId[] => ids.map((id) => requireOwnedByCurrentIdentity(id));

/**
 * ══ AND THE SAME OWNERSHIP, FOR SLOT ROWS ════════════════════════════════════════════════════
 *
 * A trainer registry alone leaves one path open, and a review round named it: the apply and
 * extend cores derive the TARGET trainer from the SOURCE SLOTS the caller hands them. A test that
 * passes another test's slot id therefore writes into that test's overlap namespace without ever
 * naming a trainer — the value it supplied was a slot.
 *
 * WHY OWNERSHIP IS CHECKED AND ABSENCE IS NOT. Several cases deliberately pass ids that name no
 * row at all — a `randomUUID()` ghost, a `null`, a slot belonging to a foreign ACADEMY — because
 * "a caller who guesses a real UUID learns exactly what one who invents a UUID learns" is itself
 * a property under test. Demanding that every id be owned would refuse those fixtures while
 * proving nothing: an id no test holds cannot carry another test's namespace. So the rule is
 * exactly the collision it exists to stop — an id owned by SOMEONE ELSE is refused, and an id
 * nobody owns is left alone.
 */
const slotOwners = new Map<string, string>();

/** Register slot ids as this identity's. Refuses an id another identity already holds. */
export function noteSlotsOwned(ids: readonly string[]): void {
  const identity = currentIdentity();
  for (const id of ids) {
    if (id === null || id === undefined) continue;
    let key: string;
    try { key = canonicalTrainerId(id); } catch { continue; }
    const owner = slotOwners.get(key);
    if (owner === undefined) { slotOwners.set(key, identity); continue; }
    if (owner !== identity) {
      throw new Error(
        `abc27 slot namespace: slot ${key} is owned by ${JSON.stringify(owner)} and `
        + `${JSON.stringify(identity)} is claiming it — a slot belongs to one test.`);
    }
  }
}

/** Refuse a slot id this identity does not own, while leaving unowned ids alone. */
export function assertSlotsNotForeign(ids: readonly unknown[], what: string): void {
  const identity = currentIdentity();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    let key: string;
    try { key = canonicalTrainerId(id); } catch { continue; }
    const owner = slotOwners.get(key);
    if (owner === undefined || owner === identity) continue;
    throw new Error(
      `abc27 slot namespace: ${what} names slot ${key}, which is owned by ${JSON.stringify(owner)} `
      + `and not by ${JSON.stringify(identity)} — the apply and extend cores derive the TARGET `
      + "trainer from the source slots, so a foreign source writes into another test's namespace.");
  }
}

/** Who owns `slot`, or `undefined`. For the controls that measure the refusal. */
export const slotOwner = (id: string): string | undefined => {
  try { return slotOwners.get(canonicalTrainerId(id)); } catch { return undefined; }
};

/**
 * ══ AND THE DATABASE'S OWN ANSWER, WHICH IS THE ONLY AUTHORITATIVE ONE ═══════════════════════
 *
 * Everything above judges the ARGUMENT — the value a caller handed the factory before anything
 * was sent. That is necessary and it is not sufficient, and the gap has a name: between the
 * argument and the stored row sits the SERVER, where a `BEFORE` trigger may rewrite
 * `NEW.trainer_id`, a `SECURITY DEFINER` routine may run dynamic SQL, and a rule may redirect the
 * write entirely. The suite PLANTS such a trigger itself, deliberately, so this is not a
 * hypothetical class: it is one the fixtures already build.
 *
 * SO EVERY GUARDED WRITE READS BACK WHAT WAS ACTUALLY STORED, and the registry judges THAT. Two
 * shapes, one rule:
 *
 *   · a direct slot write returns its own rows — `RETURNING id, trainer_id` — so the read is the
 *     write's own statement and there is no second round trip and no second snapshot;
 *   · an apply CREATES its target slots on the server, so its entrypoint reads those rows back on
 *     THE SAME CONNECTION, inside whatever transaction the caller opened, immediately after the
 *     call returns.
 *
 * WHAT THIS IS NOT. It is not an interpreter: nothing here reads the server's SQL, its triggers or
 * its plans. It asks the one question a stored row can answer — *whose namespace is this row in?*
 * — which is exactly the property the whole authority exists for, and it asks it of the value
 * PostgreSQL actually holds rather than of the value JavaScript hoped it had sent.
 *
 * NO DATABASE OBJECT IS CREATED FOR IT. A `RETURNING` clause and one `SELECT` are the whole
 * mechanism; there is no trigger, no schema, no role and no grant, for the same reason the
 * registry itself owns nothing but a `Map`.
 */
const STORED_SLOT_ROWS = `SELECT id, trainer_id FROM public.availability_slots
 WHERE id = ANY($1::uuid[])`;

/** One row as the registry judged it: both values canonical, both proved to be primitive text. */
export interface StoredSlot { readonly id: string; readonly trainer: string }

/**
 * The sha256 of the read-back statement, published so a runtime control can recognise it among
 * what an entrypoint sent WITHOUT this module exporting a text anything could re-send.
 */
export const STORED_SLOT_ROWS_DIGEST =
  createHash('sha256').update(STORED_SLOT_ROWS).digest('hex');

/**
 * Judge the rows the server actually stored.
 *
 * `trainers`, WHEN GIVEN, IS THE STRONGEST FORM OF THE QUESTION. A write that NAMED a trainer
 * knows exactly which one it sent, so the stored value must be that one: a trigger that moved it
 * anywhere at all — to another test's trainer, or to one nobody owns — is caught. A write that
 * named no trainer cannot ask that, so it asks the property the registry exists for instead: the
 * row may not sit in ANOTHER identity's namespace. Both are asked whenever both can be.
 *
 * `claim` SEPARATES THE TWO KINDS OF WRITE. An INSERT may have let the server mint the id, so the
 * returned id is news and becomes this identity's. An UPDATE addressed a row that already
 * existed, and several fixtures legitimately edit a row NOBODY owns — claiming it there would
 * quietly annex it — so the stored id is held to the same not-foreign rule as the argument was.
 */
export function acceptStoredSlotRows(
  rows: readonly unknown[], what: string,
  o: { claim: boolean; trainers?: readonly string[] },
): StoredSlot[] {
  const identity = currentIdentity();
  const expected = o.trainers === undefined ? null
    : new Set(o.trainers.map((t) => canonicalTrainerId(capturedId(t, `${what}: a sent trainer`))));
  const seen: StoredSlot[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === null || typeof row !== 'object') {
      throw new Error(
        `abc27 slot namespace: ${what} read back ${describeCaptured(row)} where the server's own `
        + 'row belongs — a write whose result cannot be read is a write whose stored trainer '
        + 'namespace is unknown, and unknown is not clean.');
    }
    const r = row as Record<string, unknown>;
    const id = canonicalTrainerId(capturedId(r.id, `${what}: the stored id`));
    const trainer = canonicalTrainerId(capturedId(r.trainer_id, `${what}: the stored trainer_id`));
    if (expected !== null && !expected.has(trainer)) {
      throw new Error(
        `abc27 trainer namespace: ${what} stored slot ${id} under trainer ${trainer}, and this `
        + `call sent [${[...expected].join(', ')}] — the value PostgreSQL holds is not the value `
        + 'that was sent, which is what a BEFORE trigger rewriting `NEW.trainer_id` or a '
        + 'server-side dynamic statement looks like from here.');
    }
    const owner = owners.get(trainer);
    if (owner !== undefined && owner !== identity) {
      throw new Error(
        `abc27 trainer namespace: ${what} stored slot ${id} under trainer ${trainer}, which is `
        + `owned by ${JSON.stringify(owner)} and not by ${JSON.stringify(identity)} — the row the `
        + "server actually holds sits in another test's overlap namespace.");
    }
    if (o.claim) noteSlotsOwned([id]); else assertSlotsNotForeign([id], what);
    seen.push({ id, trainer });
  }
  return seen;
}

/**
 * Read back the slots an apply created or changed, on the caller's own connection, and judge them.
 *
 * THE ID LIST IS FILTERED EXACTLY AS `noteSlotsOwned` FILTERS ITS OWN. A deliberate `null` and a
 * text that is no UUID name no row and are passed over here as they are there; anything else that
 * is not a string is REFUSED, because that is the value class the driver serializes and the
 * ownership check skips. Reading with a different rule than the claim used would leave a gap
 * between what was claimed and what is verified, which is the only interesting kind of gap.
 *
 * AN EMPTY LIST SENDS NOTHING. An entrypoint that names no target — the wrapper refusal probe —
 * has nothing to read back, and a query that could only return zero rows is a round trip that
 * proves nothing.
 */
export async function verifyStoredSlots(
  client: pg.Client, ids: readonly unknown[], what: string,
): Promise<StoredSlot[]> {
  const keys: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const value = ids[i];
    if (value === null || value === undefined) continue;
    const text = capturedId(value, `${what}: a target id`);
    try { keys.push(canonicalTrainerId(text)); } catch { continue; }
  }
  if (keys.length === 0) return [];
  const { rows } = await client.query(STORED_SLOT_ROWS, [keys]);
  if (!Array.isArray(rows)) {
    throw new Error(
      `abc27 slot namespace: ${what} read back no row list at all, so the trainer namespace of `
      + 'what the server stored is unknown — and unknown is not clean.');
  }
  return acceptStoredSlotRows(rows, what, { claim: false });
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
