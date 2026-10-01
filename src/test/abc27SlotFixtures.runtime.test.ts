// ══ THE FACTORY REFUSES AT THE MOMENT IT WRITES ══════════════════════════════════════════════
//
// `src/test/abc27SlotFixtures.ts` is the only place a slot write is spelled, and the static guard
// proves that. This file proves the other half — the half that actually holds:
//
//   every entrypoint asks the ownership registry about the STRING it received, before it sends
//   anything to the server.
//
// WHY THAT IS THE HALF THAT HOLDS. The predecessor of this design proved, statically, that each
// write site bound `trainer_id` to a branded value. A review round produced three ways to acquire
// the brand with no cast at all under this repository's `strict: false` — a containing type, an
// array widened by annotation and mutated through the alias, and a getter that no syntactic
// follower evaluates — and a fourth way to smuggle a foreign trainer into a statement the reader
// had already classified. Every fix moved the hole.
//
// A registry lookup at execution time is immune to all four, because by the time it runs there is
// no expression left: there is a string, and either this test owns it or it does not. The
// fixtures below hand the factory exactly what those escapes would have produced.
//
// NO DATABASE. The client is a stub that records what it was asked to send, so the whole file
// costs milliseconds instead of a five-minute lineage replay — and a sensor that cheap is one
// that runs on every change rather than in a lane somebody has to remember.
//
// DELIBERATELY OUTSIDE THE STATIC GUARD'S PROGRAM. The guard reads five named files; this is not
// one of them, and `checkScopeDrift` refuses any other `src/test/abc27*` file that names the
// guarded relation beside a write verb. So this file never names it — which is also why the
// assertions below read the SHAPE of what was sent rather than quoting the statement back.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_IDENTITY, canonicalTrainerId, currentIdentity, declareTrainer,
  installTrainerAuthorityHooks, mintTrainerRange, newTrainerId, noteSlotsOwned, slotOwner,
  STORED_SLOT_ROWS_DIGEST, trainerOwner,
} from './abc27TrainerAuthority';
import * as FACTORY from './abc27SlotFixtures';
import {
  insertSlot, insertSlotSeries, insertTemplateSlot, insertTemplateSlotSeries,
  plantSourceDriftTrigger, setSlotBounds, setSlotCapacity, setSlotDuration, setSlotExtraCosts,
  setSlotLocation, setSlotLocationAndShiftTimes, setSlotParticipants, setSlotPrice,
  setSlotRatings, setSlotTrainer, setSlotTrainerAndLocation, shiftSlotTimes,
  shiftSlotTimesAndSetTrainer, shiftSlotTimesAndSetVisibility, SLOT_STATEMENT_DIGESTS,
} from './abc27SlotFixtures';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

installTrainerAuthorityHooks();

beforeAll(() => {
  foreignSlot = randomUUID();
  noteSlotsOwned([foreignSlot]);
});

/**
 * A client stub that records the statements the factory sends, in order.
 *
 * THE ROWS IT HANDS BACK CARRY DISTINCT IDS, and that is not cosmetic. The factory registers
 * every slot it writes to the current test, so a stub that answered with one fixed id would make
 * the SECOND test to use it a cross-test slot claim — and the registry would refuse it, correctly
 * and for a reason that has nothing to do with the case under test. (It did, on the first run of
 * this file, which is the mechanism proving itself in its own harness.)
 *
 * ══ AND THE ROW NOW CARRIES A `trainer_id`, BECAUSE THE FACTORY READS ONE BACK ══════════════
 *
 * Every statement now returns `id, trainer_id`, and the authority judges what came back — so a
 * stub that answered with no `trainer_id` at all would fail every successful call, which is
 * exactly what this file's own first run of the upgraded factory did. The stub is not a SQL
 * simulator and does not learn each statement's parameter positions — that would put the SAME
 * knowledge this file's own header says it avoids back into the mock. Instead it asks the
 * REGISTRY: among the values a call is about to send, whichever one the registry already
 * recognises as a TRAINER (via `trainerOwner`) is the trainer, because a slot id, a location, an
 * academy or a cyclus is never registered there — only a value that passed through
 * `newTrainerId`/`declareTrainer`/`mintTrainerRange` is. Arrays are unpacked one level, which is
 * what a lane's `uuid[]` parameter needs. When no value resolves — every setter that does not
 * name a trainer at all — a fresh, unregistered id stands in: unowned by construction, so the
 * authority's not-foreign check passes it without asserting anything about its identity.
 */
let stubRow = 0;
const trainerOf = (values: readonly unknown[]): string => {
  for (const v of values) {
    for (const candidate of Array.isArray(v) ? v : [v]) {
      if (typeof candidate === 'string' && trainerOwner(candidate) !== undefined) return candidate;
    }
  }
  return randomUUID();
};
const recordingClient = () => {
  const sent: Array<{ text: string; values: unknown[] }> = [];
  return {
    sent,
    client: {
      query: async (text: string, values: unknown[] = []) => {
        sent.push({ text, values });
        stubRow += 1;
        return { rows: [{ id: `aa000000-0000-4000-8000-${String(stubRow).padStart(12, '0')}`,
          trainer_id: trainerOf(values) }] };
      },
    } as never,
  };
};

const AT_ONE_DAY = { at: 'fromNow' as const, days: 1 };
const AT_ONE_DAY_AN_HOUR = { at: 'fromNow' as const, days: 1, minutes: 60 };
const ACADEMY = '11111111-1111-4111-8111-111111111111';

/**
 * A slot id belonging to an identity NO TEST can be — the cross-test slot edit, made independent
 * of test order.
 *
 * It used to be written by whichever test ran first, so running a later case alone left it `''`
 * and those cases stopped testing a foreign identity at all while still passing for other
 * reasons. A `beforeAll` runs under the BOOTSTRAP identity, which no test ever holds, so the id is
 * foreign to every case here in any order and however few of them run.
 */
let foreignSlot = '';

/**
 * Every writing entrypoint the byte-equality control below drives, named once so the export pin
 * and the exercise list are the same list rather than two that can drift apart.
 */
const EXERCISED = [
  'insertSlot', 'insertTemplateSlot', 'insertSlotSeries', 'insertTemplateSlotSeries',
  'shiftSlotTimes', 'shiftSlotTimesAndSetTrainer', 'shiftSlotTimesAndSetVisibility',
  'setSlotLocationAndShiftTimes', 'setSlotTrainer', 'setSlotTrainerAndLocation',
  'setSlotLocation', 'setSlotCapacity', 'setSlotParticipants', 'setSlotRatings',
  'setSlotPrice', 'setSlotExtraCosts', 'setSlotDuration', 'setSlotBounds',
  'plantSourceDriftTrigger',
];

describe('ABC-27 slot factory — a trainer the registry never issued is refused before any send', () => {
  it('writes nothing at all when the trainer is forged', async () => {
    const { client, sent } = recordingClient();
    // A WELL-FORMED UUID THAT NO TEST ACQUIRED. This is precisely what an `as IsolatedTrainerId`
    // cast, an `any` argument, a containing-type annotation or a getter would deliver: the type
    // system is satisfied, and the value is a stranger.
    await expect(insertSlot(client, {
      trainer: 'c0000000-0000-4000-8000-00000000c001', academy: ACADEMY,
      start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    })).rejects.toThrow(/was never acquired from the authority/);
    expect(sent, 'a refused write reaches the server not at all').toEqual([]);
  });

  it('refuses a trainer that belongs to another test, and says whose it is', async () => {
    const { client } = recordingClient();
    await declareTrainer(client, 'c0000000-0000-4000-8000-00000000c002');
    // THE ENSURE NEVER RUNS FOR A REFUSED TRAINER, which is what the `sent` assertions below
    // measure: the capability is checked before the referential row is touched, so a refusal
    // costs nothing at all — not even an ON CONFLICT DO NOTHING no-op.
    // The SAME test may write with it; the assertion that another may not is the next test.
    expect(await insertSlot(client, {
      trainer: 'c0000000-0000-4000-8000-00000000c002', academy: ACADEMY,
      start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    })).toBeTruthy();
  });

  it('and the next test really is refused it', async () => {
    const { client, sent } = recordingClient();
    await expect(insertSlot(client, {
      trainer: 'c0000000-0000-4000-8000-00000000c002', academy: ACADEMY,
      start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    })).rejects.toThrow(/refuses a trainer that belongs to another test/);
    expect(sent).toEqual([]);
  });

  it('checks EVERY trainer of a lane, not only the first', async () => {
    const { client, sent } = recordingClient();
    const mine = await mintTrainerRange(client, 'c0000000-0000-4000-8001-', 3);
    sent.length = 0;
    // THE POISONED-ALIAS SHAPE, arriving as data. A branded array widened by annotation and then
    // mutated is a value the checker still calls branded; the registry reads the elements.
    await expect(insertSlotSeries(client, {
      trainers: [...mine, 'c0000000-0000-4000-8000-00000000c0ff'],
      academy: ACADEMY, startMinutes: 0, endMinutes: 60, stepMinutes: 60,
    })).rejects.toThrow(/was never acquired from the authority/);
    expect(sent).toEqual([]);
  });

  it('holds the cross-test slot under an identity no test can be', () => {
    // THE PREMISE OF EVERY FOREIGN-SUBJECT CASE BELOW, asserted rather than assumed. The hook
    // minted it under the BOOTSTRAP identity, which no test ever holds — so the id is foreign to
    // every case here whatever order they run in, and running one alone still tests the property.
    expect(foreignSlot).toMatch(/^[0-9a-f-]{36}$/);
    expect(slotOwner(foreignSlot)).toBe(BOOTSTRAP_IDENTITY);
    expect(currentIdentity()).not.toBe(BOOTSTRAP_IDENTITY);
  });

  it('claims the slot it writes, so the next test may not edit it', async () => {
    // THE FACTORY CLAIMS WHAT IT WROTE. This is the property; the id every LATER case treats as
    // foreign is minted in the hook above, not here, so nothing below depends on this having run.
    const { client } = recordingClient();
    const trainer = await newTrainerId(client);
    const mine = await insertSlot(client, {
      trainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });
    expect(slotOwner(mine), 'the factory registered the row it wrote').toBe(currentIdentity());
    // The SAME test may of course edit it.
    await shiftSlotTimes(client, mine, { minutes: 30 });
  });

  it('refuses an UPDATE aimed at another test\'s slot, even with no trainer in sight', async () => {
    // ══ THE ONE A REVIEW ROUND FOUND ═════════════════════════════════════════════════════════
    //
    // The earlier rule was "an UPDATE needs no capability check unless it MOVES the trainer".
    // This is the counter-example in one line: shifting another test's slot walks it along ITS
    // OWN trainer's calendar, which is the overlap collision the whole design exists to prevent,
    // through a helper that never names a trainer at all. Every setter is held to the slot now.
    const { client, sent } = recordingClient();
    // THE REFUSAL NAMES THE BOOTSTRAP IDENTITY, which is the point of minting the id in a hook:
    // the owner is one no test can ever be, so this reads the same however few cases run and in
    // whatever order — rather than naming whichever test happened to go first.
    await expect(shiftSlotTimes(client, foreignSlot, { minutes: 60 }))
      .rejects.toThrow(/is owned by "<bootstrap/);
    await expect(setSlotCapacity(client, foreignSlot, 9)).rejects.toThrow(/is owned by/);
    await expect(setSlotPrice(client, foreignSlot, '1.00')).rejects.toThrow(/is owned by/);
    await expect(setSlotDuration(client, foreignSlot, { minutes: 30 })).rejects.toThrow(/is owned by/);
    await expect(plantSourceDriftTrigger(client, { label: 'x', slot: foreignSlot, price: '1.00' }))
      .rejects.toThrow(/is owned by/);
    expect(sent, 'not one of them reached the server').toEqual([]);
  });

  it('holds the trainer-MOVING update to the same check', async () => {
    const { client, sent } = recordingClient();
    await expect(setSlotTrainer(client, 'aa000000-0000-4000-8000-0000000000ff',
      'c0000000-0000-4000-8000-00000000c003'))
      .rejects.toThrow(/was never acquired from the authority/);
    expect(sent, 'moving a slot onto a foreign trainer is the collision in one statement')
      .toEqual([]);
  });
});

describe('ABC-27 slot factory — what it sends is fixed, and the values are bound', () => {
  it('sends the statement constant unchanged, with the trainer as a parameter', async () => {
    const { client, sent } = recordingClient();
    const trainer = await newTrainerId(client);
    sent.length = 0;
    await insertSlot(client, {
      trainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });
    // TWO STATEMENTS, IN THIS ORDER: the referential row is ensured, then the slot is written.
    // The ensure belongs at the WRITE rather than at the acquisition because fixtures acquire a
    // trainer once and write later — sometimes after a rollback discarded the row.
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('trainer_profiles');
    expect(sent[0].text).toContain('ON CONFLICT DO NOTHING');
    // THE SLOT TEXT'S DIGEST IS THE PINNED CONSTANT'S, BYTE FOR BYTE OF WHAT WAS HASHED. Not
    // "contains" — identical. A factory that built its statement per call would be the
    // interpolation this design exists to remove, and the static guard cannot see what a
    // function assembles at run time. The digest is what this file may compare against: the raw
    // text stays inside the module, exactly as the apply catalogue's does.
    expect(sha256(sent[1].text)).toBe(SLOT_STATEMENT_DIGESTS.SLOT_BASIC_INSERT);
    // ...and the trainer travelled as a VALUE, in the position the statement binds.
    expect(sent[1].values[1]).toBe(trainer);
  });

  it('publishes a digest per statement, and a digest is not a text', () => {
    // ══ THE PROPERTY THE STATIC GUARD ASSERTS, RESTATED WHERE THE VALUES ARE ═════════════════
    //
    // G2 already proves, by reading the SOURCE with PostgreSQL's own grammar, that every
    // constant inside the module is a plain literal with no interpolation of any kind — that is
    // a stronger and statically-enforced claim than anything a runtime import of the raw text
    // could add, so this file no longer imports the text to re-check it. What it CAN and does
    // check is the shape of what is published: a sha256 hex digest, not a statement — a
    // constant that stopped being a digest (started re-exporting a raw text, say) is what this
    // sees.
    for (const [name, digest] of Object.entries(SLOT_STATEMENT_DIGESTS)) {
      expect(digest, `${name} must publish a sha256 hex digest, not a statement`)
        .toMatch(/^[0-9a-f]{64}$/);
    }
    // AND THE INVENTORY IS RESTATED HERE TOO, so deleting a constant fails in two places.
    // TWENTY, not nineteen: the guard counts slot WRITES, and `PLANT_DRIFT_TRIGGER` is a trigger
    // definition. The two numbers are deliberately different and each is pinned where it means
    // something.
    expect(Object.keys(SLOT_STATEMENT_DIGESTS)).toHaveLength(20);
    // ...AND EVERY DIGEST IS DISTINCT. A collision here would mean two different statements
    // share one digest, which the byte-equality drive below could not then tell apart.
    expect(new Set(Object.values(SLOT_STATEMENT_DIGESTS)).size,
      'every statement must have its own digest').toBe(20);
  });

  it('has exactly these entrypoints — a new export cannot arrive unexercised', () => {
    // ══ "EVERY ENTRYPOINT" IS A CLAIM ABOUT THE MODULE, NOT ABOUT THIS TEST ══════════════════
    //
    // A round-2 review made the gap concrete: the byte-equality control below invokes a list of
    // entrypoints it names itself, so `export const unsafeUpdate = (c, id) =>
    // c.query(SLOT_UPDATE_CAPACITY, [id, 9])` would add no SQL literal, no inventory site and no
    // new constant — every static pin unchanged, every existing constant still sent — and the
    // control would simply never call it.
    //
    // So the module's own exported surface is enumerated and pinned. A new function export fails
    // here, which is where a reader is asked whether it needs the capability checks.
    // THE WHOLE SURFACE, not just the function-valued half. A round-4 review wrapped the escape in
    // an object — `export const unsafe = { update: (c, id) => c.query(…) }` — which a
    // `typeof === 'function'` filter drops on the floor. Every export of every kind is pinned.
    expect(Object.keys(FACTORY).sort()).toEqual([
      'SLOT_STATEMENT_DIGESTS',
      'insertSlot', 'insertSlotSeries', 'insertTemplateSlot', 'insertTemplateSlotSeries',
      'plantSourceDriftTrigger', 'setSlotBounds', 'setSlotCapacity', 'setSlotDuration',
      'setSlotExtraCosts', 'setSlotLocation', 'setSlotLocationAndShiftTimes',
      'setSlotParticipants', 'setSlotPrice', 'setSlotRatings', 'setSlotTrainer',
      'setSlotTrainerAndLocation', 'shiftSlotTimes', 'shiftSlotTimesAndSetTrainer',
      'shiftSlotTimesAndSetVisibility', 'writingIdentity',
    ]);
    const exported = Object.entries(FACTORY)
      .filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
    expect(exported).toEqual([
      'insertSlot', 'insertSlotSeries', 'insertTemplateSlot', 'insertTemplateSlotSeries',
      'plantSourceDriftTrigger', 'setSlotBounds', 'setSlotCapacity', 'setSlotDuration',
      'setSlotExtraCosts', 'setSlotLocation', 'setSlotLocationAndShiftTimes',
      'setSlotParticipants', 'setSlotPrice', 'setSlotRatings', 'setSlotTrainer',
      'setSlotTrainerAndLocation', 'shiftSlotTimes', 'shiftSlotTimesAndSetTrainer',
      'shiftSlotTimesAndSetVisibility', 'writingIdentity',
    ]);
    // ...AND THE ONE BELOW EXERCISES ALL OF THEM BUT THE PURE READER, so the two lists together
    // say "every entrypoint" rather than "the ones this test remembered".
    expect(EXERCISED.concat(['writingIdentity']).sort()).toEqual(exported);
  });

  it('refuses a foreign subject from EVERY writing entrypoint, one case each', async () => {
    // ══ INVOKING AN EXPORT IS NOT THE SAME AS ITS CHECK HAVING RUN ═══════════════════════════
    //
    // A round-3 review drew the line exactly: the export pin proves the surface, and the
    // byte-equality control proves each entrypoint sends its own constant — but deleting
    // `await ownedSlot(id)` from one setter leaves the export list unchanged, the statement bytes
    // unchanged, and the control still green, while a foreign-slot UPDATE reaches the server.
    //
    // So every writing entrypoint is driven ONCE with a subject this test does not own — a
    // foreign SLOT for the setters and the drift plant, a foreign TRAINER for the inserts — and
    // must refuse before sending anything. The matrix is keyed by export name and compared
    // against the pinned surface, so a new entrypoint has to appear here too.
    const FOREIGN_TRAINER = 'c0000000-0000-4000-8000-00000000cf01';
    const LOC = '11111111-2222-4333-8444-555555555555';
    const { client: setup } = recordingClient();
    const ownTrainer = await newTrainerId(setup);
    const bySubject: Record<string, (c: never) => Promise<unknown>> = {
      insertSlot: (c) => insertSlot(c, { trainer: FOREIGN_TRAINER, academy: ACADEMY,
        start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR }),
      insertTemplateSlot: (c) => insertTemplateSlot(c, { trainer: FOREIGN_TRAINER,
        academy: ACADEMY, location: LOC, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR }),
      insertSlotSeries: (c) => insertSlotSeries(c, { trainers: [FOREIGN_TRAINER],
        academy: ACADEMY, startMinutes: 0, endMinutes: 60, stepMinutes: 60 }),
      insertTemplateSlotSeries: (c) => insertTemplateSlotSeries(c, { trainers: [FOREIGN_TRAINER],
        academy: ACADEMY, location: LOC, startIso: '2027-01-01T10:00:00Z',
        endIso: '2027-01-01T11:00:00Z', stepMinutes: 1 }),
      shiftSlotTimes: (c) => shiftSlotTimes(c, foreignSlot, { minutes: 1 }),
      // ONE CAPABILITY PER CASE. A round-4 review pointed out that handing the trainer-moving
      // setters BOTH a foreign slot and a foreign trainer lets either check carry the refusal —
      // so deleting the slot check left the matrix green. These three get a foreign SLOT and a
      // trainer this test DOES own, so only the slot check can produce the rejection; the
      // trainer half is covered by `alsoForeignTrainer` below.
      shiftSlotTimesAndSetTrainer: (c) =>
        shiftSlotTimesAndSetTrainer(c, foreignSlot, { minutes: 1 }, ownTrainer),
      shiftSlotTimesAndSetVisibility: (c) =>
        shiftSlotTimesAndSetVisibility(c, foreignSlot, { minutes: 1 }, false),
      setSlotLocationAndShiftTimes: (c) =>
        setSlotLocationAndShiftTimes(c, foreignSlot, LOC, { minutes: 1 }),
      setSlotTrainer: (c) => setSlotTrainer(c, foreignSlot, ownTrainer),
      setSlotTrainerAndLocation: (c) =>
        setSlotTrainerAndLocation(c, foreignSlot, ownTrainer, LOC),
      setSlotLocation: (c) => setSlotLocation(c, foreignSlot, LOC),
      setSlotCapacity: (c) => setSlotCapacity(c, foreignSlot, 9),
      setSlotParticipants: (c) => setSlotParticipants(c, foreignSlot, 1, 2),
      setSlotRatings: (c) => setSlotRatings(c, foreignSlot, '1.0', '3.0'),
      setSlotPrice: (c) => setSlotPrice(c, foreignSlot, '1.00'),
      setSlotExtraCosts: (c) => setSlotExtraCosts(c, foreignSlot, '[]'),
      setSlotDuration: (c) => setSlotDuration(c, foreignSlot, { minutes: 30 }),
      setSlotBounds: (c) =>
        setSlotBounds(c, foreignSlot, '2027-01-01T10:00:00Z', '2027-01-01T11:00:00Z'),
      plantSourceDriftTrigger: (c) =>
        plantSourceDriftTrigger(c, { label: 'x', slot: foreignSlot, price: '1.00' }),
    };
    // THE MATRIX IS THE SURFACE. If these two lists ever differ, an entrypoint exists that no
    // refusal case drives — which is the whole finding this control answers.
    expect(Object.keys(bySubject).sort()).toEqual([...EXERCISED].sort());

    for (const [name, drive] of Object.entries(bySubject)) {
      const { client, sent } = recordingClient();
      const outcome = await drive(client as never).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${name} accepted a subject this test does not own`)
        .toMatch(/was never acquired from the authority|is owned by/);
      expect(sent, `${name} sent something before refusing`).toEqual([]);
    }

    // ...AND THE TRAINER HALF OF THE THREE THAT TAKE BOTH, so each capability has a case that
    // ONLY it can satisfy. `ownSlot` is this test's, so the slot check cannot be what refuses.
    const { client: mineClient } = recordingClient();
    const ownSlot = await insertSlot(mineClient, {
      trainer: ownTrainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });
    const alsoForeignTrainer: Record<string, (c: never) => Promise<unknown>> = {
      shiftSlotTimesAndSetTrainer: (c) =>
        shiftSlotTimesAndSetTrainer(c, ownSlot, { minutes: 1 }, FOREIGN_TRAINER),
      setSlotTrainer: (c) => setSlotTrainer(c, ownSlot, FOREIGN_TRAINER),
      setSlotTrainerAndLocation: (c) =>
        setSlotTrainerAndLocation(c, ownSlot, FOREIGN_TRAINER, LOC),
    };
    for (const [name, drive] of Object.entries(alsoForeignTrainer)) {
      const { client, sent } = recordingClient();
      const outcome = await drive(client as never).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${name} accepted a TRAINER this test does not own`)
        .toMatch(/was never acquired from the authority/);
      expect(sent, `${name} sent something before refusing`).toEqual([]);
    }

    // ...AND THE CALLER-SUPPLIED INSERT ID, which is a third capability the inserts carry.
    //
    // BOTH OF THEM. A round-5 review pointed out that only `insertSlot` had an id case: removing
    // `insertTemplateSlot`'s check left every control green, because its ordinary matrix entry
    // supplies no id and rejects on the foreign TRAINER instead. The two id-taking entrypoints
    // are named in a list that is compared against the module's own surface, so a third one
    // cannot arrive without a case.
    const ID_TAKING: Record<string, (c: never, id: string) => Promise<unknown>> = {
      insertSlot: (c, id) => insertSlot(c, { id, trainer: ownTrainer, academy: ACADEMY,
        start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR }),
      insertTemplateSlot: (c, id) => insertTemplateSlot(c, { id, trainer: ownTrainer,
        academy: ACADEMY, location: LOC, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR }),
    };
    // ── AND THE COMPLETENESS PROOF IS A RUNTIME SWEEP, NOT A DERIVATION ─────────────────────
    //
    // WHAT THIS REPLACES, AND WHY. This used to read the factory's own source and derive which
    // exported entrypoints declare an option shape carrying an `id`, so that a third one could
    // not arrive with no case. The derivation had to model TypeScript's declaration merging,
    // heritage clauses, class members, quoted and computed property names — and a review round
    // found the next hole anyway: `constructor(public id?: string)` declares an instance property
    // through a PARAMETER, the member walk reads `members[*].name`, a constructor has no name,
    // and its parameters were never visited. The shape was decided as carrying no id rather than
    // reported as unreadable, which is the certifying direction and the exact omission shape this
    // control exists to close.
    //
    // There is no oracle for "which shapes does this type declare", so the question is gone. The
    // sweep below asks a question with an answer instead: hand EVERY entrypoint on the pinned
    // export list a foreign id smuggled into its options — or, where it takes none, as an extra
    // argument — and demand that the id reach NO SENT TEXT AND NO SENT VALUE, or that the
    // authority refuse before anything is sent. An entrypoint that reads a smuggled id either
    // USES it (caught here, on the evaluated bytes, whatever spelling declared it) or REFUSES
    // (caught here too, and correct). A constructor parameter property, a merged declaration, an
    // inherited member and any future spelling all land in the same two outcomes, because none of
    // them changes what arrives at the wire.
    const sweepOwnSlot = await insertSlot(recordingClient().client as never, {
      trainer: ownTrainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });
    type Smuggle = Record<string, unknown>;
    const SWEEP: Record<string, (c: never, x: Smuggle) => Promise<unknown>> = {
      insertSlot: (c, x) => insertSlot(c, { trainer: ownTrainer, academy: ACADEMY,
        start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR, ...x } as never),
      insertTemplateSlot: (c, x) => insertTemplateSlot(c, { trainer: ownTrainer,
        academy: ACADEMY, location: LOC, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
        ...x } as never),
      insertSlotSeries: (c, x) => insertSlotSeries(c, { trainers: [ownTrainer],
        academy: ACADEMY, startMinutes: 0, endMinutes: 60, stepMinutes: 60, ...x } as never),
      insertTemplateSlotSeries: (c, x) => insertTemplateSlotSeries(c, { trainers: [ownTrainer],
        academy: ACADEMY, location: LOC, startIso: '2027-01-01T10:00:00Z',
        endIso: '2027-01-01T11:00:00Z', stepMinutes: 1, ...x } as never),
      shiftSlotTimes: (c, x) => shiftSlotTimes(c, sweepOwnSlot, { minutes: 1, ...x }),
      shiftSlotTimesAndSetTrainer: (c, x) =>
        shiftSlotTimesAndSetTrainer(c, sweepOwnSlot, { minutes: 1, ...x }, ownTrainer),
      shiftSlotTimesAndSetVisibility: (c, x) =>
        shiftSlotTimesAndSetVisibility(c, sweepOwnSlot, { minutes: 1, ...x }, false),
      setSlotLocationAndShiftTimes: (c, x) =>
        setSlotLocationAndShiftTimes(c, sweepOwnSlot, LOC, { minutes: 1, ...x }),
      setSlotDuration: (c, x) => setSlotDuration(c, sweepOwnSlot, { minutes: 30, ...x }),
      plantSourceDriftTrigger: (c, x) =>
        plantSourceDriftTrigger(c, { label: 'x', slot: sweepOwnSlot, price: '1.00', ...x }),
      // ── THE ENTRYPOINTS WITH NO OPTION SHAPE AT ALL ────────────────────────────────────────
      //
      // Their parameters are scalars, so there is nothing to smuggle THROUGH; the id is passed as
      // a trailing argument JavaScript ignores, and the assertion still holds — an extra argument
      // reaches no statement either. That is a decided answer rather than a skipped one, and it is
      // why this matrix covers the whole export list instead of a derived subset of it.
      setSlotTrainer: (c, x) => (setSlotTrainer as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, ownTrainer, x),
      setSlotTrainerAndLocation: (c, x) => (setSlotTrainerAndLocation as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, ownTrainer, LOC, x),
      setSlotLocation: (c, x) => (setSlotLocation as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, LOC, x),
      setSlotCapacity: (c, x) => (setSlotCapacity as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, 9, x),
      setSlotParticipants: (c, x) => (setSlotParticipants as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, 1, 2, x),
      setSlotRatings: (c, x) => (setSlotRatings as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, '1.0', '3.0', x),
      setSlotPrice: (c, x) => (setSlotPrice as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, '1.00', x),
      setSlotExtraCosts: (c, x) => (setSlotExtraCosts as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot, '[]', x),
      setSlotBounds: (c, x) => (setSlotBounds as never as
        (...a: unknown[]) => Promise<unknown>)(c, sweepOwnSlot,
        '2027-01-01T10:00:00Z', '2027-01-01T11:00:00Z', x),
      // ── AND THE ONE EXPORT THE OTHER CONTROLS CALL A PURE READER ─────────────────────────
      //
      // `writingIdentity` takes no connection and sends nothing, so the refusal matrix and the
      // byte-equality driver both skip it — and a review round pointed out what that costs: give
      // it an optional client and an optional id and it becomes an unchecked writer without
      // moving the export pin, the statement inventory or either of those two lists. It is driven
      // here like everything else. It cannot send today, which is the point: if it ever can, this
      // is where that shows up.
      writingIdentity: async (c, x) =>
        (FACTORY.writingIdentity as never as (...a: unknown[]) => unknown)(c, x),
    };
    // THE SWEEP IS THE WHOLE SURFACE. Compared against the module's own FUNCTION exports rather
    // than against the byte-equality driver's list, so an entrypoint cannot arrive without a
    // case — which is the completeness the deleted derivation was for, held by an inventory that
    // is read off the module instead of remembered beside it.
    expect(Object.keys(SWEEP).sort()).toEqual(Object.entries(FACTORY)
      .filter(([, v]) => typeof v === 'function').map(([k]) => k).sort());
    for (const [name, drive] of Object.entries(SWEEP)) {
      const { client: sweepClient, sent: sweepSent } = recordingClient();
      const outcome = await drive(sweepClient as never, { id: foreignSlot })
        .then(() => 'accepted', (e: Error) => e.message);
      if (outcome !== 'accepted') {
        // REFUSED BEFORE SENDING is the other acceptable answer, and it is what the two
        // id-taking entrypoints do — so this branch is exercised rather than hypothetical.
        expect(outcome, `${name} refused for a reason other than the smuggled id`)
          .toMatch(/is owned by/);
        expect(sweepSent, `${name} sent something before refusing a smuggled id`).toEqual([]);
        continue;
      }
      // ...OR THE ID NEVER ARRIVED. Both halves: no statement TEXT carries it (which would mean
      // it was interpolated) and no bound VALUE is it (which would mean it was passed through).
      //
      // COMPARED AS UUIDS, NOT AS STRINGS. A review round pointed out that an exact-string
      // comparison misses every spelling PostgreSQL folds back to the same value — an upper-cased
      // id, a braced one, an unhyphenated one — and misses a value nested one level deeper than
      // the reader looked. Every string anywhere in the sent values is canonicalised and compared
      // to the canonical foreign id, and the statement text is searched for any UUID-shaped run
      // and each of those canonicalised too. A value that is not a scalar at all is a finding in
      // itself: the registry SKIPS it and the driver may still serialize it.
      const foreignKey = canonicalTrainerId(foreignSlot);
      const canonicalOrNull = (v: unknown): string | null => {
        if (typeof v !== 'string') return null;
        try { return canonicalTrainerId(v); } catch { return null; }
      };
      // THE COMPARISON IS CANONICAL, STATED RATHER THAN ASSUMED. Nothing in the tree smuggles an
      // upper-cased or braced id today, so weakening this to a string equality would change no
      // verdict any other control can see — the dormant-tripwire shape. It is asserted here.
      expect([canonicalOrNull(foreignSlot.toUpperCase()), canonicalOrNull(`{${foreignSlot}}`),
        canonicalOrNull(foreignSlot.replace(/-/g, '')), canonicalOrNull('not-a-uuid')],
      'every spelling PostgreSQL folds to one value must fold to one value here')
        .toEqual([foreignKey, foreignKey, foreignKey, null]);
      const strings = (v: unknown, depth = 0): unknown[] => (depth > 4 || v === null
        || typeof v !== 'object' ? [v] : Object.values(v as Record<string, unknown>)
        .flatMap((inner) => strings(inner, depth + 1)));
      for (const { text, values } of sweepSent) {
        const inText = (text.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g) ?? [])
          .map(canonicalOrNull);
        expect(inText.includes(foreignKey),
          `${name} interpolated a smuggled foreign id into a statement`).toBe(false);
        const flat = values.flatMap((v) => strings(v));
        expect(flat.map(canonicalOrNull).includes(foreignKey),
          `${name} bound a smuggled foreign id as a value`).toBe(false);
        expect(flat.filter((v) => v !== null && v !== undefined
          && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean'
          && !Buffer.isBuffer(v)),
        `${name} bound a value the ownership check SKIPS and the driver may still serialize`)
          .toEqual([]);
      }
    }
    // AND THE SWEEP IS NOT VACUOUS: at least one entrypoint really did refuse the smuggled id,
    // so "no entrypoint used it" is not the same sentence as "nothing was driven".
    const refusedSmuggled: string[] = [];
    for (const [name, drive] of Object.entries(SWEEP)) {
      const { client: probeClient } = recordingClient();
      const outcome = await drive(probeClient as never, { id: foreignSlot })
        .then(() => 'accepted', () => 'refused');
      if (outcome === 'refused') refusedSmuggled.push(name);
    }
    expect(refusedSmuggled.sort(),
      'the id-taking entrypoints are the ones that must refuse a smuggled foreign id')
      .toEqual(Object.keys(ID_TAKING).sort());
    for (const [name, drive] of Object.entries(ID_TAKING)) {
      const { client: idClient, sent: idSent } = recordingClient();
      const outcome = await drive(idClient as never, foreignSlot)
        .then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${name} accepted a named id another test owns`).toMatch(/is owned by/);
      expect(idSent, `${name} sent something before refusing a named foreign id`).toEqual([]);
    }
  });

  it('sends a statement byte-identical to an exported constant, from EVERY entrypoint', async () => {
    // ══ THE GUARD READS A LITERAL; THIS READS WHAT IS SENT ═══════════════════════════════════
    //
    // A round-1 review named the gap precisely: the static guard proves the CONSTANTS are plain,
    // and byte-equality was pinned for `insertSlot` alone. Nothing tied the other eighteen
    // entrypoints to their constants, so `SLOT_UPDATE_PRICE.replace(…)` inside an entrypoint
    // would send a statement the guard had audited in a different form and never see.
    //
    // Every entrypoint is driven here and every text it sends must hash to one of the pinned
    // digests — or be the `trainer_profiles` upsert, the `set_config` call, or the authority's
    // own read-back SELECT (recognised by ITS digest too, never by naming the relation), none of
    // which is a slot statement. Comparing DIGESTS rather than the raw constants is the same
    // tightening `SLOT_STATEMENT_DIGESTS` makes at the module boundary: this file cannot hold the
    // raw texts to compare against even if it wanted to, so a modified constant is a different
    // hash rather than a different string, and nothing here ever prints the SQL itself.
    const inventoryDigests = new Set(Object.values(SLOT_STATEMENT_DIGESTS));
    const { client, sent } = recordingClient();
    const trainer = await newTrainerId(client);
    const other = await newTrainerId(client);
    const lane = await mintTrainerRange(client, 'c0000000-0000-4000-8002-', 2);
    const LOC = '11111111-2222-4333-8444-555555555555';
    // CLEARED BEFORE THE FIRST ENTRYPOINT, not after: the acquisitions above send the authority's
    // own profile upserts, and the slot INSERT below is one of the texts under test.
    sent.length = 0;
    const slot = await insertSlot(client, {
      trainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });

    await insertTemplateSlot(client, {
      trainer, academy: ACADEMY, location: LOC, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    });
    await insertSlotSeries(client, {
      trainers: lane, academy: ACADEMY, startMinutes: 0, endMinutes: 60, stepMinutes: 60,
    });
    await insertTemplateSlotSeries(client, {
      trainers: lane, academy: ACADEMY, location: LOC,
      startIso: '2027-01-01T10:00:00Z', endIso: '2027-01-01T11:00:00Z', stepMinutes: 1,
    });
    await shiftSlotTimes(client, slot, { minutes: 1 });
    await shiftSlotTimesAndSetTrainer(client, slot, { minutes: 1 }, other);
    await shiftSlotTimesAndSetVisibility(client, slot, { minutes: 1 }, false);
    await setSlotLocationAndShiftTimes(client, slot, LOC, { minutes: 1 });
    await setSlotTrainer(client, slot, other);
    await setSlotTrainerAndLocation(client, slot, other, LOC);
    await setSlotLocation(client, slot, LOC);
    await setSlotCapacity(client, slot, 6);
    await setSlotParticipants(client, slot, 2, 4);
    await setSlotRatings(client, slot, '1.0', '3.0');
    await setSlotPrice(client, slot, '12.50');
    await setSlotExtraCosts(client, slot, '[]');
    await setSlotDuration(client, slot, { minutes: 60 });
    await setSlotBounds(client, slot, '2027-01-01T10:00:00Z', '2027-01-01T11:00:00Z');
    await plantSourceDriftTrigger(client, { label: 'x', slot, price: '1.00' });

    // THE AUTHORITY'S OWN READ-BACK IS FILTERED OUT BY DIGEST, NOT BY NAMING THE RELATION. Every
    // write entrypoint above now reads back what it stored (through the statement's own
    // `RETURNING`, or — for the drift plant — through `verifyStoredSlots`'s one extra round
    // trip), and that extra SELECT is the authority's, not the factory's twenty. Matching it by
    // its pinned digest keeps this file from ever having to spell the table name to exclude it.
    const slotTexts = sent.map((q) => q.text)
      .filter((t) => !t.includes('trainer_profiles') && !t.startsWith('SELECT set_config')
        && sha256(t) !== STORED_SLOT_ROWS_DIGEST);
    expect(slotTexts.length, 'every entrypoint sent something').toBeGreaterThan(18);
    const sentDigests = new Set(slotTexts.map(sha256));
    for (const text of slotTexts) {
      expect(inventoryDigests.has(sha256(text)),
        'a sent statement\'s digest is not in the pinned inventory').toBe(true);
    }
    // ...AND BETWEEN THEM THEY COVER THE WHOLE INVENTORY. A constant no entrypoint can send
    // would be a statement the guard audits and the server never runs — and the converse, a text
    // sent that is in no constant, is what the loop above refuses. Running this the first time
    // found `PLANT_DRIFT_TRIGGER` sent but absent from the record, which is the point of asking
    // the question in both directions.
    const unsent = Object.entries(SLOT_STATEMENT_DIGESTS)
      .filter(([, digest]) => !sentDigests.has(digest)).map(([name]) => name);
    expect(unsent).toEqual([]);
  });
});

describe('ABC-27 slot factory — a driver-level coercion cannot answer the check and the send differently', () => {
  // ══ THE TWO ESCAPES THIS BATCH CLOSES, DRIVEN DIRECTLY ═══════════════════════════════════════
  //
  // `assertSlotsNotForeign` and `requireOwnedByCurrentIdentity` were always asked about the
  // string they received — but a caller could hand them something that ISN'T a string and looks
  // like one only once it reaches `node-postgres`: an object carrying `toPostgres()`, a
  // `Symbol.toPrimitive`, or a `toString` that answers differently on a second call. The old
  // registry SKIPPED such a value (it is not a string, and several fixtures deliberately pass a
  // `null` or a ghost) while the driver went on to serialize whatever the object's own method
  // returned. `capturedId`/`capturedOptionalId` close this by refusing anything that is not
  // ALREADY a primitive string, at the factory's own boundary, before either half runs.
  //
  // EACH CASE PROVES REFUSAL BY INSTRUMENTING THE HOSTILE METHOD ITSELF: a value that was
  // genuinely never consulted leaves its own counter at zero, which is a stronger claim than "the
  // write was refused" alone — a check that coerced the value and THEN decided to refuse would
  // also leave `sent` empty.
  it('an object carrying `toPostgres()` is refused as a slot id, and it is never called', async () => {
    const { client, sent } = recordingClient();
    let calls = 0;
    const hostile = { toPostgres: () => { calls += 1; return foreignSlot; } };
    await expect(shiftSlotTimes(client, hostile as never, { minutes: 1 }))
      .rejects.toThrow(/only a primitive string may be validated/);
    expect(calls, 'toPostgres must never be invoked — a value that decides what it becomes '
      + 'decides what is written').toBe(0);
    expect(sent).toEqual([]);
  });

  it('an object carrying `Symbol.toPrimitive` is refused as a slot id, and it is never called',
    async () => {
      const { client, sent } = recordingClient();
      let calls = 0;
      const hostile = { [Symbol.toPrimitive]: () => { calls += 1; return foreignSlot; } };
      await expect(shiftSlotTimes(client, hostile as never, { minutes: 1 }))
        .rejects.toThrow(/only a primitive string may be validated/);
      expect(calls).toBe(0);
      expect(sent).toEqual([]);
    });

  it('an object with a two-faced `toString` is refused as a slot id, and it is never called',
    async () => {
      const { client, sent } = recordingClient();
      let calls = 0;
      // ANSWERS DIFFERENTLY EACH TIME — a check that called it once and a send that called it
      // again would see two different values, exactly as the ORIGINAL bytea renderer defect (a
      // stateful `Symbol.toPrimitive` answering `LOWER_HEX.test` one way and the template
      // another) looked from inside its own module.
      const hostile = { toString: () => { calls += 1; return calls === 1 ? foreignSlot : 'x'; } };
      await expect(shiftSlotTimes(client, hostile as never, { minutes: 1 }))
        .rejects.toThrow(/only a primitive string may be validated/);
      expect(calls, 'toString must never be invoked by this check').toBe(0);
      expect(sent).toEqual([]);
    });

  it('an object carrying `toPostgres()` is refused as a TRAINER, and it is never called', async () => {
    const { client, sent } = recordingClient();
    let calls = 0;
    const hostile = { toPostgres: () => { calls += 1; return 'c0000000-0000-4000-8000-00000000c777'; } };
    await expect(insertSlot(client, {
      trainer: hostile as never, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    })).rejects.toThrow(/only a primitive string may be validated/);
    expect(calls).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a two-faced `get id()` on the caller\'s record is read exactly once, by insertSlot',
    async () => {
      const { client, sent } = recordingClient();
      const trainer = await newTrainerId(client);
      sent.length = 0;
      let reads = 0;
      const firstId = randomUUID();
      // THE SECOND ANSWER IS FOREIGN. If the id were read twice — once to check, once to send —
      // this is the shape that would let the check see `firstId` (unowned, so it passes) and the
      // send carry `foreignSlot` instead, exactly the split this control exists to close.
      const s = {
        trainer, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
        get id() { reads += 1; return reads === 1 ? firstId : foreignSlot; },
      };
      await insertSlot(client, s as never);
      expect(reads, 'the id getter must fire exactly once').toBe(1);
      // ...AND THE VALUE THAT WAS ACTUALLY BOUND is the FIRST (and only) answer — position 0 of
      // `SLOT_BASIC_INSERT`'s parameter list, `COALESCE($1::uuid, gen_random_uuid())`. `sent[0]`
      // is the referential `trainer_profiles` upsert `owned()` performs before it writes; `sent[1]`
      // is the slot INSERT itself.
      expect(sent[1].values[0]).toBe(firstId);
    });

  it('a two-faced `get trainer()` on the caller\'s record is read exactly once, by insertSlot',
    async () => {
      const { client, sent } = recordingClient();
      const mine = await newTrainerId(client);
      sent.length = 0;
      let reads = 0;
      const s = {
        academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
        get trainer() { reads += 1; return reads === 1 ? mine : 'c0000000-0000-4000-8000-00000000c778'; },
      };
      await insertSlot(client, s as never);
      expect(reads, 'the trainer getter must fire exactly once').toBe(1);
      // `sent[0]` is the referential upsert `owned()` performs; `sent[1]` is the slot INSERT.
      expect(sent[1].values[1]).toBe(mine);
    });
});

describe('ABC-27 slot factory — the STORED row is judged, not only the argument that was sent', () => {
  // ══ THE DATABASE'S OWN ANSWER, SENSORED DIRECTLY ═════════════════════════════════════════════
  //
  // Everything above proves the ARGUMENT is checked before it is sent. None of it proves anything
  // about what comes BACK — a `BEFORE` trigger rewriting `NEW.trainer_id`, or a server that hands
  // back an id another identity already holds, are both invisible to an argument-side check by
  // construction. These three drive a HAND-WRITTEN client (not the shared stub, which cannot
  // fabricate a mismatch) to prove `acceptStoredSlotRows` actually discriminates rather than
  // merely existing.
  it('refuses when the STORED trainer differs from what was sent', async () => {
    const { client: setup } = recordingClient();
    const mine = await newTrainerId(setup);
    const drifted = 'c0000000-0000-4000-8000-00000000d000';
    let n = 0;
    const driftingClient = {
      query: async (text: string) => {
        if (text.includes('trainer_profiles')) return { rows: [] };
        n += 1;
        return { rows: [{ id: `bb000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          trainer_id: drifted }] };
      },
    } as never;
    await expect(insertSlot(driftingClient, {
      trainer: mine, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
    })).rejects.toThrow(/the value PostgreSQL holds is not the value that was sent/);
  });

  it('refuses when the STORED id collides with a slot another identity already claimed',
    async () => {
      const { client: setup } = recordingClient();
      const mine = await newTrainerId(setup);
      const collidingClient = {
        query: async (text: string) => {
          if (text.includes('trainer_profiles')) return { rows: [] };
          return { rows: [{ id: foreignSlot, trainer_id: mine }] };
        },
      } as never;
      await expect(insertSlot(collidingClient, {
        trainer: mine, academy: ACADEMY, start: AT_ONE_DAY, end: AT_ONE_DAY_AN_HOUR,
      })).rejects.toThrow(/is owned by/);
    });

  it('plantSourceDriftTrigger refuses a slot the server holds no row for', async () => {
    const mine = randomUUID();
    noteSlotsOwned([mine]);
    const noRowClient = { query: async () => ({ rows: [] }) } as never;
    await expect(plantSourceDriftTrigger(noRowClient, { label: 'x', slot: mine, price: '1.00' }))
      .rejects.toThrow(/the server holds no row for/);
  });
});
