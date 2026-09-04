// @vitest-environment node
//
// ══ THE ABC-27 APPLY INVOCATION CATALOGUE ════════════════════════════════════════════════════
//
// EVERY invocation of `rebook_round_apply_normalized_core` and of
// `rebook_round_apply_command_as_actor` that the ABC-27 suite performs is spelled here, and each
// one is bound in a single linear body to the registry check that must precede it.
//
// ── WHAT THIS REPLACES, AND WHY IT IS AN ARCHITECTURE AND NOT A PATCH ─────────────────────────
//
// The predecessor left the seven writing call sites where they were and PROVED, by reading the
// suite's syntax tree, that an `enteringApplyWrite(…)` dominated each of them. That is a general
// question about JavaScript dataflow over a 30,000-line file, and four consecutive review rounds
// each found the next enumeration hole:
//
//   · a hole in an ordinary expression position can BE a call —
//     `send('public.rebook_round_apply_command_as_actor()')` names the routine in a value the
//     substituted parse tree reads as an inert column reference;
//   · a `for…of` destructuring DEFAULT selects a stored call text the resolver never looks at;
//   · a stored call map reached through a computed subscript cannot be read at all;
//   · a constructor parameter property is a class member no member walk visits.
//
// Each fix moved the hole, because there is no oracle for JavaScript dataflow the way there is
// one for SQL grammar — every answer there is an enumeration, and an enumeration is defeated by
// the spelling nobody wrote down. So the reader is gone. There is nothing left to resolve:
//
//   1. A writing apply routine is NAMED nowhere in the `src/test/abc27*` family except in this
//      file's own private constants. The guard refuses any other decoded token that spells one,
//      in a string or an identifier, outside a pinned inventory of decided, non-invoking mentions.
//   2. Every entrypoint below is four statements: the SEAL that reads the caller's record once,
//      the ownership check, the target claim, and one
//      `client.query` of a statement this module holds. There is no branch to skip the guard, no
//      second query, and no path from an argument to WHICH statement is sent.
//   3. The guard runs on the EVALUATED values, in every run of every lane. Destructuring
//      defaults, accessors, constructor parameter properties, aliases and value holes are all
//      upstream of this boundary: they can only change WHICH VALUES ARRIVE, and which values
//      arrive is exactly what the registry judges.
//
// ── THE RAW TEXTS ARE NOT EXPORTED, AND THAT IS ONE STEP STRICTER THAN THE SLOT FACTORY ───────
//
// `abc27SlotFixtures.ts` exports `SLOT_STATEMENTS` so a runtime control can compare what it sent
// against what it holds. Here the same control is served by DIGESTS: `APPLY_STATEMENT_DIGESTS`
// carries the sha256 of each statement as this module renders it from its own canonical example,
// and a digest cannot be invoked. A caller that wanted the text would have to reproduce it, which
// is precisely what the containment rule refuses.
//
// ── THE RENDERERS, AND WHY A HOLE HERE IS NOT AN INTERPOLATION ────────────────────────────────
//
// Four of the seven carry holes. Three of them carry ARRAY SHAPES and the fourth does not — and
// the reason stated here has been wrong TWICE, so it is stated carefully.
//
// MEASURED, NOT ASSUMED. `node-postgres` DOES express a multidimensional array: its serializer
// recurses, so `prepareValue([['a'],['b']])` returns `{{"a"},{"b"}}`, and a NULL member comes back
// as `{"a",NULL}`. It also passes a STRING through untouched, so `prepareValue('[0:1]={a,b}')`
// binds a non-one-based array as text — which is why "a bound parameter cannot carry a lower
// bound", this comment's first correction, was wrong too.
//
// The true statement is narrower than both: a native JavaScript `Array` does not PRESERVE a
// lower bound, because the bound is not part of the value. Rendering is how these three
// statements get one; binding a hand-written text would be the alternative, and the other shapes
// are rendered alongside for uniformity rather than from necessity.
//
// The fourth is `APPLY_AS_ACTOR_REFUSAL_PROBE`, which renders exactly one academy UUID and could
// have been a bound parameter. It is stated here rather than quietly counted with the other
// three: it is a template because it was written beside them, not because a parameter could not
// carry its value. Those statements are templates whose every
// hole is a direct call to one of the closed renderers below. A renderer is total over VALIDATED
// scalars — a canonical UUID, an ISO date, a letters-and-spaces label, canonical hex that arrived
// as a primitive string — and none of those can contain a quote, a bracket, a comma or a paren, so
// no rendered value can change what the statement IS. The guard audits that structurally: every
// hole must be a call to
// a named renderer, and each constant with its holes filled by canonical examples is parsed by
// PostgreSQL's own grammar and must invoke exactly the entrypoint's declared routine.
//
// ── THE HONEST CLAIM ──────────────────────────────────────────────────────────────────────────
//
// Every invocation of the two writing apply routines in this suite goes through an entrypoint
// here, which checks slot and target ownership on the evaluated values in every run. The static
// guard refuses any direct spelling of those routine names outside this file and makes NO
// dataflow claim: a routine name assembled at run time out of fragments that never spell it is
// the named residual, and it is the same residual class the slot-write promise already carries.
import { createHash } from 'node:crypto';
import { isAnyArrayBuffer, isArrayBuffer, isArrayBufferView, isUint8Array } from 'node:util/types';
import type pg from 'pg';
import { assertSlotsNotForeign, noteSlotsOwned, verifyStoredSlots } from './abc27TrainerAuthority';

// ══ THE VALIDATED SCALARS ════════════════════════════════════════════════════════════════════
//
// A value that reaches a rendered position is checked against the shape its column actually
// admits, and a value that fails is a THROW rather than a rendering. That is deliberate: the
// alternative — rendering something else, or quoting defensively — is how a validator becomes a
// sanitiser, and a sanitiser is a thing to defeat. There is nothing to defeat here because there
// is no escape hatch: the value is one of these shapes or the call does not happen.

/** The canonical hyphenated UUID, in either case. The same shape the trainer registry keys on. */
const CANONICAL_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/**
 * A bare ISO calendar date. The holiday columns are `date`, and nothing else belongs there.
 *
 * THE SHAPE IS NOT THE VALUE. `2026-99-99` matched this and rendered perfectly well, and the
 * refusal then came from PostgreSQL at cast time instead of from here — which is a worse place
 * for it: the statement had already been built and sent. `isIsoDate` asks the calendar.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: string): boolean => {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
};
/** A holiday label: letters and spaces. Both labels the suite submits are single words. */
const PLAIN_LABEL = /^[A-Za-z ]+$/;
/**
 * THE CANONICAL HEX GRAMMAR: lower-case digits in whole byte PAIRS, and nothing else. It is what
 * `Buffer.prototype.toString('hex')` produces, and the empty string — an empty `bytea` — matches.
 *
 * THIS IS REACHABLE, AND IT USED TO BE DOCUMENTED AS NOT. When the boundary took a `Buffer` the hex
 * came from a captured intrinsic and could not be odd-length or upper-case, so this test was a
 * second line nothing could reach. The boundary takes a primitive string now, and the string is
 * whatever the caller wrote: this grammar is what every caller-supplied fingerprint is held to at
 * `canonicalByteaHex`, and the runtime controls drive it with an upper-case digit, an odd digit
 * count and a non-hex character, each refused before anything is sent. Case is NOT folded and an
 * odd count is NOT padded — a value that is not already canonical is a refusal, not a repair.
 */
const LOWER_HEX = /^(?:[0-9a-f]{2})*$/;

/** What the elements of a rendered array are, and therefore how they are validated and cast. */
export type RenderedElementType = 'uuid' | 'date' | 'text';

// A SHAPE IS ANYTHING THAT CAN ANSWER `test`, because one of the three is no longer a regexp:
// a calendar date cannot be decided by a pattern, and pretending it could is what let
// `2026-99-99` through to PostgreSQL.
const ELEMENT_SHAPE: Readonly<Record<RenderedElementType, { test: (v: string) => boolean }>> =
  Object.freeze({
  uuid: CANONICAL_UUID, date: { test: isIsoDate }, text: PLAIN_LABEL,
});

/** @renderer-scalar One element, validated and returned UNCHANGED so the bytes cannot move. */
const scalar = (value: string, type: RenderedElementType): string => {
  if (typeof value !== 'string' || !ELEMENT_SHAPE[type].test(value)) {
    throw new Error(`abc27 apply catalogue: ${JSON.stringify(value)} is not a ${type} this may `
      + 'render — a rendered value may only be a shape that cannot carry a quote, a bracket, a '
      + 'comma or a paren, because a value that could would decide what the statement IS.');
  }
  return value;
};

/**
 * ══ THE CLOSED RENDERERS ═════════════════════════════════════════════════════════════════════
 *
 * Private, total over validated scalars, and the ONLY expressions a statement template's hole may
 * call. Each is one of the four array presentations the shape controls submit plus the two
 * scalar literal forms; there is no general "render a value" among them, and that is the point.
 */

/** A discriminated union over the four array PRESENTATIONS the replay-shape controls submit. */
export type RenderedArray =
  /** `ARRAY['a','b']::T[]`, including the empty `ARRAY[]::T[]`. */
  | { readonly kind: 'literal'; readonly type: RenderedElementType;
      readonly values: readonly string[] }
  /** `'{{a},{b}}'::T[]` — two rows of one element, flattening to the identical element list. */
  | { readonly kind: 'multidim-2x1'; readonly type: RenderedElementType;
      readonly values: readonly string[] }
  /** `'[0:N]={a,b}'::T[]` — the same elements with a lower bound of zero. */
  | { readonly kind: 'zero-based'; readonly type: RenderedElementType;
      readonly values: readonly string[] }
  /** `ARRAY['a',NULL,'c']::T[]` — a NULL member, which is not an identity. */
  | { readonly kind: 'with-null'; readonly type: RenderedElementType;
      readonly values: readonly (string | null)[] };

/** @renderer `'<uuid>'` — a quoted canonical UUID and nothing else. */
const uuidLiteral = (value: string): string => `'${scalar(value, 'uuid')}'`;

/** The intrinsic, captured at module load, so no instance or subclass can substitute its own. */
const BUFFER_TO_STRING: (this: unknown, enc: string) => unknown = Buffer.prototype.toString;

/**
 * ══ THE BINARY BOUNDARY IS A CANONICAL HEX STRING, NOT A BUFFER ══════════════════════════════
 *
 * FIVE ROUNDS OF REVIEW WENT INTO MAKING A CALLER-OWNED `Buffer` SAFE TO ACCEPT, AND EACH FIX WAS
 * DEFEATED BY THE NEXT QUESTION: an own `valueOf()` redirected `Buffer.from` onto attacker memory;
 * `Buffer.copyBytesFrom` closed that but drew from Node's shared pool, so writing the source's own
 * backing store rewrote the sealed bytes; a `DataView` wearing `Buffer.prototype` satisfied both
 * `ArrayBuffer.isView` and `Buffer.isBuffer` and was copied through its own iterator; a
 * `Uint16Array` in the same disguise was copied element-wise; and a `Proxy` in a genuine Buffer's
 * prototype chain ran caller code during the very check meant to authenticate it, on the ACCEPTED
 * path. Every one of those is the same defect wearing a different hat: **a mutable object the
 * caller still owns, whose identity is decided by machinery the caller can reach.**
 *
 * So the object is gone from the contract. What crosses this boundary is a PRIMITIVE STRING of
 * canonical lower-case hex: it cannot be mutated after validation, it has no prototype chain worth
 * trapping, no `valueOf`, no iterator, and no backing store to alias. The database is unchanged —
 * `pg_catalog.decode($n::text,'hex')` turns the same hex into the same `bytea` the same routine
 * always received — so this is a change of what the CLIENT may hand over, not of what PostgreSQL
 * is asked to do.
 *
 * WHAT IS NOT CLAIMED: this is not a claim that no caller code can ever run for an arbitrary
 * invalid object. A `typeof` test on an exotic object runs nothing, but this file does not pretend
 * to have audited every path an arbitrary value could take through V8 before reaching it. The
 * claim is narrower and is what the controls drive: what is VALIDATED is what is SENT, and the
 * validated thing is a primitive.
 */
declare const CANONICAL_BYTEA_HEX: unique symbol;
export type CanonicalByteaHex = string & { readonly [CANONICAL_BYTEA_HEX]: true };

/**
 * The one way a fingerprint enters this module: a primitive string of canonical hex.
 *
 * `typeof value !== 'string'` refuses a `Buffer`, a `Uint8Array`, a `DataView`, an `ArrayBuffer`,
 * any other object and `undefined` alike, BEFORE anything is sent. The value is never formatted
 * into the message — only its `typeof` is named — because formatting an object is how a rejected
 * value gets to run code while being described.
 *
 * THE LENGTH IS NOT PINNED AT 64. The product rule that a review fingerprint is 32 bytes lives in
 * the database, which remains its authority; pinning it here as well would make this file a second
 * place that has to be right about a rule it does not own, and the suite's own short-fingerprint
 * negative case exists precisely to watch PostgreSQL enforce it.
 */
const canonicalByteaHex = (value: unknown, where: string): CanonicalByteaHex => {
  if (typeof value !== 'string') {
    throw new Error(`abc27 apply catalogue: ${where} is a ${typeof value}, and the binary boundary `
      + 'here takes a primitive string of canonical hex. A Buffer, a typed array, a DataView, an '
      + 'ArrayBuffer or any other object is refused before anything is sent: an object the caller '
      + 'still owns can change after it is checked, and a primitive cannot.');
  }
  if (!LOWER_HEX.test(value)) {
    throw new Error(`abc27 apply catalogue: ${where} is not canonical hex — lower case, in whole `
      + 'byte pairs. The empty string is a valid empty bytea and is accepted.');
  }
  return value as CanonicalByteaHex;
};

// ── THE ADAPTER FROM WHAT `node-postgres` HANDS BACK, WHICH IS THE ONLY BYTE VIEW THIS TRUSTS ──
//
// A `bytea` column comes back from the driver as a byte view, and a test that wants to compare it
// against a fingerprint needs it in the boundary's own currency. That conversion is the ONE place
// a byte view is still read, so it is done through internal-slot questions only.
//
// `isUint8Array` answers from the internal slot: true for a genuine `Buffer` and a genuine plain
// `Uint8Array`, false for a `Uint16Array`, a `DataView` (even one whose `Symbol.toStringTag` says
// otherwise), an `Object.create(Buffer.prototype)` and a `Proxy` wrapping any of them. That is
// exactly the separation five rounds of `Buffer.isBuffer`, `instanceof`, `ArrayBuffer.isView` and
// `Object.prototype.toString` tag tests failed to make, which is why none of them appear here.
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
/** The accessor an intrinsic prototype declares, taken from the descriptor rather than invoked
 *  through the value — which is the whole point: the value never chooses which getter answers. */
const intrinsicGetter = (owner: object, key: PropertyKey): ((this: unknown) => unknown) =>
  (Object.getOwnPropertyDescriptor(owner, key) as { get: (this: unknown) => unknown }).get;
const VIEW_BUFFER = intrinsicGetter(TYPED_ARRAY_PROTO, 'buffer');
const BUFFER_RESIZABLE = intrinsicGetter(ArrayBuffer.prototype, 'resizable');
const BUFFER_DETACHED = intrinsicGetter(ArrayBuffer.prototype, 'detached');

/**
 * Convert a byte view the DRIVER produced into the boundary's canonical hex.
 *
 * The backing store must be an ordinary `ArrayBuffer` that is attached and fixed-size. A
 * `SharedArrayBuffer` is refused because another thread can rewrite it between the read and the
 * comparison; a detached one because its bytes are gone and `toString` would answer `''` as though
 * the value were legitimately empty; a resizable one because its length is not the length that was
 * checked. Only after those questions is the captured `Buffer.prototype.toString` intrinsic
 * applied — on the view itself, with no copy, no instance method, no iterator and no
 * `Uint8Array.from`.
 */
export const canonicalByteaHexFromBytes = (
  value: unknown, where: string,
): CanonicalByteaHex => {
  if (!isUint8Array(value)) {
    throw new Error(`abc27 apply catalogue: ${where} is not a genuine Uint8Array byte view, so it `
      + 'is not something the driver produced. It is refused without being read.');
  }
  const backing = VIEW_BUFFER.call(value);
  if (!isArrayBuffer(backing)) {
    throw new Error(`abc27 apply catalogue: ${where} is backed by shared memory, which another `
      + 'thread can rewrite between the read and the comparison.');
  }
  if (BUFFER_DETACHED.call(backing) === true) {
    throw new Error(`abc27 apply catalogue: ${where} is backed by a detached buffer, whose bytes `
      + 'would read as an empty value rather than as the failure it is.');
  }
  if (BUFFER_RESIZABLE.call(backing) === true) {
    throw new Error(`abc27 apply catalogue: ${where} is backed by a resizable buffer, so the `
      + 'length that was checked need not be the length that is read.');
  }
  const hex: unknown = BUFFER_TO_STRING.call(value, 'hex');
  return canonicalByteaHex(hex, where);
};

/**
 * @renderer `pg_catalog.decode('<hex>','hex')` — the bytea value, over the canonical hex itself.
 *
 * THE COERCION PROBLEMS THIS USED TO CARRY ARE GONE WITH THE BUFFER. It used to take a caller's
 * `Buffer`, call the captured `toString` intrinsic on it because an instance or subclass could
 * override its own, and then re-check the result because an override could return an object that
 * `LOWER_HEX.test(…)` and `${…}` would coerce two different ways. None of that applies to a value
 * that was already a primitive string when it was validated: there is one reading, and the thing
 * rendered is the thing that was checked.
 *
 * WHAT REMAINS TRUE, AND IS THE REASON FOR THE `decode` FORM: `'\x6162'::bytea` is the hex input
 * form only while `standard_conforming_strings` is `on`; with it `off` the backslash is a string
 * escape and the same literal means different bytes. `pg_catalog.decode(…, 'hex')` contains no
 * backslash at all, so the value does not depend on a GUC this file does not set, and the call is
 * schema-qualified for the same reason every other one is.
 */
const byteaHexLiteral = (value: unknown): string =>
  `pg_catalog.decode('${canonicalByteaHex(value, 'a rendered bytea literal')}','hex')`;

/** The four presentations, and the three element types. Both are CLOSED SETS, checked at run
 *  time as well as in the type: a discriminant reaches the rendered text (`::${type}[]`,
 *  `'[0:N]={…}'`) and a caller that arrived through `as never` — which is how every fixture that
 *  smuggles a value gets there — is not held to the union by anything the compiler did. */
const RENDERED_KINDS: readonly string[] =
  Object.freeze(['literal', 'multidim-2x1', 'zero-based', 'with-null']);

/** @renderer One of the four array presentations, validated element by element. */
const renderArray = (a: RenderedArray): string => {
  const type = a.type;
  // ── THE DISCRIMINANT AND THE ELEMENT TYPE ARE VALUES TOO ──────────────────────────────────
  //
  // Every ELEMENT is validated below and cannot carry punctuation. `type` is interpolated
  // straight into the cast, so it is exactly as dangerous as an element and was exactly as
  // unvalidated — a review round supplied `type: "uuid[] || ARRAY['<foreign>'::uuid]::uuid"` with
  // an EMPTY value list, which validated nothing and rendered a second array expression into the
  // statement. Both discriminants are now held to their closed sets.
  if (!Object.prototype.hasOwnProperty.call(ELEMENT_SHAPE, type)
    || !RENDERED_KINDS.includes(a.kind)) {
    throw new Error(`abc27 apply catalogue: ${JSON.stringify(a.kind)}/${JSON.stringify(type)} is `
      + 'not one of the closed array presentations this may render — a discriminant reaches the '
      + 'statement text, so it is a value like any other.');
  }
  if (a.kind === 'literal') {
    return `ARRAY[${a.values.map((v) => `'${scalar(v, type)}'`).join(',')}]::${type}[]`;
  }
  if (a.kind === 'with-null') {
    return `ARRAY[${a.values.map((v) => (v === null ? 'NULL' : `'${scalar(v, type)}'`))
      .join(',')}]::${type}[]`;
  }
  // ── THE ARRAY-INPUT FORMS QUOTE EVERY ELEMENT, AND THEY USED NOT TO ──────────────────────
  //
  // The two forms below build PostgreSQL's array INPUT text rather than an `ARRAY[...]`
  // constructor, and an UNQUOTED element in that syntax is not the string it looks like. Three
  // values `PLAIN_LABEL` accepts did not survive the trip:
  //
  //   · `NULL` — four ordinary letters — is the SQL null, so `{{NULL},{X}}` reads back as
  //     `[[null],["X"]]` and a label became an absence;
  //   · leading and trailing spaces are stripped, so `[0:1]={  A,B  }` reads back `["A","B"]`;
  //   · an all-space label renders `{   }`, which is not valid input at all.
  //
  // Double quotes fix all three and cost nothing: `PLAIN_LABEL` is letters and spaces, so no
  // element can contain a quote, a backslash, a brace or a comma, and quoting is therefore
  // lossless and cannot change the shape. The `ARRAY[...]` forms above were always safe —
  // they quote with `'` already — which is why only these two are changed.
  const quoted = (v: string): string => `"${scalar(v, type)}"`;
  if (a.kind === 'multidim-2x1') {
    if (a.values.length !== 2) {
      throw new Error('abc27 apply catalogue: a 2x1 multidimensional array has exactly two rows.');
    }
    return `'{{${quoted(a.values[0])}},{${quoted(a.values[1])}}}'::${type}[]`;
  }
  if (a.values.length === 0) {
    throw new Error('abc27 apply catalogue: a zero-based array with no elements has no bounds.');
  }
  return `'[0:${a.values.length - 1}]={${a.values.map(quoted).join(',')}}'::${type}[]`;
};

/** Every UUID a rendered array carries, so the guard judges the values that actually arrive. */
const uuidsOf = (a: RenderedArray): string[] =>
  (a.type === 'uuid' ? a.values.filter((v): v is string => typeof v === 'string') : []);

// ══ THE STATEMENTS ═══════════════════════════════════════════════════════════════════════════
//
// One per writing call path. They WERE byte-identical to what the suite sent before the
// conversion, and two of them deliberately are not any more: the array-input forms now quote
// every element (a label spelled `NULL` was becoming the SQL null) and the bytea value is a
// `decode(…)` call rather than a backslash literal (which meant different bytes under a
// different `standard_conforming_strings`). Both changes are corrections, and saying so
// here is the point: a preservation claim that quietly stopped being true is worse than none.
// Everything else is unchanged, so no database outcome, no digest pin and no product assertion
// moved with the architecture. Each is module-private: nothing outside this file can obtain one,
// and the export surface is pinned so that stays true.

/** The normalized apply core, fully parameterised. The shared driver's statement. */
const APPLY_NORMALIZED_CORE = `SELECT * FROM public.rebook_round_apply_normalized_core(
       $1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
       $22,$23,$24,$25,$26,$27,$28::date[],$29::date[],$30::text[],$31::uuid[],$32::uuid[],$33::uuid[],pg_catalog.decode($34::text,'hex'))`;

/** The `as_actor` wrapper, as the receipt-privacy round drives it: a fixed intent, seven binds. */
const APPLY_AS_ACTOR_RECEIPT_PRIVACY = `SELECT * FROM public.rebook_round_apply_command_as_actor(
           $1,$2,'abc27.wire.v1','create',$3,NULL,'Receipt privacy','2026-10-05'::date,NULL::date,2,
           7,0,'deferred_split',false,'inherit',false,false,NULL,true,NULL,
           NULL,NULL,NULL,NULL,NULL,NULL,
           '{}'::date[],'{}'::date[],'{}'::text[],$4::uuid[],$5::uuid[],$6::uuid[],pg_catalog.decode($7::text,'hex'))`;

/**
 * The wrapper refusal matrix's apply arm: every array is minted by the SERVER inside the
 * statement, so this is the one entrypoint that carries no client-minted slot at all.
 */
const APPLY_AS_ACTOR_REFUSAL_PROBE = (a: RefusalProbeArgs): string =>
  `SELECT * FROM public.rebook_round_apply_command_as_actor(
         ${uuidLiteral(a.academy)}::uuid,pg_catalog.gen_random_uuid(),'abc27.wire.v1','create',pg_catalog.gen_random_uuid(),
         NULL::int,'L','2026-09-01'::date,NULL::date,4,7,0,'deferred_split',false,'inherit',
         false,false,NULL::numeric,true,NULL::int,NULL::text,NULL::text,NULL::text,NULL::text,
         NULL::text,NULL::text,ARRAY[]::date[],ARRAY[]::date[],ARRAY[]::text[],
         ARRAY[pg_catalog.gen_random_uuid()],ARRAY[pg_catalog.gen_random_uuid()],ARRAY[pg_catalog.gen_random_uuid()],
         pg_catalog.sha256('x'::bytea))`;

/** The replay-SHAPE driver: the six array arguments arrive as rendered SQL, which is the point. */
const APPLY_NORMALIZED_CORE_SHAPED = (s: ShapedApplySpec): string =>
  `SELECT * FROM public.rebook_round_apply_normalized_core(
           $1,$2,'abc27.wire.v1','create',$3,$4,NULL::int,'C replay shape','2026-10-05'::date,
           NULL::date,2,7,0,'deferred_split',false,'inherit',false,false,NULL::numeric,true,
           NULL::int,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
           ${renderArray(s.holidayFrom)},
           ${renderArray(s.holidayTo)},
           ${renderArray(s.holidayLabel)},
           ${renderArray(s.sources)},
           ${renderArray(s.children)},
           ${renderArray(s.targetArray)},
           pg_catalog.decode($5::text,'hex'))`;

/** The extend arm's shape control: its holiday presentation is FIXED, its identities rendered. */
const APPLY_NORMALIZED_CORE_SHAPED_EXTEND = (s: ExtendShapeSpec): string =>
  `SELECT * FROM public.rebook_round_apply_normalized_core(
           $1,$2,'abc27.wire.v1','extend',$3,$4,1,'C replay shape','2026-10-05'::date,NULL::date,
           2,7,0,'deferred_split',false,'inherit',false,false,NULL::numeric,true,
           NULL::int,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
           ARRAY[]::date[], ARRAY['2026-12-22']::date[], ARRAY[]::text[],
           ${renderArray(s.sources)}, ${renderArray(s.children)},
           ${renderArray(s.targetArray)}, pg_catalog.decode($5::text,'hex'))`;

/**
 * The revoked-manager barrier. It runs on a second connection whose membership row has just been
 * deleted, and it is spelled `SELECT status, round_id FROM …` rather than `SELECT * FROM …` —
 * which is exactly how it once went uncounted by a reader that matched on the projection.
 */
const APPLY_AS_ACTOR_RENDERED_BARRIER = (s: BarrierApplySpec): string => `
        SELECT status, round_id FROM public.rebook_round_apply_command_as_actor(
          ${uuidLiteral(s.academy)}::uuid, pg_catalog.gen_random_uuid(), 'abc27.wire.v1', 'create',
          ${uuidLiteral(s.round)}::uuid, NULL::int, 'C barrier revoked', '2026-10-05'::date, NULL::date,
          2, 7, 0, 'deferred_split', false, 'inherit', false, false, NULL::numeric, true,
          NULL::int, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
          ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[],
          ${renderArray(s.sources)},
          ${renderArray(s.children)},
          ${renderArray(s.targetArray)},
          ${byteaHexLiteral(s.fingerprintHex)})`;

/** The operator-reachability call, in the wrapper's own input shape, fully parameterised. */
const APPLY_AS_ACTOR_REACHABILITY = `SELECT * FROM public.rebook_round_apply_command_as_actor(
      $1::uuid,$2::uuid,'abc27.wire.v1','create',$3::uuid,NULL::int,'Reach','2026-09-01'::date,NULL::date,
      4,7,0,'deferred_split',false,'inherit',false,false,NULL::numeric,true,NULL::int,NULL::text,NULL::text,
      NULL::text,NULL::text,NULL::text,NULL::text,ARRAY[]::date[],ARRAY[]::date[],ARRAY[]::text[],
      $4::uuid[],$5::uuid[],$6::uuid[],pg_catalog.decode($7::text,'hex'))`;

// ══ EVERY ARGUMENT IS READ ONCE, BEFORE ANYTHING IS CHECKED OR SENT ══════════════════════════
//
// TWO DEFECTS A REVIEW ROUND FOUND, AND ONE ANSWER TO BOTH.
//
//   (1) THE CHECK AND THE SEND WERE TWO READS. `assertSlotsNotForeign(a.slots …)` and
//       `client.query(…, [… a.slots …])` each evaluated `a.slots`, so an accessor returning `[]`
//       the first time and a foreign slot the second satisfied the check and sent something else.
//       That is the getter shape this whole batch exists to be immune to, arriving one layer
//       further in than where it had been closed.
//
//   (2) A NON-STRING ELEMENT WAS SKIPPED BY THE CHECK AND SERIALIZED BY THE DRIVER.
//       `assertSlotsNotForeign` deliberately ignores an element that is not a string — several
//       fixtures pass a `null` or a ghost on purpose — while `node-postgres` calls a value's own
//       `toPostgres()` when it has one. An element `{ toPostgres: () => <a foreign slot> }` was
//       therefore checked as nothing and sent as that slot. Measured against the installed driver.
//
// So the arguments are SEALED first: every field, every array and every array element is read
// exactly once into a plain structure, and the entrypoint then checks and sends THAT. The guard
// audits it structurally — the parameter's own identifier may not appear anywhere after the seal —
// so an entrypoint cannot go back to the caller's object for the value it sends.
//
// AND THE SEAL IS FAIL-CLOSED ON SHAPE. An identity, date or label list carries strings, or a
// deliberate `null`; anything else is REFUSED rather than skipped, which closes (2) at this
// boundary instead of asking the frozen registry to change what it ignores. A FUNCTION anywhere
// in the sealed structure is refused for the same reason: a function is the one way a value can
// decide what it serializes to.

/**
 * One element of an identity, date or label list. A `null` is a deliberate fixture value.
 *
 * `undefined` IS NOT `null` HERE, AND IT USED TO BE ACCEPTED AS THOUGH IT WERE. The contract
 * above says strings or a deliberate `null`, and this arm quietly took a third thing. It is not
 * harmless: `node-postgres` serializes an undefined array member as SQL `NULL`, so an element
 * nobody decided to send arrived at the server indistinguishable from one somebody did. A hole
 * in an array is far more often a bug at the call site — a lookup that missed, an index past the
 * end — than a deliberate value, and the deliberate value already has a spelling. So the seal
 * now refuses it and says which element it was.
 */
const sealedElement = (x: unknown, where: string): unknown => {
  if (x === null || typeof x === 'string') return x;
  if (x === undefined) {
    throw new Error(`abc27 apply catalogue: ${where} is \`undefined\`, and an identity, date or `
      + 'label list carries strings or a deliberate `null`. The driver would send it as SQL NULL, '
      + 'which is indistinguishable from a null somebody chose, so it is refused here. Write '
      + '`null` if the absence is deliberate.');
  }
  throw new Error(`abc27 apply catalogue: ${where} is not a string, and an identity, date or `
    + 'label list carries strings. A value that is not one is SKIPPED by the ownership check and '
    + 'may still be serialized by the driver, so it is refused here rather than ignored there.');
};

const sealedValue = (v: unknown, where: string, depth: number): unknown => {
  if (depth > 3) {
    throw new Error(`abc27 apply catalogue: ${where} nests deeper than this seals.`);
  }
  if (typeof v === 'function') {
    throw new Error(`abc27 apply catalogue: ${where} is a function, and a function is how a value `
      + 'decides what it serializes to. The arguments here are data.');
  }
  if (Array.isArray(v)) {
    // ── AN INDEX LOOP, NOT `v.map` ──────────────────────────────────────────────────────────
    //
    // `map` is a property of the value being sealed, and an array may own a replacement that
    // ignores the callback entirely and returns whatever it likes — including an object carrying
    // `toPostgres()`, which the ownership check skips as a non-string and the driver then
    // serializes. A review round named exactly that. Reading `length` and each index directly
    // takes the caller's data without calling the caller's code; an index accessor that lies can
    // only hide an element from the copy, and a hidden element is not sent either.
    const out = [];
    for (let i = 0; i < v.length; i += 1) out.push(sealedElement(v[i], `${where}[${i}]`));
    return out;
  }
  // NO BUFFER COPY — THE BINARY BOUNDARY IS A PRIMITIVE NOW, AND THIS IS WHERE THAT SHOWS.
  //
  // This seal used to carry a dedicated `Buffer` copy: a private, exact-size byte snapshot behind
  // a three-part gate, reached after five review rounds of an own `valueOf` redirecting
  // `Buffer.from`, `Buffer.copyBytesFrom` drawing from Node's shared pool, a `DataView` and a
  // `Uint16Array` wearing `Buffer.prototype`, and a `Proxy` prototype running caller code on the
  // ACCEPTED path. All of it is deleted rather than extended, because the thing it was defending
  // — a mutable object the caller still owns — is no longer part of the contract. Fingerprints
  // arrive as canonical hex strings and are validated by `canonicalByteaHex`.
  //
  // ── AND A BINARY SHAPE IS REFUSED HERE, BEFORE A SINGLE ELEMENT OF IT IS READ ──────────────
  //
  // Without this arm a `Buffer` fell through to the object branch below, which copies every own
  // enumerable property — for a byte view that is every byte, and for a `Buffer` a caller has
  // given an enumerable accessor to, that is caller code running inside the seal, on a value the
  // boundary was about to refuse anyway. A review round measured the accessor firing. The two
  // questions asked here are internal-slot questions (`isAnyArrayBuffer` covers an `ArrayBuffer`
  // and a `SharedArrayBuffer`; `isArrayBufferView` covers every typed array, a `DataView` and
  // therefore a `Buffer`), so nothing on the value is consulted, and the message names the shape
  // without formatting the value. A byte view is converted to hex in exactly ONE place,
  // `canonicalByteaHexFromBytes`, and only for what the DRIVER hands back — an ARGUMENT that is a
  // byte view is refused, never converted on the caller's behalf.
  if (isAnyArrayBuffer(v) || isArrayBufferView(v)) {
    throw new Error(`abc27 apply catalogue: ${where} is a binary buffer or a view over one, and `
      + 'the binary boundary here takes a primitive string of canonical hex. It is refused at the '
      + 'seal, before any of its bytes or properties are read: a value the caller still owns can '
      + 'change after it is checked, and a primitive cannot.');
  }
  if (v !== null && typeof v === 'object') {
    // `Object.create(null)`, NOT `{}` — an adversarial review found that an own enumerable
    // property literally named `__proto__` (reachable via `Object.defineProperty`, not merely
    // `{__proto__: x}` object-literal syntax, which sets the prototype instead of creating one)
    // is copied by the loop below exactly like any other key. Assigning it into an ordinary `{}`
    // reaches `Object.prototype`'s own `__proto__` SETTER and changes the copy's actual
    // prototype — so a field this loop never saw as an own property (because the caller's own
    // object never had one either) can still answer through the poisoned prototype's chain on
    // EVERY subsequent read of the "sealed" copy, exactly the read-more-than-once shape sealing
    // exists to remove. A null-prototype target has no inherited setter to hijack and no
    // inherited getter to fall through to: the copied `__proto__` key becomes inert data like
    // any other, and a field the caller never truly supplied reads back as `undefined`.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // `Object.keys` reads each own enumerable property ONCE, accessor or not, which is the whole
    // point: after this line the caller's object is never consulted again.
    for (const key of Object.keys(v as Record<string, unknown>)) {
      out[key] = sealedValue((v as Record<string, unknown>)[key], `${where}.${key}`, depth + 1);
    }
    return out;
  }
  return v;
};

/** Read an argument record once. The entrypoints check and send the result, never the input. */
const sealed = <T>(o: T): T => sealedValue(o, 'an apply argument', 0) as T;

/**
 * ══ WHETHER THE APPLY'S OWN, TRUSTED RESULT SAYS NOTHING WAS WRITTEN ═══════════════════════════
 *
 * `'refused'` is the WRAPPER's own word, not the core's. Of the two writing routines this
 * catalogue calls, only `rebook_round_apply_command_as_actor` resolves a session identity at all —
 * `rebook_round_apply_normalized_core` takes its actor as a plain `uuid` parameter and returns
 * `'refused'` for nothing; its own closed-caller outcomes are named things like `'invalid_request'`
 * (confirmed by reading the migration, not assumed). Every entrypoint here that calls the CORE
 * directly therefore never receives `'refused'` at all on a closed path, only on a genuinely
 * written one does `wasRefused` matter for it — see the paragraph below `wasRefused`'s own
 * definition for exactly which entrypoints those are and why that is still safe. All seven
 * statements this catalogue holds begin `status text`, which is what STANDS IN for a
 * database-side call the verification step must not make.
 *
 * ── MEASURED, NOT ASSUMED: THE STORED-RESULT READ ITSELF CAN CREATE THE ORACLE IT EXISTS TO
 *    CLOSE ────────────────────────────────────────────────────────────────────────────────────
 *
 * The read-back is an ordinary, unprivileged `SELECT` — unlike the WRAPPER, which is
 * `SECURITY DEFINER` and catches a malformed `auth.uid()` internally (`BEGIN v_actor := auth.uid();
 * EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;`) before ever reaching a refusal branch. A
 * caller whose own session carries a malformed subject — exactly the "a raise would itself be an
 * oracle" scenario the operator-wrapper reachability suite drives — trips NO exception inside the
 * wrapper, which closes cleanly with `status = 'refused'`. But the read-back's plain
 * `SELECT` against `availability_slots` is subject to that TABLE's own row-level security, whose
 * policy evaluates `auth.uid()` again, uncaught — and for that same malformed subject, THAT
 * evaluation throws. The result: a malformed-subject caller would receive a JavaScript exception
 * instead of the uniform closed row every other unauthorized caller gets — a NEW, distinguishing
 * failure mode this catalogue exists to not have. Measured directly against the real suite, not
 * assumed: `abc27RecipientSnapshot.realpg.test.ts`'s own "fails every unauthorized principal
 * closed, with zero mutation and no permission oracle" reproduced it.
 *
 * Skipping the read-back when the apply's own result already says `'refused'` closes this without
 * a new database object, trigger, schema, role or permission — the FIX is which client-side query
 * gets sent, not anything server-side.
 *
 * NARROWLY, NOT "NOTHING WAS WRITTEN" IN GENERAL. `'refused'` is not the only status a write-side
 * call can answer with zero mutation — the core also answers `'invalid_request'`,
 * `'round_not_found'`, `'expected_version_mismatch'` and several others. This predicate does not,
 * and does not need to, recognize those. The oracle above is specific to a caller whose SESSION
 * itself is malformed, reaching the read-back with an auth context the WRAPPER's own `EXCEPTION
 * WHEN OTHERS` swallowed but `availability_slots`'s policy would not — and that shape needs a
 * session identity to have been resolved at all, which happens in exactly one place:
 *
 *   · WRAPPER-MEDIATED entrypoints (`applyCommandAsActor*`) reach any other status only past the
 *     wrapper's gate, so a read-back following one runs under an already well-formed context.
 *   · DIRECT-CORE entrypoints (`applyNormalizedCore` and the two `*Shaped*`) never invoke the
 *     wrapper, so they pass NO auth gate — the core resolves no session at all, taking its actor
 *     as a plain parameter, and the paragraph below says what that does and does not buy.
 *
 * Neither route reproduces the failure mode, for those two different reasons. Attempting the
 * read-back after one of those other statuses is a redundant, harmless query against ids that were
 * never written, not a required skip — `wasRefused` is deliberately the one check this property
 * needs, not a general "was anything written" test.
 *
 * A NAMED RESIDUAL, NOT A LIVE ONE: `applyNormalizedCore` and the two `*Shaped*` entrypoints call
 * the core routine directly, bypassing the wrapper's `auth.uid()` resolution entirely — and the
 * core takes its actor as a plain `uuid` PARAMETER, never calling `auth.uid()` itself, so it has no
 * session to be malformed and cannot raise this failure mode by itself. What keeps this true today
 * is that the core is revoked from every runtime-facing role (grantable only to the wrapper's own
 * definer), not anything this predicate checks — a future grant giving some other caller direct
 * execute access, paired with that caller resolving its OWN identity the same uncaught way the
 * wrapper's gate does, would need this property re-examined. That is a role/permission change, out
 * of this batch's scope, and is named here rather than guarded against speculatively.
 */
const wasRefused = (result: pg.QueryResult): boolean =>
  (result.rows[0] as { status?: unknown } | undefined)?.status === 'refused';

// ══ THE TYPED ENTRYPOINTS ════════════════════════════════════════════════════════════════════

/** The thirty-four fields the normalized apply core takes, in the order it takes them. */
export interface NormalizedCoreArgs {
  actor: unknown; academy: unknown; version: unknown; kind: unknown; command: unknown;
  round: unknown; expected: unknown; label: unknown; start: unknown; end: unknown;
  weeks: unknown; prio: unknown; member: unknown; pay: unknown; strict: unknown;
  mode: unknown; split: unknown; review: unknown; price: unknown; auto: unknown;
  lead: unknown; isub: unknown; ibody: unknown; rsub: unknown; rbody: unknown;
  rules: unknown; claim: unknown; hFrom: unknown; hTo: unknown; hLabel: unknown;
  slots: readonly unknown[] | undefined;
  children: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  fingerprintHex: unknown;
}

/** The receipt-privacy round's seven binds. */
export interface ReceiptPrivacyArgs {
  academy: unknown; command: unknown; round: unknown;
  slots: readonly unknown[] | undefined;
  children: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  fingerprintHex: unknown;
}

/** The refusal probe's one rendered value. It supplies no slot and claims no target. */
export interface RefusalProbeArgs { academy: string }

/** The replay-shape driver: five binds, seven registry values, six rendered arrays. */
export interface ShapedApplySpec {
  actor: unknown; academy: unknown; command: unknown; round: unknown; fingerprintHex: unknown;
  slots: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  holidayFrom: RenderedArray; holidayTo: RenderedArray; holidayLabel: RenderedArray;
  sources: RenderedArray; children: RenderedArray; targetArray: RenderedArray;
}

/** The extend shape control: the same, minus the three holiday presentations. */
export interface ExtendShapeSpec {
  actor: unknown; academy: unknown; command: unknown; round: unknown; fingerprintHex: unknown;
  slots: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  sources: RenderedArray; children: RenderedArray; targetArray: RenderedArray;
}

/** The revoked-manager barrier: everything rendered, nothing bound. */
export interface BarrierApplySpec {
  academy: string; round: string; fingerprintHex: unknown;
  slots: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  sources: RenderedArray; children: RenderedArray; targetArray: RenderedArray;
}

/** The operator-reachability call's seven binds. */
export interface ReachabilityArgs {
  academy: unknown; command: unknown; round: unknown;
  slots: readonly string[] | undefined;
  children: readonly unknown[] | undefined;
  targets: readonly string[] | undefined;
  fingerprintHex: unknown;
}

export async function applyNormalizedCore(
  client: pg.Client, args: NormalizedCoreArgs,
): Promise<pg.QueryResult> {
  const a = sealed(args);
  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');
  noteSlotsOwned(a.targets ?? []);
  const result = await client.query(APPLY_NORMALIZED_CORE, [
    a.actor, a.academy, a.version, a.kind, a.command, a.round, a.expected,
    a.label, a.start, a.end, a.weeks, a.prio, a.member, a.pay, a.strict, a.mode, a.split,
    a.review, a.price, a.auto, a.lead, a.isub, a.ibody, a.rsub, a.rbody, a.rules, a.claim,
    a.hFrom, a.hTo, a.hLabel, a.slots, a.children, a.targets,
    canonicalByteaHex(a.fingerprintHex, 'the fingerprint applyNormalizedCore binds'),
  ]);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, a.targets ?? [], 'the target slots applyNormalizedCore created');
  }
  return result;
}

export async function applyCommandAsActorReceiptPrivacy(
  client: pg.Client, args: ReceiptPrivacyArgs,
): Promise<pg.QueryResult> {
  const a = sealed(args);
  assertSlotsNotForeign(a.slots ?? [],
    'the source slots handed to applyCommandAsActorReceiptPrivacy');
  noteSlotsOwned(a.targets ?? []);
  const result = await client.query(APPLY_AS_ACTOR_RECEIPT_PRIVACY,
    [a.academy, a.command, a.round, a.slots, a.children, a.targets,
      canonicalByteaHex(a.fingerprintHex, 'the fingerprint applyCommandAsActorReceiptPrivacy binds')]);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, a.targets ?? [],
      'the target slots applyCommandAsActorReceiptPrivacy created');
  }
  return result;
}

export async function applyCommandAsActorRefusalProbe(
  client: pg.Client, args: RefusalProbeArgs,
): Promise<pg.QueryResult> {
  const a = sealed(args);
  assertSlotsNotForeign([], 'the source slots handed to applyCommandAsActorRefusalProbe');
  noteSlotsOwned([]);
  return client.query(APPLY_AS_ACTOR_REFUSAL_PROBE(a), []);
}

export async function applyNormalizedCoreShaped(
  client: pg.Client, spec: ShapedApplySpec,
): Promise<pg.QueryResult> {
  const s = sealed(spec);
  assertSlotsNotForeign([...(s.slots ?? []), ...uuidsOf(s.sources)],
    'the source slots handed to applyNormalizedCoreShaped');
  noteSlotsOwned([...(s.targets ?? []), ...uuidsOf(s.targetArray)]);
  const result = await client.query(APPLY_NORMALIZED_CORE_SHAPED(s),
    [s.actor, s.academy, s.command, s.round,
      canonicalByteaHex(s.fingerprintHex, 'the fingerprint applyNormalizedCoreShaped binds')]);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, [...(s.targets ?? []), ...uuidsOf(s.targetArray)],
      'the target slots applyNormalizedCoreShaped created');
  }
  return result;
}

export async function applyNormalizedCoreShapedExtend(
  client: pg.Client, spec: ExtendShapeSpec,
): Promise<pg.QueryResult> {
  const s = sealed(spec);
  assertSlotsNotForeign([...(s.slots ?? []), ...uuidsOf(s.sources)],
    'the source slots handed to applyNormalizedCoreShapedExtend');
  noteSlotsOwned([...(s.targets ?? []), ...uuidsOf(s.targetArray)]);
  const result = await client.query(APPLY_NORMALIZED_CORE_SHAPED_EXTEND(s),
    [s.actor, s.academy, s.command, s.round,
      canonicalByteaHex(s.fingerprintHex, 'the fingerprint applyNormalizedCoreShapedExtend binds')]);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, [...(s.targets ?? []), ...uuidsOf(s.targetArray)],
      'the target slots applyNormalizedCoreShapedExtend created');
  }
  return result;
}

export async function applyCommandAsActorRenderedBarrier(
  client: pg.Client, spec: BarrierApplySpec,
): Promise<pg.QueryResult> {
  const s = sealed(spec);
  assertSlotsNotForeign([...(s.slots ?? []), ...uuidsOf(s.sources)],
    'the source slots handed to applyCommandAsActorRenderedBarrier');
  noteSlotsOwned([...(s.targets ?? []), ...uuidsOf(s.targetArray)]);
  const result = await client.query(APPLY_AS_ACTOR_RENDERED_BARRIER(s), []);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, [...(s.targets ?? []), ...uuidsOf(s.targetArray)],
      'the target slots applyCommandAsActorRenderedBarrier created');
  }
  return result;
}

export async function applyCommandAsActorReachability(
  client: pg.Client, args: ReachabilityArgs,
): Promise<pg.QueryResult> {
  const a = sealed(args);
  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyCommandAsActorReachability');
  noteSlotsOwned(a.targets ?? []);
  const result = await client.query(APPLY_AS_ACTOR_REACHABILITY,
    [a.academy, a.command, a.round, a.slots, a.children, a.targets,
      canonicalByteaHex(a.fingerprintHex, 'the fingerprint applyCommandAsActorReachability binds')]);
  if (!wasRefused(result)) {
    await verifyStoredSlots(client, a.targets ?? [],
      'the target slots applyCommandAsActorReachability created');
  }
  return result;
}

// ══ THE INVENTORY, AND THE CANONICAL DRIVE THAT MEASURES IT ══════════════════════════════════
//
// `EXPECTED_CATALOGUE_STATEMENTS = 7` is restated in the guard, which counts the constants it
// audits; the list below is the same seven keyed by entrypoint, and the runtime control drives
// every one of them and asserts BOTH directions — nothing is sent that is not in the inventory,
// and nothing in the inventory goes unsent.
//
// THE EXAMPLES ARE DATA, NOT SQL. Each is the argument record its entrypoint takes, with obvious
// synthetic identities in a range no fixture mints, so driving them claims nothing a real fixture
// could want. The digests are taken over what the entrypoint WOULD send for exactly these
// arguments, which is what lets a runtime drive compare bytes without ever holding a statement.

const EX = (n: number): string => `aca70000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A PRIMITIVE, NOT A `Buffer`. The canonical examples are what the digests are taken over and
// what every runtime control drives, so a mutable object here would put one back into the contract
// through the back door. This is the same fourteen bytes the old `Buffer.from('abc27catalogue')`
// carried, written as the hex the boundary now speaks.
const EX_FINGERPRINT = '6162633237636174616c6f677565' as CanonicalByteaHex;

const EX_SOURCES: RenderedArray = { kind: 'literal', type: 'uuid', values: [EX(11), EX(12)] };
const EX_CHILDREN: RenderedArray = { kind: 'multidim-2x1', type: 'uuid', values: [EX(21), EX(22)] };
const EX_TARGETS: RenderedArray = { kind: 'zero-based', type: 'uuid', values: [EX(31), EX(32)] };
const EX_HOLIDAY_FROM: RenderedArray = { kind: 'literal', type: 'date', values: ['2026-12-21'] };
const EX_HOLIDAY_TO: RenderedArray = { kind: 'with-null', type: 'date',
  values: ['2026-12-22', null] };
const EX_HOLIDAY_LABEL: RenderedArray = { kind: 'literal', type: 'text', values: ['Kerst'] };

/** The exact argument record the runtime control drives each entrypoint with. */
export const APPLY_CANONICAL_EXAMPLES = Object.freeze({
  applyNormalizedCore: Object.freeze({
    actor: EX(1), academy: EX(2), version: 'abc27.wire.v1', kind: 'create', command: EX(3),
    round: EX(4), expected: null, label: 'Catalogue', start: '2026-10-05', end: null,
    weeks: 2, prio: 7, member: 0, pay: 'deferred_split', strict: false, mode: 'inherit',
    split: false, review: false, price: null, auto: true, lead: null, isub: null, ibody: null,
    rsub: null, rbody: null, rules: null, claim: null, hFrom: [], hTo: [], hLabel: [],
    slots: [EX(11)], children: [EX(21)], targets: [EX(31)], fingerprintHex: EX_FINGERPRINT,
  }) as NormalizedCoreArgs,
  applyCommandAsActorReceiptPrivacy: Object.freeze({
    academy: EX(2), command: EX(3), round: EX(4),
    slots: [EX(11)], children: [EX(21)], targets: [EX(31)], fingerprintHex: EX_FINGERPRINT,
  }) as ReceiptPrivacyArgs,
  applyCommandAsActorRefusalProbe: Object.freeze({ academy: EX(2) }) as RefusalProbeArgs,
  applyNormalizedCoreShaped: Object.freeze({
    actor: EX(1), academy: EX(2), command: EX(3), round: EX(4), fingerprintHex: EX_FINGERPRINT,
    slots: [EX(11)], targets: [EX(31)],
    holidayFrom: EX_HOLIDAY_FROM, holidayTo: EX_HOLIDAY_TO, holidayLabel: EX_HOLIDAY_LABEL,
    sources: EX_SOURCES, children: EX_CHILDREN, targetArray: EX_TARGETS,
  }) as ShapedApplySpec,
  applyNormalizedCoreShapedExtend: Object.freeze({
    actor: EX(1), academy: EX(2), command: EX(3), round: EX(4), fingerprintHex: EX_FINGERPRINT,
    slots: [EX(11)], targets: [EX(31)],
    sources: EX_SOURCES, children: EX_CHILDREN, targetArray: EX_TARGETS,
  }) as ExtendShapeSpec,
  applyCommandAsActorRenderedBarrier: Object.freeze({
    academy: EX(2), round: EX(4), fingerprintHex: EX_FINGERPRINT,
    slots: [EX(11)], targets: [EX(31)],
    sources: EX_SOURCES, children: EX_CHILDREN, targetArray: EX_TARGETS,
  }) as BarrierApplySpec,
  applyCommandAsActorReachability: Object.freeze({
    academy: EX(2), command: EX(3), round: EX(4),
    slots: [EX(11)], children: [EX(21)], targets: [EX(31)], fingerprintHex: EX_FINGERPRINT,
  }) as ReachabilityArgs,
});

/** The seven entrypoint names, in the order the inventory is stated. */
export const APPLY_ENTRYPOINTS: readonly string[] = Object.freeze(
  Object.keys(APPLY_CANONICAL_EXAMPLES));

const canonicalTexts = (): Record<string, string> => ({
  applyNormalizedCore: APPLY_NORMALIZED_CORE,
  applyCommandAsActorReceiptPrivacy: APPLY_AS_ACTOR_RECEIPT_PRIVACY,
  applyCommandAsActorRefusalProbe:
    APPLY_AS_ACTOR_REFUSAL_PROBE(APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRefusalProbe),
  applyNormalizedCoreShaped:
    APPLY_NORMALIZED_CORE_SHAPED(APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShaped),
  applyNormalizedCoreShapedExtend: APPLY_NORMALIZED_CORE_SHAPED_EXTEND(
    APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShapedExtend),
  applyCommandAsActorRenderedBarrier: APPLY_AS_ACTOR_RENDERED_BARRIER(
    APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRenderedBarrier),
  applyCommandAsActorReachability: APPLY_AS_ACTOR_REACHABILITY,
});

/**
 * The sha256 of each statement as THIS module renders it from the canonical example above.
 *
 * A DIGEST CANNOT BE INVOKED, which is the whole reason the inventory is spelled this way rather
 * than as the slot factory's `SLOT_STATEMENTS`. It proves the same property — an entrypoint sends
 * the statement this module holds, unmodified, rather than one it assembled — while leaving no
 * text for anything outside this file to obtain, re-send or re-spell.
 */
export const APPLY_STATEMENT_DIGESTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(canonicalTexts())
    .map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])));
