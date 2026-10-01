// @vitest-environment node
//
// ══ THE ABC-27 SLOT WRITE SURFACE ════════════════════════════════════════════════════════════
//
// EVERY write to `public.availability_slots` that the ABC-27 suite performs goes through this
// module. That is the whole design, and it is a deliberate retreat from a more ambitious one.
//
// ── WHAT THIS REPLACES, AND WHY ───────────────────────────────────────────────────────────────
//
// The predecessor left the 44 write sites where they were and tried to PROVE, statically, that
// each one bound `trainer_id` to an authority-issued value. To do that it had to model a general
// dataflow: a SQL lexer, a template-hole resolver, brands for interpolated SQL fragments
// (`sqlFragment`) and for quoted literals (`sqlUuid`), and rules about which holes could stand in
// which syntactic position. Every review round found another way through, and each fix was a
// patch to a model rather than a removal of a mechanism:
//
//   · a validated fragment could smuggle a whole extra VALUES row past a reader looking at the
//     first — `x), (foreign_trainer, …`;
//   · then, once commas inside parentheses were allowed, `AS ${sqlFragment("x(id) union all
//     values ('foreign'::uuid, …)")}` reached an `unnest` alias, and the hole atom was ONE word
//     token so the set-operator counter never saw the `union` at all;
//   · a brand could be acquired with no cast whatsoever under this repository's `strict: false`
//     — through a CONTAINING type (`{ t: IsolatedTrainerId }` annotated from an `any`), or by
//     widening a branded array to `string[]` and mutating the alias;
//   · and an options object could deliver source slots through a GETTER that no syntactic
//     follower read.
//
// Four different holes, one cause: a static reader cannot decide a general dataflow, and every
// mechanism added to help it read became another thing to defeat. So the mechanisms are gone.
// `sqlFragment`, `sqlUuid` and their brands are retired; there is no interpolation into slot SQL
// anywhere, because there is no slot SQL anywhere but here.
//
// ── WHAT IS TRUE NOW ──────────────────────────────────────────────────────────────────────────
//
//   1. Every statement in this file is a FIXED, COMPLETE literal. No template hole, no
//      concatenation, no caller-supplied text. Values reach the server only as `$k` parameters,
//      which PostgreSQL binds after parsing — so no argument, of any type or origin, can change
//      WHICH expression lands in a column or WHAT the statement is. A runtime control asserts
//      that what every entrypoint SENDS is byte-identical to one of these constants, because the
//      guard reads the source text and only that control reads what the server is given.
//   2. Every entrypoint that names a TRAINER calls `requireOwnedByCurrentIdentity()` on it before
//      writing, and every entrypoint that names a SLOT calls `assertSlotsNotForeign()` on that.
//      Both are REGISTRY lookups at execution time, not types: a forged brand, an `any`, a value
//      laundered through a containing type or a getter all arrive here as a string, and a string
//      another test owns is refused. This runs in every invocation.
//   3. Every slot this writes is registered to the current identity, so the apply and extend
//      drivers can refuse a SOURCE SLOT belonging to another test — the indirect path by which a
//      target trainer is inherited without a trainer ever being named.
//
// THE UPDATES CHECK THE SLOT, NOT ONLY THE TRAINER. An earlier version of this file reasoned that
// an UPDATE which does not MOVE the trainer needs no capability check. A review round showed that
// false in one line: `shiftSlotTimes(c, someoneElsesSlot, { minutes: 60 })` walks another test's
// slot along its own trainer's calendar, which is the collision this exists to prevent, through a
// helper that names no trainer at all.
//
// ── WHAT THE STATIC GUARD DOES AND DOES NOT SAY ───────────────────────────────────────────────
//
// It refuses DIRECT bypasses: a slot write spelled anywhere but here, in any SQL spelling it can
// lex, assembled by any composition it can constant-fold (`+`, `.join()`, `.concat()`), including
// inside dollar-quoted bodies. It audits these constants for interpolation.
//
// It does NOT prove a dataflow, and it does not read SQL a program computes by means it cannot
// fold. That residual is real and is why the load-bearing check is the runtime one: a statement
// this file did not send never asked the registry anything, and the registry is what refuses.
// DELETE is outside the four guarded verbs on purpose — removing a row cannot create an overlap
// namespace — so "no write outside this file" means no INSERT, UPDATE, MERGE or COPY.
//
// ── THE TIME SPEC ─────────────────────────────────────────────────────────────────────────────
//
// Times are the one place where fixed SQL and varied fixtures genuinely pull against each other:
// the suite needs instants, offsets from the server clock, and academy-LOCAL calendar steps. A
// statement per shape would multiply every column list by three. Instead ONE fixed value
// expression carries all three, selected by which parameters are non-NULL, and `SlotTime` below
// is the discriminated union that builds them. A caller cannot express an inconsistent tuple.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  acceptStoredSlotRows, assertSlotsNotForeign, capturedId, currentIdentity, ensureProfiles,
  requireAllOwnedByCurrentIdentity, requireOwnedByCurrentIdentity, verifyStoredSlots,
  type IsolatedTrainerId, type StoredSlot,
} from './abc27TrainerAuthority';

/**
 * WHEN A SLOT BOUND FALLS, in exactly three shapes.
 *
 * `instant`  — an absolute moment, optionally offset. The offset is what lets one caller-computed
 *              base serve a whole lane of slots without a second statement.
 * `fromNow`  — offset from the SERVER clock. `now() + interval '2 days'` is what the fixtures
 *              that must outlive a window wrote, and the server clock is the one the product's
 *              own window predicates compare against.
 * `local`    — a CALENDAR step in a named zone: the days are added to a bare `timestamp` and the
 *              result is converted ONCE. This is the DST-correct form. `timestamptz + interval`
 *              steps days in the SESSION zone, which pins the UTC clock and lets the LOCAL clock
 *              move by an hour across a transition — and series identity is (trainer, location,
 *              LOCAL weekday, LOCAL time, duration), so the local clock is the one that must hold.
 */
export type SlotTime =
  | { at: 'instant'; iso: string; offsetDays?: number; offsetMinutes?: number }
  | { at: 'fromNow'; days?: number; minutes?: number }
  | { at: 'local'; base: string; days: number; zone: string; plusMinutes?: number };

/** A window bound that is either an absolute instant or a whole number of days from `now()`. */
export type WindowTime = { at: 'instant'; iso: string } | { at: 'fromNow'; days: number };

/** The six parameters the fixed time expression reads. All-NULL renders SQL NULL. */
type TimeParams = [string | null, string | null, number | null, string | null,
  number | null, number | null];

const NO_TIME: TimeParams = [null, null, null, null, null, null];

/**
 * Render one `SlotTime` as the six parameters.
 *
 * THE INCONSISTENT TUPLE IS UNCONSTRUCTIBLE, not merely undocumented: the expression falls
 * through to `now()` whenever its earlier arms are NULL, so a half-filled `local` tuple would
 * silently mean "now" instead of raising. The union is what prevents that, and this function is
 * total over it.
 */
function timeParams(t: SlotTime | null | undefined): TimeParams {
  if (!t) return NO_TIME;
  if (t.at === 'instant') {
    return [t.iso, null, null, null, t.offsetDays ?? 0, t.offsetMinutes ?? 0];
  }
  if (t.at === 'local') {
    // THE DAYS BELONG TO THE BARE TIMESTAMP, before the conversion — that is the correction, and
    // it is why they travel in their own parameter rather than in the trailing offset.
    //
    // `plusMinutes` is deliberately the OTHER thing: an ABSOLUTE addition applied after the
    // conversion, which is what the one fixture that uses it wants — a window an hour longer in
    // real time. Its two bounds sit on the same local day, so no transition falls between them
    // and the two readings coincide; naming which one this is still costs nothing.
    return [null, t.base, t.days, t.zone, 0, t.plusMinutes ?? 0];
  }
  return [null, null, null, null, t.days ?? 0, t.minutes ?? 0];
}

/** The two parameters a window bound reads. */
const windowParams = (w: WindowTime | null | undefined): [string | null, number | null] =>
  (!w ? [null, null] : w.at === 'instant' ? [w.iso, null] : [null, w.days]);

// ══ THE STATEMENTS ═══════════════════════════════════════════════════════════════════════════
//
// Written out in full, one complete literal each, rather than assembled from shared pieces. A
// constant a reader has to reconstruct is a constant nobody audits, and the guard's rule for this
// file is exactly "a plain literal, no interpolation" — a composed statement would satisfy no
// reader and no checker.

/**
 * The ordinary slot: identity, tenancy, a window, a capacity, and the two priority/member bounds.
 *
 * NULL IS THE SAME AS OMITTING, for every optional column here. `location_id`, `cyclus_id`,
 * `source_cycle_id`, `priority_window_ends_at` and `member_window_ends_at` are all nullable with
 * NO default, so a site that used to leave one out and a call that passes `null` store the same
 * row. That is what lets one statement serve the eleven sites that used four column lists.
 */
const SLOT_BASIC_INSERT = `INSERT INTO public.availability_slots
  (id, trainer_id, location_id, academy_profile_id, cyclus_id, source_cycle_id,
   start_time, end_time, max_participants, priority_window_ends_at, member_window_ends_at)
VALUES (
  COALESCE($1::uuid, gen_random_uuid()),
  $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
  (COALESCE($7::timestamptz,
            ($8::timestamp + make_interval(days => $9::int)) AT TIME ZONE $10::text,
            now())
   + make_interval(days => $11::int, mins => $12::int)),
  (COALESCE($13::timestamptz,
            ($14::timestamp + make_interval(days => $15::int)) AT TIME ZONE $16::text,
            now())
   + make_interval(days => $17::int, mins => $18::int)),
  $19::int,
  COALESCE($20::timestamptz, now() + make_interval(days => $21::int)),
  COALESCE($22::timestamptz, now() + make_interval(days => $23::int)))
RETURNING id, trainer_id`;

/**
 * The TEMPLATE VECTOR slot — the eighteen fields a child's series identity and reviewed template
 * are taken over. Every apply/preview source is one of these.
 */
const SLOT_TEMPLATE_INSERT = `INSERT INTO public.availability_slots
  (id, trainer_id, location_id, academy_profile_id, cyclus_id, start_time, end_time,
   court_type, training_level, min_participants, max_participants, rating_system,
   min_rating, max_rating, prices_include_vat, split_payment, allow_single_booking,
   whole_slot_booking, price_per_session, total_price, extra_costs)
VALUES (
  COALESCE($1::uuid, gen_random_uuid()),
  $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  (COALESCE($6::timestamptz,
            ($7::timestamp + make_interval(days => $8::int)) AT TIME ZONE $9::text,
            now())
   + make_interval(days => $10::int, mins => $11::int)),
  (COALESCE($12::timestamptz,
            ($13::timestamp + make_interval(days => $14::int)) AT TIME ZONE $15::text,
            now())
   + make_interval(days => $16::int, mins => $17::int)),
  $18::text, $19::text, $20::int, $21::int, $22::text,
  $23::numeric, $24::numeric, $25::boolean, $26::boolean, $27::boolean,
  $28::boolean, $29::numeric, $30::numeric, $31::jsonb)
RETURNING id, trainer_id`;

/**
 * A LANE OF ORDINARY SLOTS, one per supplied trainer, stepped by a fixed number of minutes.
 *
 * `WITH ORDINALITY` is what pairs each trainer with its own offset — the same pairing the retired
 * SQL-side `generate_series` mint produced, except that the ids now arrive as a bound `uuid[]`
 * the registry has already approved instead of being computed inside the statement.
 */
const SLOT_BASIC_SERIES_INSERT = `INSERT INTO public.availability_slots
  (id, trainer_id, location_id, academy_profile_id, source_cycle_id,
   start_time, end_time, max_participants, member_window_ends_at)
SELECT gen_random_uuid(), t.id, $2::uuid, $3::uuid, $4::uuid,
       (COALESCE($5::timestamptz, now())
        + make_interval(days => $6::int, mins => $7::int + (t.i::int - 1) * $8::int)),
       (COALESCE($5::timestamptz, now())
        + make_interval(days => $6::int, mins => $9::int + (t.i::int - 1) * $8::int)),
       $10::int,
       COALESCE($11::timestamptz, now() + make_interval(days => $12::int))
  FROM pg_catalog.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)
RETURNING id, trainer_id`;

/**
 * A LANE OF TEMPLATE SLOTS, one per trainer, a fixed number of minutes apart.
 *
 * The template values are LITERAL rather than parameters. Both ceiling fixtures that use this
 * want the identical vector — they vary only in how many children they seed — and a fixed vector
 * is one fewer thing a caller can move.
 */
const SLOT_TEMPLATE_SERIES_INSERT = `INSERT INTO public.availability_slots
  (id, trainer_id, location_id, academy_profile_id, start_time, end_time, court_type,
   training_level, min_participants, max_participants, rating_system, min_rating, max_rating,
   prices_include_vat, split_payment, allow_single_booking, whole_slot_booking,
   price_per_session, total_price, extra_costs)
SELECT gen_random_uuid(), t.id, $2::uuid, $3::uuid,
       $4::timestamptz + make_interval(mins => $6::int * t.i::int),
       $5::timestamptz + make_interval(mins => $6::int * t.i::int),
       'indoor', 'B', 2, 4, 'padel', 1.0, 3.0, true, true, true, false, 12.50, 50.00, '[]'::jsonb
  FROM pg_catalog.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)
RETURNING id, trainer_id`;

const SLOT_UPDATE_SHIFT_TIMES = `UPDATE public.availability_slots
   SET start_time = start_time + make_interval(mins => $2::int, secs => $3::double precision),
       end_time   = end_time   + make_interval(mins => $2::int, secs => $3::double precision)
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_SHIFT_TIMES_AND_TRAINER = `UPDATE public.availability_slots
   SET start_time = start_time + make_interval(mins => $2::int, secs => $3::double precision),
       end_time   = end_time   + make_interval(mins => $2::int, secs => $3::double precision),
       trainer_id = $4::uuid
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_SHIFT_TIMES_AND_VISIBILITY = `UPDATE public.availability_slots
   SET start_time = start_time + make_interval(mins => $2::int, secs => $3::double precision),
       end_time   = end_time   + make_interval(mins => $2::int, secs => $3::double precision),
       is_public  = $4::boolean
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_LOCATION_AND_SHIFT_TIMES = `UPDATE public.availability_slots
   SET location_id = $2::uuid,
       start_time  = start_time + make_interval(mins => $3::int, secs => $4::double precision),
       end_time    = end_time   + make_interval(mins => $3::int, secs => $4::double precision)
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_TRAINER = `UPDATE public.availability_slots
   SET trainer_id = $2::uuid WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_TRAINER_AND_LOCATION = `UPDATE public.availability_slots
   SET trainer_id = $2::uuid, location_id = $3::uuid WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_LOCATION = `UPDATE public.availability_slots
   SET location_id = $2::uuid WHERE id = $1::uuid
 RETURNING id, trainer_id`;

/** Capacity: two contention controls assert on the returned row itself, and so does the factory. */
const SLOT_UPDATE_CAPACITY = `UPDATE public.availability_slots
   SET max_participants = $2::int WHERE id = $1::uuid RETURNING id, trainer_id`;

const SLOT_UPDATE_PARTICIPANTS = `UPDATE public.availability_slots
   SET min_participants = $2::int,
       max_participants = COALESCE($3::int, max_participants)
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_RATINGS = `UPDATE public.availability_slots
   SET min_rating = $2::numeric, max_rating = $3::numeric WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_PRICE = `UPDATE public.availability_slots
   SET price_per_session = $2::numeric WHERE id = $1::uuid
 RETURNING id, trainer_id`;

const SLOT_UPDATE_EXTRA_COSTS = `UPDATE public.availability_slots
   SET extra_costs = $2::jsonb WHERE id = $1::uuid
 RETURNING id, trainer_id`;

/** `end_time` re-derived from `start_time`. All-zero is exactly `end_time = start_time`. */
const SLOT_UPDATE_END_FROM_START = `UPDATE public.availability_slots
   SET end_time = start_time
     + make_interval(days => $2::int, mins => $3::int, secs => $4::double precision)
 WHERE id = $1::uuid
 RETURNING id, trainer_id`;

/** Both bounds, absolute. For the two cases that need the very edges of the timestamp domain. */
const SLOT_UPDATE_BOUNDS = `UPDATE public.availability_slots
   SET start_time = $2::timestamptz, end_time = $3::timestamptz WHERE id = $1::uuid
 RETURNING id, trainer_id`;

/**
 * THE PLANTED P-LAYER DRIFT TRIGGER, whose UPDATE runs on the SERVER.
 *
 * A PL/pgSQL body takes no client parameters, so this is the one write that cannot be bound —
 * which is precisely why its body must not be interpolated either. It reads its two facts from
 * SESSION SETTINGS instead, so the text below is as fixed as every other constant here and the
 * caller supplies its values through `set_config`, which IS parameterised.
 *
 * SECURITY DEFINER, deliberately, exactly as the fixture it replaces: the trigger fires inside the
 * A core's execution and Domain A holds zero product privilege after 7.4-C, so an invoker plant
 * would refuse on the slot UPDATE itself — the very containment under test — instead of modelling
 * drift.
 *
 * ── AND IT IS THE ONE GUARDED WRITE WITH NO CLIENT ROUND TRIP, SO IT CARRIES ITS OWN BOUND ────
 *
 * Every other statement here returns its rows and the registry judges what PostgreSQL stored.
 * This one runs on the SERVER, later, inside somebody else's transaction, so there is no
 * `RETURNING` for a client to read and no moment at which to read it. Its `WHERE` therefore names
 * the TRAINER as well as the slot — the fourth session setting — and `plantSourceDriftTrigger`
 * fills that setting from the row the server currently holds, read back immediately before the
 * plant. The drift can then only touch a row still sitting in the namespace the plant verified: a
 * fixture that models P-layer drift cannot, even by accident, become a fixture that MOVES a slot
 * into another test's overlap namespace. It changes `price_per_session` and nothing else, which
 * the canonical grammar audits, and the added predicate is what makes that a bound rather than an
 * observation about the text as it happens to be written today.
 */
const PLANT_DRIFT_FUNCTION = `CREATE FUNCTION public.zz_c_pdrift() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $zz$
  BEGIN
    IF NEW.label = current_setting('abc27.drift_label') THEN
      UPDATE public.availability_slots
         SET price_per_session = current_setting('abc27.drift_price')::numeric
       WHERE id = current_setting('abc27.drift_slot')::uuid
         AND trainer_id = current_setting('abc27.drift_trainer')::uuid;
    END IF;
    RETURN NEW;
  END $zz$`;

const PLANT_DRIFT_TRIGGER = `CREATE TRIGGER zz_c_pdrift_trg BEFORE INSERT ON public.rebook_rounds
  FOR EACH ROW EXECUTE FUNCTION public.zz_c_pdrift()`;

// ══ THE ENTRYPOINTS ══════════════════════════════════════════════════════════════════════════

/**
 * The capability check, in one place so no entrypoint can be written without it.
 *
 * IT TAKES AN `unknown`, NOT THE BRAND AND NOT A `string`. A parameter typed as the brand is
 * satisfied by an `any` under this repository's `strict: false`, so demanding the brand HERE
 * would be a check the compiler never performs — and this is the one check that must actually
 * run. Typing it `string` was the same mistake one layer down: under `strict: false` an object
 * reaches a `string` parameter unchallenged, and an object is precisely what the driver
 * serializes through `toPostgres()` after the registry has skipped it. `unknown` says what is
 * true — anything can arrive — and `capturedId` is what decides.
 */
const owned = async (client: pg.Client, trainer: unknown): Promise<IsolatedTrainerId> => {
  // ONE CAPTURE, THEN VALIDATE AND SEND THE SAME PRIMITIVE. `requireOwnedByCurrentIdentity`
  // returns the CANONICAL form of the id it approved, and that returned value is what every
  // caller below binds — so the text the registry keyed on is the text PostgreSQL receives, and
  // there is no second read of anything in between.
  const id = requireOwnedByCurrentIdentity(capturedId(trainer, 'a trainer'));
  // ...AND THE REFERENTIAL ROW IS ENSURED HERE, immediately before the write.
  //
  // The capability check is about OWNERSHIP; this is about the foreign key, and it belongs at the
  // write rather than at the acquisition because the two came apart. A fixture that acquires a
  // trainer inside a transaction it rolls back still owns the id afterwards — the registry is in
  // memory and has nothing to roll back — while `trainer_profiles` no longer carries the row. The
  // next slot write then fails `availability_slots_trainer_id_fkey` for a reason that has nothing
  // to do with the property under test. `ON CONFLICT DO NOTHING` makes the repeat free.
  //
  // ORDER MATTERS: the capability is checked FIRST, so a refused trainer costs no row at all.
  await ensureProfiles(client, [id]);
  return id;
};

/**
 * The same, for a lane. One round trip for the whole array.
 *
 * THE ELEMENTS ARE READ BY INDEX, NOT BY `map`, and that is the array version of the same rule:
 * `map` is a property OF the caller's array, and an array may own a replacement that ignores the
 * callback and returns whatever it likes — including objects carrying `toPostgres()`. Reading
 * `length` and each index takes the caller's data without calling the caller's code, and each
 * element is captured as a primitive before the registry is asked about it.
 */
const allOwned = async (
  client: pg.Client, trainers: readonly unknown[],
): Promise<IsolatedTrainerId[]> => {
  const captured: string[] = [];
  for (let i = 0; i < trainers.length; i += 1) {
    captured.push(capturedId(trainers[i], `a trainer of a lane (element ${i})`));
  }
  const ids = requireAllOwnedByCurrentIdentity(captured);
  await ensureProfiles(client, ids);
  return ids;
};

/**
 * WHAT THE SERVER STORED, JUDGED — not what the call hoped it had sent.
 *
 * Every statement above returns `id, trainer_id`, so this is the write's OWN rows: no second
 * round trip, no second snapshot, and nothing between the write and the check for a trigger to
 * happen in. `trainers`, where the call named one, is what makes the strongest form of the
 * question available: the stored value must be exactly what was sent.
 *
 * A ZERO-ROW RESULT IS A PASS AND SAYS SO. Several fixtures deliberately address a slot id that
 * names no row at all — a ghost, a rolled-back id, a foreign academy's — and an UPDATE that
 * matched nothing stored nothing to judge.
 */
const stored = (rows: unknown, what: string,
  o: { claim: boolean; trainers?: readonly string[] }): StoredSlot[] => {
  if (!Array.isArray(rows)) {
    throw new Error(
      `abc27 slot namespace: ${what} received no row list back from the server, so what it stored `
      + 'cannot be judged. An unread result is not an empty one.');
  }
  return acceptStoredSlotRows(rows, what, o);
};

/** The single row an unconditional INSERT always returns, judged, with its canonical id. */
const insertedId = (rows: unknown, what: string, trainer: string): string => {
  const rowsList = stored(rows, what, { claim: true, trainers: [trainer] });
  const row = rowsList[0];
  if (row === undefined) {
    throw new Error(
      `abc27 slot namespace: ${what} returned no row from an unconditional INSERT — a write that `
      + 'reports success but returns nothing is not a write this can verify.');
  }
  return row.id;
};

/**
 * A caller-supplied id that may legitimately be ABSENT, captured exactly once.
 *
 * `undefined` and `null` both mean "let the server mint one", which is what the column expression
 * `COALESCE($1::uuid, gen_random_uuid())` already says. Anything present must be a primitive
 * string — so an object that would have been checked as nothing and serialized as a slot id is
 * refused here, before either the check or the send has read anything.
 *
 * THE PRESENCE TEST IS `=== null`, NOT TRUTHINESS. `if (s.id)` was the old spelling and it folded
 * the empty string in with absence, so a caller that computed `''` skipped the ownership check
 * and then bound `''` anyway. The two questions — is there an id, and is it a valid one — are
 * asked separately now.
 */
const capturedOptionalId = (value: unknown, what: string): string | null =>
  (value === null || value === undefined ? null : capturedId(value, what));

export interface BasicSlot {
  id?: string | null;
  trainer: string;
  academy: string;
  location?: string | null;
  cyclus?: string | null;
  sourceCycle?: string | null;
  start: SlotTime;
  end: SlotTime;
  maxParticipants?: number | null;
  priorityWindowEnds?: WindowTime | null;
  memberWindowEnds?: WindowTime | null;
}

/**
 * One ordinary slot. Returns its id.
 *
 * ══ THE CALLER'S RECORD IS READ ONCE, AT THE TOP, AND NEVER AGAIN ═══════════════════════════
 *
 * This function used to read `s.id` THREE times — in `if (s.id)`, in the ownership check, and
 * again in the parameter list — and `s.id` is a PROPERTY, which a getter answers. A getter that
 * returns this test's id the first two times and another test's id the third satisfies both
 * checks and sends the third answer. That is the exact shape the apply catalogue's seal was built
 * for, still open here because these entrypoints read their record field by field.
 *
 * So every field is captured into a local first, in one pass, and everything below — the checks
 * AND the send — reads only those locals. `capturedSlotId` refuses anything that is not a
 * primitive string, so the local cannot be an object the driver would coerce later either.
 */
export async function insertSlot(client: pg.Client, s: BasicSlot): Promise<string> {
  const id = capturedOptionalId(s.id, 'insertSlot: id');
  const rawTrainer = s.trainer;
  const academy = s.academy; const location = s.location; const cyclus = s.cyclus;
  const sourceCycle = s.sourceCycle; const start = s.start; const end = s.end;
  const maxParticipants = s.maxParticipants; const priorityWindowEnds = s.priorityWindowEnds;
  const memberWindowEnds = s.memberWindowEnds;
  // THE CALLER-SUPPLIED ID IS CHECKED BEFORE THE WRITE, not after. The stored-row check runs on
  // the rows the server returned, and a round-4 review showed the ordering that made that too
  // late on its own: test A inserts explicit id X inside a transaction it rolls back, test B
  // inserts X again with its own trainer, the row is gone so the INSERT succeeds — and only then
  // would the returned row be noticed as A's. The refusal has to precede the statement, and the
  // stored-row check is the SECOND half rather than a replacement for the first.
  if (id !== null) ownedSlot(id, 'insertSlot');
  const trainer = await owned(client, rawTrainer);
  const { rows } = await client.query(SLOT_BASIC_INSERT, [
    id, trainer, location ?? null, academy, cyclus ?? null, sourceCycle ?? null,
    ...timeParams(start), ...timeParams(end),
    maxParticipants ?? 4,
    ...windowParams(priorityWindowEnds), ...windowParams(memberWindowEnds),
  ]);
  return insertedId(rows, 'insertSlot', trainer);
}

export interface TemplateSlot {
  id?: string | null;
  trainer: string;
  academy: string;
  location: string;
  cyclus?: string | null;
  start: SlotTime;
  end: SlotTime;
  // NULLABLE, EXPLICITLY. Every one of these columns is nullable in the product, and the
  // coherence cases need a stored NULL to be expressible — `count(DISTINCT x)` ignores NULLs, so
  // "one source NULL, one not" is precisely the pair a naive coherence check would call coherent.
  court?: string | null;
  level?: string | null;
  minParticipants?: number | null;
  maxParticipants?: number | null;
  ratingSystem?: string | null;
  minRating?: string | null;
  maxRating?: string | null;
  pricesIncludeVat?: boolean;
  splitPayment?: boolean;
  allowSingleBooking?: boolean;
  wholeSlotBooking?: boolean;
  pricePerSession?: string | null;
  totalPrice?: string | null;
  extraCosts?: string | null;
}

/** `undefined` takes the default; an explicit `null` is stored as NULL. */
const orDefault = <T>(given: T | null | undefined, fallback: T): T | null =>
  (given === undefined ? fallback : given);

/**
 * One TEMPLATE-VECTOR slot. Returns its id.
 *
 * THE NUMERICS ARE STRINGS. `numeric` keeps the scale it is given, and `12.50` written as a
 * JavaScript number arrives as `12.5` — a different stored value, and the reviewed template
 * vector is exactly what the canonical digests are taken over. Passing the text preserves the
 * scale the fixtures pinned.
 */
export async function insertTemplateSlot(client: pg.Client, s: TemplateSlot): Promise<string> {
  // READ ONCE, EXACTLY AS `insertSlot` DOES, and for the same reason: `s.id` was read three times
  // and every one of those reads is a getter's opportunity to answer differently.
  const id = capturedOptionalId(s.id, 'insertTemplateSlot: id');
  const rawTrainer = s.trainer;
  const location = s.location; const academy = s.academy; const cyclus = s.cyclus;
  const start = s.start; const end = s.end;
  const court = s.court; const level = s.level;
  const minParticipants = s.minParticipants; const maxParticipants = s.maxParticipants;
  const ratingSystem = s.ratingSystem; const minRating = s.minRating; const maxRating = s.maxRating;
  const pricesIncludeVat = s.pricesIncludeVat; const splitPayment = s.splitPayment;
  const allowSingleBooking = s.allowSingleBooking; const wholeSlotBooking = s.wholeSlotBooking;
  const pricePerSession = s.pricePerSession; const totalPrice = s.totalPrice;
  const extraCosts = s.extraCosts;
  if (id !== null) ownedSlot(id, 'insertTemplateSlot');
  const trainer = await owned(client, rawTrainer);
  const { rows } = await client.query(SLOT_TEMPLATE_INSERT, [
    id, trainer, location, academy, cyclus ?? null,
    ...timeParams(start), ...timeParams(end),
    orDefault(court, 'indoor'), orDefault(level, 'B'),
    orDefault(minParticipants, 2), orDefault(maxParticipants, 4),
    orDefault(ratingSystem, 'padel'), orDefault(minRating, '1.0'),
    orDefault(maxRating, '3.0'),
    pricesIncludeVat ?? true, splitPayment ?? true, allowSingleBooking ?? true,
    wholeSlotBooking ?? false,
    orDefault(pricePerSession, '12.50'), orDefault(totalPrice, '50.00'),
    orDefault(extraCosts, '[]'),
  ]);
  return insertedId(rows, 'insertTemplateSlot', trainer);
}

/** A lane of ordinary slots, one per trainer, `stepMinutes` apart. Returns their ids in order. */
export async function insertSlotSeries(client: pg.Client, s: {
  trainers: readonly string[];
  academy: string;
  location?: string | null;
  sourceCycle?: string | null;
  base?: string | null;
  baseOffsetDays?: number;
  startMinutes: number;
  endMinutes: number;
  stepMinutes: number;
  maxParticipants?: number;
  memberWindowEnds?: WindowTime | null;
}): Promise<string[]> {
  const location = s.location; const academy = s.academy; const sourceCycle = s.sourceCycle;
  const base = s.base; const baseOffsetDays = s.baseOffsetDays;
  const startMinutes = s.startMinutes; const stepMinutes = s.stepMinutes;
  const endMinutes = s.endMinutes; const maxParticipants = s.maxParticipants;
  const memberWindowEnds = s.memberWindowEnds;
  const trainers = await allOwned(client, s.trainers);
  const { rows } = await client.query(SLOT_BASIC_SERIES_INSERT, [
    trainers, location ?? null, academy, sourceCycle ?? null,
    base ?? null, baseOffsetDays ?? 0,
    startMinutes, stepMinutes, endMinutes,
    maxParticipants ?? 4,
    ...windowParams(memberWindowEnds),
  ]);
  // EVERY STORED ROW MUST NAME A TRAINER FROM THIS LANE, which is stronger than checking the lane
  // was sent: the statement pairs each trainer with its own offset through `WITH ORDINALITY`, so
  // a server-side rewrite that moved one child onto a trainer outside the lane is exactly the
  // shape that would otherwise pass every argument-side check.
  return stored(rows, 'insertSlotSeries', { claim: true, trainers }).map((r) => r.id);
}

/** A lane of template slots, one per trainer, `stepMinutes` apart. Returns their ids in order. */
export async function insertTemplateSlotSeries(client: pg.Client, s: {
  trainers: readonly string[];
  academy: string;
  location: string;
  startIso: string;
  endIso: string;
  stepMinutes: number;
}): Promise<string[]> {
  const location = s.location; const academy = s.academy;
  const startIso = s.startIso; const endIso = s.endIso; const stepMinutes = s.stepMinutes;
  const trainers = await allOwned(client, s.trainers);
  const { rows } = await client.query(SLOT_TEMPLATE_SERIES_INSERT, [
    trainers, location, academy, startIso, endIso, stepMinutes,
  ]);
  return stored(rows, 'insertTemplateSlotSeries', { claim: true, trainers }).map((r) => r.id);
}

// ── THE UPDATES ───────────────────────────────────────────────────────────────────────────────
//
// EVERY ONE OF THEM CHECKS THE SLOT, and the ones that MOVE the trainer check that too.
//
// A round-1 review found the earlier rule — "an UPDATE needs no capability check unless it moves
// the trainer" — false in a way that is obvious once stated: `shiftSlotTimes(c, someoneElsesSlot,
// { minutes: 60 })` walks another test's slot along its own trainer's calendar, which is the
// overlap collision this whole batch exists to prevent, arriving through a helper that never
// names a trainer at all. The row is identified by `id`, so the id is what has to be owned.
//
// `assertSlotsNotForeign` and not "must be owned": a slot NOBODY owns cannot carry another test's
// namespace, and several fixtures legitimately name ids the registry never issued.
//
// IT TAKES AN `unknown` AND RETURNS THE CAPTURED PRIMITIVE, which is the whole point of the
// rewrite. It used to take a `string` and return its argument unchanged — so an OBJECT, which
// `strict: false` lets through a `string` parameter without a cast, was skipped by
// `assertSlotsNotForeign` (which ignores non-strings on purpose) and then handed straight to the
// driver, where `toPostgres()` decided what the `WHERE id = $1` clause would actually address.
// Measured against the installed driver. The value that is checked and the value that is sent are
// now the same primitive, because there is only one.
const ownedSlot = (id: unknown, what: string): string => {
  const captured = capturedId(id, `${what}: the slot id`);
  assertSlotsNotForeign([captured], what);
  return captured;
};

/**
 * The two halves of every setter below, in one place.
 *
 * `by`, `d` AND EVERY OTHER OPTION RECORD IS READ ONCE TOO. A setter's numeric options are not
 * identities and cannot address a row, but they are still properties a getter answers, and
 * reading them into locals before the send costs nothing and removes the question entirely.
 */
const shiftParams = (by: { minutes?: number; seconds?: number }): [number, number] => {
  const minutes = by.minutes; const seconds = by.seconds;
  return [minutes ?? 0, seconds ?? 0];
};

/** Move both bounds by the same signed amount. */
export const shiftSlotTimes = async (client: pg.Client, id: unknown,
  by: { minutes?: number; seconds?: number }): Promise<void> => {
  const slot = ownedSlot(id, 'shiftSlotTimes');
  const { rows } = await client.query(SLOT_UPDATE_SHIFT_TIMES, [slot, ...shiftParams(by)]);
  stored(rows, 'shiftSlotTimes', { claim: false });
};

/** Move both bounds AND re-aim the slot at another trainer this test owns. */
export const shiftSlotTimesAndSetTrainer = async (client: pg.Client, id: unknown,
  by: { minutes?: number; seconds?: number }, trainer: unknown): Promise<void> => {
  const slot = ownedSlot(id, 'shiftSlotTimesAndSetTrainer');
  const to = await owned(client, trainer);
  const { rows } = await client.query(SLOT_UPDATE_SHIFT_TIMES_AND_TRAINER,
    [slot, ...shiftParams(by), to]);
  stored(rows, 'shiftSlotTimesAndSetTrainer', { claim: false, trainers: [to] });
};

/** Move both bounds and set visibility in one statement, as the C-guard fixture does. */
export const shiftSlotTimesAndSetVisibility = async (client: pg.Client, id: unknown,
  by: { minutes?: number; seconds?: number }, isPublic: boolean): Promise<void> => {
  const slot = ownedSlot(id, 'shiftSlotTimesAndSetVisibility');
  const { rows } = await client.query(SLOT_UPDATE_SHIFT_TIMES_AND_VISIBILITY,
    [slot, ...shiftParams(by), isPublic]);
  stored(rows, 'shiftSlotTimesAndSetVisibility', { claim: false });
};

/** Re-aim the slot at another location and move both bounds. */
export const setSlotLocationAndShiftTimes = async (client: pg.Client, id: unknown,
  location: string, by: { minutes?: number; seconds?: number }): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotLocationAndShiftTimes');
  const { rows } = await client.query(SLOT_UPDATE_LOCATION_AND_SHIFT_TIMES,
    [slot, location, ...shiftParams(by)]);
  stored(rows, 'setSlotLocationAndShiftTimes', { claim: false });
};

/** Re-aim the slot at another trainer THIS TEST OWNS. */
export const setSlotTrainer = async (client: pg.Client, id: unknown,
  trainer: unknown): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotTrainer');
  const to = await owned(client, trainer);
  const { rows } = await client.query(SLOT_UPDATE_TRAINER, [slot, to]);
  stored(rows, 'setSlotTrainer', { claim: false, trainers: [to] });
};

/** Re-aim the slot at another trainer this test owns, and at another location. */
export const setSlotTrainerAndLocation = async (client: pg.Client, id: unknown,
  trainer: unknown, location: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotTrainerAndLocation');
  const to = await owned(client, trainer);
  const { rows } = await client.query(SLOT_UPDATE_TRAINER_AND_LOCATION, [slot, to, location]);
  stored(rows, 'setSlotTrainerAndLocation', { claim: false, trainers: [to] });
};

export const setSlotLocation = async (client: pg.Client, id: unknown,
  location: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotLocation');
  const { rows } = await client.query(SLOT_UPDATE_LOCATION, [slot, location]);
  stored(rows, 'setSlotLocation', { claim: false });
};

export const setSlotCapacity = async (client: pg.Client, id: unknown,
  maxParticipants: number): Promise<pg.QueryResult> => {
  const slot = ownedSlot(id, 'setSlotCapacity');
  // THE WHOLE RESULT IS RETURNED, because two contention controls assert on the returned row —
  // and the stored row is judged first, so what those controls receive has already been checked.
  const result = await client.query(SLOT_UPDATE_CAPACITY, [slot, maxParticipants]);
  stored(result.rows, 'setSlotCapacity', { claim: false });
  return result;
};

export const setSlotParticipants = async (client: pg.Client, id: unknown,
  min: number, max?: number | null): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotParticipants');
  const { rows } = await client.query(SLOT_UPDATE_PARTICIPANTS, [slot, min, max ?? null]);
  stored(rows, 'setSlotParticipants', { claim: false });
};

export const setSlotRatings = async (client: pg.Client, id: unknown,
  min: string, max: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotRatings');
  const { rows } = await client.query(SLOT_UPDATE_RATINGS, [slot, min, max]);
  stored(rows, 'setSlotRatings', { claim: false });
};

export const setSlotPrice = async (client: pg.Client, id: unknown,
  price: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotPrice');
  const { rows } = await client.query(SLOT_UPDATE_PRICE, [slot, price]);
  stored(rows, 'setSlotPrice', { claim: false });
};

export const setSlotExtraCosts = async (client: pg.Client, id: unknown,
  extraCosts: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotExtraCosts');
  const { rows } = await client.query(SLOT_UPDATE_EXTRA_COSTS, [slot, extraCosts]);
  stored(rows, 'setSlotExtraCosts', { claim: false });
};

/** `end_time := start_time + <duration>`. An all-zero duration is `end_time = start_time`. */
export const setSlotDuration = async (client: pg.Client, id: unknown,
  d: { days?: number; minutes?: number; seconds?: number } = {}): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotDuration');
  const days = d.days; const minutes = d.minutes; const seconds = d.seconds;
  const { rows } = await client.query(SLOT_UPDATE_END_FROM_START,
    [slot, days ?? 0, minutes ?? 0, seconds ?? 0]);
  stored(rows, 'setSlotDuration', { claim: false });
};

/** Both bounds, absolute — for the cases that need the edges of the timestamp domain. */
export const setSlotBounds = async (client: pg.Client, id: unknown,
  startIso: string, endIso: string): Promise<void> => {
  const slot = ownedSlot(id, 'setSlotBounds');
  const { rows } = await client.query(SLOT_UPDATE_BOUNDS, [slot, startIso, endIso]);
  stored(rows, 'setSlotBounds', { claim: false });
};

/**
 * Plant the P-layer drift trigger, whose server-side UPDATE mutates one source template fact
 * inside the apply's write phase.
 *
 * The three facts travel as SESSION SETTINGS, which is what keeps the function body a fixed
 * literal. `set_config(…, false)` makes them session-scoped, so they survive the savepoint the
 * fixture rolls back to and are read by the trigger in the same session that plants it.
 */
export async function plantSourceDriftTrigger(client: pg.Client, o: {
  label: string; slot: string; price: string;
}): Promise<void> {
  const label = o.label; const price = o.price;
  const slot = ownedSlot(o.slot, 'plantSourceDriftTrigger');
  // ── THE TRAINER COMES FROM THE DATABASE, NOT FROM THE CALLER ──────────────────────────────
  //
  // `verifyStoredSlots` is the authority's own read-back — the same one an apply's targets are
  // judged through — so this asks nothing the registry does not already know how to answer, and
  // the trainer it returns is CANONICAL: the exact text the registry would key on, not the raw
  // column value. The plant reads the row the server currently holds and binds the drift to THAT
  // trainer. Two things follow, and both matter. The stored row is judged before anything is
  // planted, so a drift aimed at a slot sitting in another test's namespace is refused with no
  // trigger created; and the trigger's own UPDATE carries the trainer in its `WHERE`, so the one
  // guarded write with no client round trip cannot move a row between namespaces even if the
  // fixture that planted it were wrong about which row it named.
  const subject = (await verifyStoredSlots(client, [slot], 'plantSourceDriftTrigger'))[0];
  if (subject === undefined) {
    throw new Error(
      `abc27 slot namespace: plantSourceDriftTrigger names slot ${slot}, which the server holds no `
      + 'row for — a drift trigger bound to a row that does not exist would fire against whatever '
      + 'later occupies that id.');
  }
  const trainer = subject.trainer;
  await client.query(
    `SELECT set_config('abc27.drift_label',   $1, false),
            set_config('abc27.drift_slot',    $2, false),
            set_config('abc27.drift_price',   $3, false),
            set_config('abc27.drift_trainer', $4, false)`,
    [label, slot, price, trainer]);
  await client.query(PLANT_DRIFT_FUNCTION);
  await client.query(PLANT_DRIFT_TRIGGER);
}

/**
 * EVERY TEXT THIS MODULE CAN SEND — held here, and here only, so a second copy of a statement is
 * never a second thing to keep in step.
 *
 * ══ NOT EXPORTED, WHICH IS A DELIBERATE TIGHTENING ═══════════════════════════════════════════
 *
 * This used to be exported so a runtime control could compare what an entrypoint sent against
 * what the module holds. That let the byte-equality control work, and it also meant a caller
 * outside this file could `import { SLOT_STATEMENTS } from './abc27SlotFixtures'` and send
 * `SLOT_STATEMENTS.SLOT_UPDATE_TRAINER` on a connection of its own choosing — with no ownership
 * check in between, because the check lives in the ENTRYPOINT, not in the text. G1 refuses a
 * write spelled outside this file; it says nothing about a write RE-SPELLED FROM this file's own
 * export, because the bytes are identical to something the guard already audited. The apply
 * catalogue closed exactly this hole by publishing digests instead of text, and the same move is
 * made here: the byte-equality control now compares a SHA-256 of what was sent against
 * `SLOT_STATEMENT_DIGESTS` below, which cannot be invoked and cannot be re-sent, because there is
 * nothing left in it to send.
 *
 * TWENTY CONSTANTS, NINETEEN OF WHICH WRITE THE RELATION. `PLANT_DRIFT_TRIGGER` is a trigger
 * DEFINITION, so the guard's write inventory does not count it while the runtime control that
 * checks "everything sent is byte-identical to a constant" must — which is how it was found
 * missing from this record in the first place.
 */
const SLOT_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({
  SLOT_BASIC_INSERT,
  SLOT_TEMPLATE_INSERT,
  SLOT_BASIC_SERIES_INSERT,
  SLOT_TEMPLATE_SERIES_INSERT,
  SLOT_UPDATE_SHIFT_TIMES,
  SLOT_UPDATE_SHIFT_TIMES_AND_TRAINER,
  SLOT_UPDATE_SHIFT_TIMES_AND_VISIBILITY,
  SLOT_UPDATE_LOCATION_AND_SHIFT_TIMES,
  SLOT_UPDATE_TRAINER,
  SLOT_UPDATE_TRAINER_AND_LOCATION,
  SLOT_UPDATE_LOCATION,
  SLOT_UPDATE_CAPACITY,
  SLOT_UPDATE_PARTICIPANTS,
  SLOT_UPDATE_RATINGS,
  SLOT_UPDATE_PRICE,
  SLOT_UPDATE_EXTRA_COSTS,
  SLOT_UPDATE_END_FROM_START,
  SLOT_UPDATE_BOUNDS,
  PLANT_DRIFT_FUNCTION,
  PLANT_DRIFT_TRIGGER,
});

/**
 * The sha256 of each statement above, published so a runtime control can recognise what an
 * entrypoint sent WITHOUT this module exporting a text anything could re-send. Same move,
 * same shape, as `APPLY_STATEMENT_DIGESTS` in the apply catalogue — keyed by the same twenty
 * names, so the two inventories stay legible against each other.
 */
export const SLOT_STATEMENT_DIGESTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(SLOT_STATEMENTS)
    .map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])));

/** The identity this module would write under right now. For the ownership controls. */
export const writingIdentity = (): string => currentIdentity();
