#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ABC-27 SLOT WRITE SURFACE, ENFORCED FROM THE TYPESCRIPT PROGRAM.
//
// `check_trainer_slot_overlap` is one of the 44 shipped triggers, it is live on the ABC-27
// predecessor, Stage-0 pins every one of them `tgenabled='O'`, and it is scoped to `trainer_id`
// ALONE. Nothing truncates between tests. Two fixtures that share a trainer therefore share ONE
// overlap namespace and collide whenever the calendar walks one onto the other — measured, on
// 2026-08-29.
//
// ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY NO LONGER CLAIMS ───────────────────────────────
//
// Its predecessor tried to prove, statically, that each of the suite's 44 slot write sites bound
// `trainer_id` to an authority-issued value. That is a general dataflow question about a 30,000
// line file, and a review round answered it four ways at once:
//
//   · a validated SQL fragment closed one VALUES row and opened another — `x), (foreign, …`;
//   · with commas-inside-parens then admitted, a fragment reached an `unnest` alias carrying
//     `union all values (…)`, where the hole was ONE word token so the arm counter never saw it;
//   · a brand was acquired with no cast at all under `strict: false` — through a CONTAINING type
//     (`{ t: IsolatedTrainerId }` annotated from an `any`), and by widening a branded array to
//     `string[]` and mutating the alias;
//   · source slots reached an apply driver through a GETTER that no syntactic follower evaluates.
//
// Each fix moved the hole. So the architecture moved instead: `src/test/abc27SlotFixtures.ts` is
// now the ONLY place a slot write is spelled, every statement in it is a fixed complete literal
// with values bound as `$k` parameters, and every entrypoint asks the RUNTIME REGISTRY whether
// the current test owns the trainer before it writes.
//
// This script's job is correspondingly small, and it is stated narrowly on purpose:
//
//   G1  NO SLOT WRITE OUTSIDE THE FACTORY. Any statement in the scanned files that writes
//       `availability_slots` — INSERT, UPDATE, MERGE or COPY, in any PostgreSQL spelling, after
//       comment stripping, whitespace folding and `U&'…'`/`U&"…"` decoding, inside dollar-quoted
//       bodies, and however the text is composed from literals (`+`, `.join()`, `.concat()`) —
//       is REFUSED unless it is in the factory. There is no classification to defeat: the answer
//       does not depend on what the statement binds, only on where it is.
//
//       DELETE IS NOT ONE OF THE FOUR, deliberately: removing a row cannot create an overlap
//       namespace, which is the property this exists for. The suite deletes slots in several
//       places and those are not bypasses of anything this claims.
//
//       AND AN UNQUALIFIED FUNCTION NAME IS NOT A BUILT-IN. `FROM unnest($1::uuid[])` resolves
//       through `search_path`, which no reader here can see, so a schema ahead of `pg_catalog`
//       defining a competing `unnest(uuid[])` supplies the rows and the "parameter-bound" trainer
//       is whatever it returned. All three guarded surfaces write `pg_catalog.unnest`, and the
//       unqualified spelling is refused in each of them.
//
//   G2  THE FACTORY'S OWN STATEMENTS ARE PLAIN, AND THE CANONICAL GRAMMAR AUDITS THEM. Each must
//       come from a literal with NO interpolation of any kind — not a template hole, not a
//       concatenation — so no value can change what the statement is. Each such literal is then
//       PARSED BY POSTGRESQL'S OWN PARSER (`libpg-query`, the PG18 grammar line, in WASM): it must
//       be exactly one statement; wherever it assigns `trainer_id` — in a VALUES row, a SELECT
//       projection, a `SET`, a multi-column `SET (a,b) = (x,y)`, an `ON CONFLICT DO UPDATE`, a
//       data-modifying CTE, or inside a PL/pgSQL body read with the same oracle — the value must
//       be a bound parameter or a column of an `unnest($k)` alias belonging to that very write;
//       its source must be a single arm; and it may not plant a trigger on the guarded relation.
//       A statement the grammar cannot read is REFUSED, because an unread statement is an
//       unaudited one.
//
//       WHY A PARSER AND NOT MORE RULES. The predecessor walked tokens and had to know that
//       `INTO` is optional after `MERGE`, that `INSERT INTO t AS s (cols)` is legal, where a
//       `SET` list ends at paren depth zero but not inside a subquery, which `ON CONFLICT`
//       belongs to which write, that `SET (a,b) = (…)` is a real assignment form, and that a
//       parenthesised `UNION` hides both arms one level deeper. Four review rounds found four
//       spellings it had not enumerated, and each fix moved the hole. The grammar already
//       contains every one of those rules, so it is asked instead of re-implemented.
//
//   R1  BRAND MINT CONTAINMENT. Outside the authority module nothing may assert, `satisfies`,
//       re-declare or augment `IsolatedTrainerId` or its brand symbol, and nothing unbranded may
//       reach a position whose type CONTAINS the brand — including through an object property,
//       array element or tuple member, which is the containing-type hole a review round found.
//       A branded ARRAY may not widen either: the alias would share identity with the original.
//
//   R2  DENY THE UNRESOLVABLE. A write statement whose TABLE REFERENCE this cannot resolve is
//       refused wherever it appears — it may be a write to the guarded relation. A literal naming
//       the table that cannot be lexed, or that expands past the bound, is refused the same way.
//
//   R3  BOUNDED EXEMPTIONS. Exactly one `SHARED_NAMESPACE_CONTROL` site — the census control,
//       which writes a shared-namespace slot ON PURPOSE and rolls it back — pinned by marker AND
//       by count. Zero other exemptions, and no database object is exempted from anything.
//
//   R5  THE RUNTIME MODULES ARE NOT DOWNSTREAM OF ANY READER. `abc27TrainerAuthority.ts` imports
//       only `vitest`, `node:crypto` and `pg`; `abc27SlotFixtures.ts` only `pg` and the authority
//       module; `abc27ApplyCatalogue.ts` only `node:crypto`, `pg` and the authority module. None
//       may import this checker or anything under `scripts/` — in any spelling, including a
//       computed `import()`. Everything above is a READER, readers have now been wrong ten times
//       in a row and always in the certifying direction, and the reason none of those was a live
//       defect is this import graph: no reader's verdict can reach the registry that decides at
//       execution time.
//
//   R4  AN INVENTORY TRIPWIRE. The exact number of slot-write statements inside the factory is
//       restated here, so adding one is a deliberate edit rather than a silent one. A site is
//       keyed `file:line:verb:offset`, the offset being the verb token's own position in the
//       literal — so two statements inside ONE literal are two sites.
//
//   ── AND THE APPLY SIDE, WHICH IS THE SAME MOVE MADE TWICE ─────────────────────────────────
//
//   G3  THE CATALOGUE'S OWN STATEMENTS, AUDITED BY THE CANONICAL GRAMMAR. Every invocation of
//       `rebook_round_apply_normalized_core` or `rebook_round_apply_command_as_actor` lives in
//       `src/test/abc27ApplyCatalogue.ts` as a module-private constant. Each is a plain literal
//       or a template whose EVERY HOLE is a direct call to a named private renderer — one
//       syntactic level, so there is nothing to resolve. With those holes filled by this file's
//       own canonical examples, each constant is parsed and must be exactly one closed
//       `SELECT … FROM public.<writing routine>(closed args)`: no WHERE, no CTE, no set
//       operation, no second FROM entry, no table reference, no write, and no routine invoked
//       beside its own except pinned value built-ins, compared by FULL dotted name. Each
//       entrypoint is exactly four statements — the seal, the ownership check, the target
//       claim, one
//       `client.query` — so there is no branch a guard can sit outside of; the raw texts are NOT
//       exported, and the export surface is pinned.
//
//   G4  NO WRITING APPLY ROUTINE IS SPELLED ANYWHERE ELSE IN THE FAMILY. In every
//       `src/test/abc27*` file but the catalogue — the program AND the scope-drift set — a
//       DECODED string token, template part or identifier that names one of the two routines is
//       REFUSED unless its content identity is in a pinned inventory of decided, NON-INVOKING
//       mentions: catalog probes, GRANT texts, installed signatures, splicing anchors,
//       runbook-parity fragments, expectation-map keys. Comments are excluded, because a
//       JavaScript comment does not EXECUTE (source reflection through `Function.prototype
//       .toString()` or reading the file is a stated residual). The pin set is checked in BOTH
//       directions, so
//       a stale pin is as red as a new mention.
//
//       WHY THIS REPLACED A CENSUS. Its predecessor read the suite's syntax tree and asked
//       whether an `enteringApplyWrite(…)` DOMINATED each `.query` that reached a writing
//       routine. That is a general dataflow question over a 30,000-line file, and four review
//       rounds each found the next enumeration hole — a hole in an expression position that IS a
//       call, a `for…of` destructuring default, a computed subscript into a stored call map, a
//       constructor parameter property. There is no oracle for JavaScript dataflow, so the
//       question was removed rather than answered again: a token either spells the name or it
//       does not, and that is decidable.
//
// ── EVERY LITERAL IS READ AS SQL, AND THAT CUTS BOTH WAYS ─────────────────────────────────────
//
// This does not try to decide which string literals are sent to a server; it reads them all. That
// is what lets it see a statement inside a dollar-quoted body, inside an `EXECUTE`, or assembled
// from pieces — and it means an ordinary message like `'UPDATE public.availability_slots failed'`
// would be refused as a write. A round-2 review named that as a false positive and it is one.
//
// It is the deliberate direction to fail in. A refusal is loud, names the site, and is fixed by
// rewording a string; the opposite mistake is a write nobody sees. No literal in the scanned
// files trips it today, and the guard is run on every change, so the cost of the posture is paid
// immediately and by whoever wrote the string.
//
// ── THE HONEST CLAIM ──────────────────────────────────────────────────────────────────────────
//
// This gate proves that no INSERT, UPDATE, MERGE or COPY against `availability_slots` is SPELLED
// outside the factory in any text this can read; that the factory's statements admit no
// interpolation and, read by PostgreSQL's own grammar, bind every trainer to a parameter; that
// every invocation of the two WRITING apply routines is spelled in the catalogue, where each is a
// closed statement bound in one linear body to the ownership check; that no other decoded token
// in the `abc27` family spells either routine outside a pinned inventory of decided, non-invoking
// mentions; that no guarded surface leaves `unnest` unqualified; and that everything it could not
// read is refused rather than certified.
//
// It does NOT prove a dataflow, and G4 makes no dataflow claim of any kind. It does not read SQL
// a program computes by means it cannot constant-fold, and a routine name ASSEMBLED at run time
// out of fragments that never spell it is the named residual — the same residual class the
// slot-write promise carries. A raw parse is not a plan either: it does not know what `$2` will
// contain or what the server does with it. And none of this is what stops one test from using
// another's trainer or another's slot — `requireOwnedByCurrentIdentity()` and
// `assertSlotsNotForeign()` do that, at execution time, in every run, on the values that
// actually arrive, which is why every catalogue entrypoint calls the second one before it sends.
//
// TWO MORE RESIDUALS, NAMED RATHER THAN CHASED. A `PL/pgSQL EXECUTE` whose argument is `||`-
// ASSEMBLED — `EXECUTE 'UPDATE ' || quote_ident('x') || …` — is unconditionally reported as
// DYNAMIC by G2 wherever it sits inside a function body this audits, so no fixed text in the body
// speaks for a statement built that way; the residual is narrower and outside a function body,
// where the raw lexer's own `EXECUTE '<literal>'` handling reads the STRING TOKEN immediately
// following the keyword and does not reconstruct a concatenation across `||`. And a POSTGRESQL
// NUMERIC STRING ESCAPE — `\ooo` (octal), `\xhh` (hex), `\u`/`\U` (unicode) inside an `E'…'`
// literal — is not decoded correctly by this reader's escape handling, which was MEASURED rather
// than assumed: making it fail-closed on a numeric escape refused the real repository outright,
// because the suite carries legitimate `E'\x…'::bytea` round trips inside literals that also
// happen to mention the guarded table elsewhere, and G1 cannot refuse only the portion of a
// literal that is a write. Both are narrower and more contrived ways past G1 than any ordinary
// spelling needs to be, and both are stated here rather than left to be discovered.
//
// EVERY READER HERE OBEYS ONE INVARIANT, and it is the reason this file was rewritten rather than
// patched a sixth time: a classification returns decided-yes, decided-no, or UNREADABLE, and
// unreadable always surfaces — as a refusal here, or as a pinned mention identity. Nothing
// maps "cannot read" onto the certifying side. Read together: the static half makes the runtime
// half unavoidable, R5 keeps the static half from ever being consulted at run time, and the
// runtime half is what holds.
//
// ── SCOPE, STATED RATHER THAN IMPLIED ─────────────────────────────────────────────────────────
//
// This reads FIVE files: the trainer authority, the slot-write factory, the apply invocation
// catalogue, the ABC-27 realpg suite, and the guard's own unit suite. It says nothing about
// `d7RuntimeContract.realpg.test.ts` (73 write sites) or `d7Performance.realpg.test.ts`, which run
// in their own clusters with their own trainer handling. Adopting the factory there is an explicit
// follow-up, named here rather than left to be discovered. `checkScopeDrift` refuses any OTHER
// `src/test/abc27*` file that names the table beside a write verb or that sends SQL at all, and
// G4 is asked of those files directly — so neither scope can widen behind this list's back.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  isIncompleteWalk, loadOracle, namesRelation, nodesOf, oracleIdentity, parseSql,
  parseStatementOrExpression, plpgsqlExpressions, tagOf, unwrapValue,
  WalkTooDeep, writeNodes,
} from './abc27ParseOracle.mjs';

// THE ORACLE IS LOADED BEFORE ANY EXPORT OF THIS MODULE CAN BE CALLED. `parseSync` throws until
// the WASM is initialised, and a top-level await is the only way to make that true for a CLI, a
// vitest import and a fixture run alike — an `analyze()` that returned "unreadable" because the
// parser had not booted would be a gate reporting on itself.
await loadOracle();

const SELF = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

/** The authority module — the ONE place the brand may be minted, and the ownership registry. */
export const AUTHORITY_REL = 'src/test/abc27TrainerAuthority.ts';
/** The slot-write factory — the ONE place a write to the guarded relation may be spelled. */
export const FACTORY_REL = 'src/test/abc27SlotFixtures.ts';
/** The suite whose absence of direct writes is proved. */
export const SUITE_REL = 'src/test/abc27RecipientSnapshot.realpg.test.ts';
/** The guard's own unit suite. In the program so the scope tripwire has nothing to refuse about
 *  it, and so a SQL literal that ever appears there is read like any other. */
export const SELFTEST_REL = 'src/test/abc27TrainerSourceAuthority.test.ts';
/**
 * The apply-invocation catalogue — the ONE place either WRITING apply routine may be spelled.
 *
 * It is the apply-side analogue of the factory and it is analysed with its own rule set (G3),
 * selected the way `factory: true` selects G2. The census module this replaces was in the program
 * because it was a READER the guard had to be able to read; this is in the program because it is
 * the SUBJECT of a rule.
 */
export const CATALOGUE_REL = 'src/test/abc27ApplyCatalogue.ts';

/**
 * The exact number of statements INSIDE THE FACTORY that write the guarded relation.
 *
 * Four INSERTs, fourteen UPDATEs, and the one UPDATE inside the planted trigger's PL/pgSQL body —
 * which is reached because dollar-quoted bodies are lexed recursively, exactly as the reader that
 * first reduced one to an opaque string token had to be corrected to do.
 *
 * A SITE IS ONE `file:line@literalStart:verb:offset`, deduplicated — the literal's own start
 * position and the verb token's position within it, so two statements inside one literal are two
 * sites and two identical literals on one physical line are two more. This is a tripwire, not the
 * proof: G2 says the statements are plain, and G1 says there are no others anywhere.
 */
export const EXPECTED_FACTORY_STATEMENTS = 19;

/**
 * The exact number of writing-apply STATEMENTS inside the catalogue, restated here for the same
 * reason: adding an eighth is a deliberate edit rather than a silent one. Each is one
 * module-private constant — a plain literal, or an arrow returning a template whose every hole is
 * a call to a named private renderer — and G3 audits every one of them through the oracle.
 */
export const EXPECTED_CATALOGUE_STATEMENTS = 7;
/** The exact number of deliberate shared-namespace exemptions. One: the census control. */
export const EXPECTED_EXEMPTIONS = 1;
/** The marker that names that one site, read from a SQL comment BEFORE comments are stripped. */
export const EXEMPTION_MARKER = 'SHARED_NAMESPACE_CONTROL';
/**
 * THE ONE EXEMPTION, PINNED BY WHERE IT IS AND BY WHAT IT EXEMPTS — not only by count.
 *
 * A count of one is satisfied by ANY one exempt write, anywhere a marker is written: moving the
 * marker to a different statement, or deleting the census control and marking some other write
 * instead, changes nothing this file previously checked. `file` says which module may carry it —
 * the realpg suite's own residue census, not the factory, not the authority, not the catalogue —
 * and `digest` is the sha256 of the exempted statement's OWN rendered text, which moves only when
 * THAT statement changes and holds across every unrelated edit elsewhere in a 30,000-line file,
 * unlike a line number.
 */
export const EXPECTED_EXEMPTION_DIGEST =
  'becb441ed48c7cefacec85ae709a4a90f11dad33501d3ef095e9aa8b911ab7a4';

/** The relation this is all about, normalised: lower case, unquoted, unqualified. */
const TABLE = 'availability_slots';
/** The trainer column. */
const TRAINER_COL = 'trainer_id';

/**
 * THE ONE HOLE ATOM. A template interpolation is replaced by ONE control character before the SQL
 * is lexed, so a hole is always exactly one token and can never silently become a comma, a keyword
 * or a paren. It is not valid SQL, which is the point: nothing else can be mistaken for it.
 *
 * THERE USED TO BE FOUR. `T` marked a hole the checker had proved was an authority-issued trainer,
 * `F` one that had been through the SQL-fragment validator, `Q` a canonical UUID — the machinery
 * that let interpolations be admitted at all. Interpolation into slot SQL no longer exists, so
 * neither do they: every hole is simply unresolved, and a hole anywhere near a slot write is a
 * refusal rather than a classification problem.
 */
const U = '';

/** Bound on how many texts one literal may expand into before the literal is simply refused. */
const MAX_EXPANSIONS = 64;

/**
 * THE OVER-BOUND ANSWER, KEPT APART FROM THE UNRESOLVED ONE.
 *
 * They used to be the same `null`, and the arm that handled it asked its question of RAW
 * TypeScript source: a literal expanding past the bound while spelling the relation through
 * JavaScript escapes (`availability_slots`) was refused by neither the reader, which never
 * ran, nor the arm, which could not decode. Distinguishing them is what lets the over-bound case
 * be refused UNCONDITIONALLY — measured first: the four guarded files contain no over-bound
 * literal at all today, so the posture costs nothing and forecloses the whole shape.
 */
const OVER_BOUND = Symbol('over-bound');
// ── THE SQL LEXER ─────────────────────────────────────────────────────────────────────────────
//
// Not a tokenizer of convenience: deciding what is a comment, what is a string, what is a
// dollar-quoted body and what is an identifier IS lexing, and every defect the regex guard had
// was a consequence of guessing at it. `--` inside `'…'` is not a comment; `INSERT` inside `'…'`
// is not a verb; `/* /* */ */` nests in PostgreSQL; `U&"availability\005Fslots"` names the table;
// `E'\''` escapes with a backslash and `'…''…'` escapes by doubling.

export class SqlLexError extends Error {}

/**
 * Skip forward over whitespace AND comments — which PostgreSQL treats alike between tokens.
 *
 * Used where a construct continues across a separator (`U&'…' UESCAPE '!'`). An unterminated
 * block comment simply consumes the rest, because this is a scan for a following token rather
 * than the lexer's own decision about what the text is.
 */
function skipBlanks(sql, from) {
  let i = from;
  for (;;) {
    if (i < sql.length && /\s/.test(sql[i])) { i += 1; continue; }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      i = j;
      continue;
    }
    return i;
  }
}

/** Word characters, plus the two hole atoms so each stays exactly one token. */
const WORD_RE = new RegExp(`[A-Za-z0-9_$${U}]`);

/**
 * Lex `sql` into tokens. Comments are dropped but REPORTED, because the exemption marker lives in
 * one. Strings and quoted identifiers keep their decoded content and are TYPED, so a verb or a
 * table name inside a string can never be mistaken for the statement's own.
 *
 * Throws `SqlLexError` when a construct does not terminate — an unterminated string or block
 * comment means the text is not the statement it appears to be, and guessing past it is exactly
 * the class of mistake this exists to remove.
 */
export function lexSql(sql, { tolerant = false } = {}) {
  const tokens = [];
  const comments = [];
  let i = 0;
  const n = sql.length;
  // POSITIONS ARE PART OF THE TOKEN. The exemption marker lives in a comment, and a marker must
  // exempt the statement it is written in — not every statement in the same literal. Without a
  // position there is nothing to decide that with, which is the same "the window reached into the
  // next site" defect the retired scan had to be repaired for.
  let start = 0;
  const push = (kind, value) => tokens.push({ kind, value, pos: start });
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    start = i;
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      comments.push({ text: sql.slice(i + 2, end === -1 ? n : end), pos: i });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      if (depth > 0 && !tolerant) throw new SqlLexError('unterminated block comment');
      comments.push({ text: sql.slice(i + 2, j - 2), pos: i });
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          if (!tolerant) throw new SqlLexError(`unterminated dollar-quoted string ${tag}`);
          push('dollar', sql.slice(i + tag.length));
          i = n;
          continue;
        }
        // TYPED SEPARATELY, because a dollar-quoted body IS SQL. `CREATE FUNCTION … AS $x$ …
        // UPDATE public.availability_slots … $x$` executes a write this reader would otherwise
        // reduce to one opaque string token — and the suite really does contain one.
        push('dollar', sql.slice(i + tag.length, end));
        i = end + tag.length;
        continue;
      }
      // otherwise `$1` and friends fall through to the word scanner below
    }
    if ((ch === 'U' || ch === 'u') && sql[i + 1] === '&' && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      const quote = sql[i + 2];
      const { text, next } = readQuoted(sql, i + 2, quote, tolerant);
      // ── UESCAPE IS DECODED, NOT REFUSED ─────────────────────────────────────────────────────
      //
      // This used to throw on any escape character but the default, and a review round showed
      // what throwing cost. The catch around this lexer asked its fallback question of the
      // UNDECODED text, so `U&"availability!005Fslots" UESCAPE '!'` — a perfectly ordinary
      // PostgreSQL spelling of the guarded relation — threw, carried no contiguous table name
      // for the fallback to find, and was reported as nothing at all. A construct a gate refuses
      // to READ is a construct it cannot fail closed on, so this one is read.
      // ...AND A COMMENT IS WHITESPACE. PostgreSQL separates grammar tokens with comments as
      // freely as with spaces, so `U&"…" /* c */ UESCAPE '!'` is one construct. Skipping only
      // `\s` decoded with the DEFAULT escape and then lexed `UESCAPE` as a separate word — a
      // valid spelling of the relation that read as a different identifier entirely.
      let j = skipBlanks(sql, next);
      let escape = '\\';
      let after = next;
      if (/^uescape\b/i.test(sql.slice(j, j + 8))) {
        const k = skipBlanks(sql, j + 7);
        if (sql[k] !== "'") {
          if (!tolerant) throw new SqlLexError('UESCAPE without a quoted escape character');
        } else {
          const esc = readQuoted(sql, k, "'", tolerant);
          // PostgreSQL's own rule: exactly one character, and not one that could be confused
          // with the escape sequence it introduces.
          if (esc.text.length !== 1 || /[0-9A-Fa-f+'"\s]/.test(esc.text)) {
            if (!tolerant) {
              throw new SqlLexError(`UESCAPE '${esc.text}' is not a legal escape character`);
            }
          } else {
            escape = esc.text;
          }
          after = esc.next;
        }
      }
      push(quote === "'" ? 'string' : 'ident', decodeUnicodeEscapes(text, escape));
      i = after;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      const { text, next } = readEscapeString(sql, i + 1, tolerant);
      push('string', text);
      i = next;
      continue;
    }
    if (ch === "'") {
      const r = readQuoted(sql, i, "'", tolerant); push('string', r.text); i = r.next; continue;
    }
    if (ch === '"') {
      const r = readQuoted(sql, i, '"', tolerant); push('ident', r.text); i = r.next; continue;
    }
    if (WORD_RE.test(ch)) {
      let j = i;
      while (j < n && WORD_RE.test(sql[j])) j += 1;
      // Unquoted identifiers and keywords fold to lower case, which is what PostgreSQL does.
      push('word', sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    push('punct', ch);
    i += 1;
  }
  return { tokens, comments };
}

/** `'…''…'` / `"…""…"`: the quote is escaped by doubling. */
function readQuoted(sql, start, quote, tolerant = false) {
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) {
      if (tolerant) return { text: out, next: sql.length };
      throw new SqlLexError(`unterminated ${quote === "'" ? 'string' : 'quoted identifier'}`);
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { out += quote; i += 2; continue; }
      return { text: out, next: i + 1 };
    }
    out += sql[i];
    i += 1;
  }
}

/**
 * `E'…'`: backslash escapes, plus the doubling rule.
 *
 * ── A NAMED RESIDUAL, NOT A SILENT ONE ────────────────────────────────────────────────────────
 *
 * This decodes a NAMED escape (`\n`, `\t`, `\\`, `\'`, or any other single character after the
 * backslash) as one placeholder character each — correct enough for what this reader is FOR,
 * which is deciding whether a text spells a keyword or the guarded table name, and no legitimate
 * spelling of either needs an embedded control character to do it.
 *
 * IT DOES NOT DECODE POSTGRESQL'S NUMERIC ESCAPES CORRECTLY — `\ooo` (one to three octal digits
 * collapsing to one byte), `\xhh` (one or two hex digits) or `\u`/`\U` (four or eight) — and it
 * was measured, not assumed: `\ooo`/`\xhh`/`\u`/`\U` were tried as a FAIL-CLOSED refusal (throw
 * on sight of a numeric escape) and it refused the real repository outright, because the suite
 * carries legitimate `E'\x…'::bytea` round trips inside literals that ALSO happen to mention
 * `availability_slots` elsewhere in the same large text — G1 has no way to refuse only the
 * PORTION of a literal that is a write, so refusing the escape refused content that names no
 * write at all. That direction trades a false negative this narrow residual already carries for a
 * false positive against reviewed, unrelated code, which is a worse trade for a bounded tripwire
 * to make.
 *
 * SO THE HONEST ANSWER IS TO NAME IT RATHER THAN CHASE IT: a write assembled so its `trainer_id`
 * or its verb is spelled through a numeric or unicode string escape is not decoded by this reader
 * and is not what "no slot write outside the factory" claims to cover — the same residual class
 * as a routine name assembled from fragments that never spell it, or SQL a program computes by
 * means this cannot constant-fold. It is a narrower and more contrived way to get past G1 than
 * ordinary text ever needs to be, and it is stated in this module's own header rather than left
 * to be discovered.
 */
function readEscapeString(sql, start, tolerant = false) {
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) {
      if (tolerant) return { text: out, next: sql.length };
      throw new SqlLexError('unterminated escape string');
    }
    if (sql[i] === '\\') { out += sql[i + 1] ?? ''; i += 2; continue; }
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }
      return { text: out, next: i + 1 };
    }
    out += sql[i];
    i += 1;
  }
}

/**
 * `U&"…"` escapes: `<e>XXXX` and `<e>+XXXXXX`, plus `<e><e>` for a literal escape character.
 *
 * THE ESCAPE CHARACTER IS A PARAMETER, because `UESCAPE` makes it one. This used to hard-code the
 * backslash while the lexer threw on every other spelling; the UESCAPE branch below records what
 * throwing cost.
 */
export function decodeUnicodeEscapes(text, escape = '\\') {
  // ── LEFT TO RIGHT, ONCE, THE WAY POSTGRESQL READS IT ────────────────────────────────────────
  //
  // This used to be three GLOBAL replacements in sequence, and a review round showed that is not
  // the same function. `U&"a!!005Fb" UESCAPE '!'` is, to PostgreSQL, a DOUBLED escape (a literal
  // `!`) followed by the ordinary characters `005Fb` — the identifier `a!005Fb`. Run as separate
  // passes, the four-digit rule fired first on `!005F` and produced `a!_b`: a different
  // identifier, decoded out of text that never contained one. The doubled-escape rule ran last
  // and had nothing left to do.
  //
  // A single scan settles it, because the cases are only ambiguous when they are allowed to
  // overlap: at each escape, a following escape is a literal one and is consumed with it;
  // otherwise `+` plus six hex digits or four hex digits decode; anything else is kept as it
  // stands, which is what an unreadable escape must be.
  const src = String(text);
  const HEX = /^[0-9A-Fa-f]$/;
  const isHex = (from, count) => {
    if (from + count > src.length) return false;
    for (let k = from; k < from + count; k += 1) if (!HEX.test(src[k])) return false;
    return true;
  };
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(escape, i)) {
      const after = i + escape.length;
      if (src.startsWith(escape, after)) { out += escape; i = after + escape.length; continue; }
      if (src[after] === '+' && isHex(after + 1, 6)) {
        out += String.fromCodePoint(parseInt(src.slice(after + 1, after + 7), 16));
        i = after + 7;
        continue;
      }
      if (isHex(after, 4)) {
        out += String.fromCodePoint(parseInt(src.slice(after, after + 4), 16));
        i = after + 4;
        continue;
      }
      out += src.slice(i, after);
      i = after;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

// ── STATEMENT SPLITTING AND CLASSIFICATION ────────────────────────────────────────────────────

/**
 * Split a token stream on top-level `;`, keeping each statement's CHARACTER RANGE so a comment can
 * be attributed to the statement it was written in rather than to the whole literal.
 */
function splitStatements(tokens, textLength) {
  const out = [];
  let cur = [];
  let from = 0;
  for (const tok of tokens) {
    if (tok.kind === 'punct' && tok.value === ';') {
      out.push({ toks: cur, from, to: tok.pos });
      cur = [];
      from = tok.pos + 1;
      continue;
    }
    cur.push(tok);
  }
  out.push({ toks: cur, from, to: textLength });
  return out.filter((s) => s.toks.length > 0);
}

const isWord = (tok, w) => !!tok && tok.kind === 'word' && tok.value === w;
const isPunct = (tok, p) => !!tok && tok.kind === 'punct' && tok.value === p;

/** Does this token name the guarded relation? `ident` covers `"availability_slots"` and `U&"…"`. */
const namesTable = (tok) =>
  !!tok && (tok.kind === 'word' || tok.kind === 'ident')
  && String(tok.value).toLowerCase() === TABLE;

/** A dollar-quoted body behaves as a string everywhere the classifier looks at token KINDS. */
const isStringy = (tok) => !!tok && (tok.kind === 'string' || tok.kind === 'dollar');

/** Read `[ONLY] [schema .] name` at `i`. `table` is null when the reference is not resolvable. */
function readTableRef(toks, i) {
  if (isWord(toks[i], 'only')) i += 1;
  const parts = [];
  for (;;) {
    const tok = toks[i];
    if (!tok || (tok.kind !== 'word' && tok.kind !== 'ident')) return { table: null, next: i };
    parts.push(tok);
    i += 1;
    if (isPunct(toks[i], '.')) { i += 1; continue; }
    break;
  }
  return { table: parts[parts.length - 1], next: i };
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(toks, open) {
  let depth = 0;
  for (let i = open; i < toks.length; i += 1) {
    if (isPunct(toks[i], '(')) depth += 1;
    else if (isPunct(toks[i], ')')) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}
/** Render tokens for a legible refusal, with the hole atom spelled out. */
const render = (toks) => toks.map((t) => {
  const v = String(t.value).split(U).join('<interpolation>');
  return isStringy(t) ? `'${v}'` : t.kind === 'ident' ? `"${v}"` : v;
}).join(' ').slice(0, 160);

/** Does a token sequence carry a hole, in any token kind? */
const hasAtom = (toks) => toks.some((t) => String(t.value).includes(U));

// ── THE TYPESCRIPT SIDE ───────────────────────────────────────────────────────────────────────

/**
 * The brand's property key, READ from the authority module rather than assumed.
 *
 * TWO READS, AND THE SECOND ONE IS WHY THIS IS NOT ONE LINE. The declared type is
 * `string & { readonly [brand]: true }`, and its property list therefore carries EVERY member of
 * `String` as well as the brand — including `__@iterator@N`, because `Symbol.iterator` is also a
 * unique-symbol key. Taking the first `__@…` property found the ITERATOR, and a brand test keyed
 * on `Symbol.iterator` says "branded" for every string in the program: the guard passed
 * everything it should have refused. So the unique symbol's NAME is read from its `declare const`
 * first, and the property is then matched against that name — and if the two do not line up
 * exactly once, this returns null and the whole run refuses rather than guessing.
 */
function brandPropertyName(checker, authoritySource, aliasName = 'IsolatedTrainerId',
  symbolName = 'isolatedTrainerBrand') {
  if (!authoritySource) return null;
  // (1) the `declare const <name>: unique symbol` this module owns
  const symbolNames = [];
  const findSymbol = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type
      && ts.isTypeOperatorNode(node.type) && node.type.operator === ts.SyntaxKind.UniqueKeyword
      && node.type.type.kind === ts.SyntaxKind.SymbolKeyword
      && node.name.text === symbolName) {
      symbolNames.push(node.name.text);
    }
    ts.forEachChild(node, findSymbol);
  };
  ts.forEachChild(authoritySource, findSymbol);
  if (symbolNames.length !== 1) return null;
  const prefix = `__@${symbolNames[0]}@`;

  // (2) the property of the declared brand type whose key is that symbol
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === aliasName) {
      const sym = checker.getSymbolAtLocation(node.name);
      if (sym) {
        const matches = checker.getDeclaredTypeOfSymbol(sym).getProperties()
          .map((p) => String(p.escapedName)).filter((name) => name.startsWith(prefix));
        if (matches.length === 1) { [found] = matches; return; }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(authoritySource, visit);
  return found;
}

/** Non-nullish constituents of a (possibly union) type. */
function constituents(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.filter((t) => !(t.flags
    & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
}

/**
 * Is `type` the brand? EVERY non-nullish constituent must carry the brand property, so an
 * `IsolatedTrainerId | string` union — which is what a careless `??` produces — is NOT branded.
 * `any` has no properties at all, so `any` fails here: deny by default, which is the point.
 */
function isBrandedType(type, brandProp) {
  if (!type || !brandProp) return false;
  const parts = constituents(type);
  if (parts.length === 0) return false;
  return parts.every((t) => t.getProperties().some((p) => String(p.escapedName) === brandProp));
}

/** Is `type` an array (or readonly array) of the brand? */
function isBrandedArrayType(checker, type, brandProp) {
  if (!type) return false;
  const parts = constituents(type);
  if (parts.length === 0) return false;
  return parts.every((t) => {
    const elem = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
    return !!elem && isBrandedType(elem, brandProp);
  });
}

/** How deep the containing-type walk goes before it gives up and answers "not branded". */
const CONTAINER_DEPTH = 4;

/**
 * DOES THIS ONE TYPE — not a union — CONTAIN THE BRAND ANYWHERE A VALUE COULD BE PUT?
 *
 * A REVIEW ROUND FOUND THIS EXACTLY. The rule below asks whether an expression's CONTEXTUAL type
 * is a brand, and the old answer was "the brand, or an array of it" — so annotating a CONTAINER
 * walked straight past it:
 *
 *     const box: { t: IsolatedTrainerId } = somethingAny;   // contextual type is an object
 *     insertSlot(c, { trainer: box.t, … });                 // and `box.t` reads as branded
 *
 * Under `strict: false` that needs no cast at all. So the question is asked of the whole type: a
 * brand reachable through an object property, an array element or a tuple member, to a bounded
 * depth. Bounded because a type graph can be cyclic and because a guard that can hang is a guard
 * that gets disabled; four levels covers every shape the suite writes and the round's own fixture.
 *
 * MEMBERS ARE ASKED WITH `requiresBrand`, NOT WITH THIS. `{ t: IsolatedTrainerId | string }`
 * accepts an unbranded value in `t`, so the container does not require one either.
 */
function typeContainsBrand(checker, type, brandProp, depth, seen) {
  if (!type || !brandProp || depth > CONTAINER_DEPTH) return false;
  if (isBrandedType(type, brandProp)) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  const elem = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (elem && requiresBrand(checker, elem, brandProp, depth + 1, seen)) return true;
  // A TUPLE HAS NO NUMBER INDEX SIGNATURE in the shape above, so its members are read here —
  // `[IsolatedTrainerId, string]` is a container like any other.
  for (const prop of type.getProperties()) {
    const decl = prop.valueDeclaration || (prop.declarations || [])[0];
    if (!decl) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    if (requiresBrand(checker, propType, brandProp, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * DOES THIS POSITION REQUIRE A BRAND — is there no way to satisfy it without one?
 *
 * EVERY constituent must carry a brand, and this is the difference between a rule that works and
 * one that refuses the whole repository. `pg`'s `query<R, I extends any[]>(text, values: I)`
 * infers `I` FROM ITS OWN ARGUMENTS, so passing `[trainers, academy, …]` makes the contextual
 * type of every element `string | number | IsolatedTrainerId[]`. Under a "some constituent is
 * branded" test each ordinary academy id then looked like a value widening into a brand — a
 * contextual type derived from the very expression under test proves nothing about it. The same
 * shape appears in `expect(branded).toBe(raw)`, where `E` is inferred from the receiver.
 *
 * Asking whether the position ACCEPTS an unbranded value answers both: a union that admits
 * `string` is not a brand position, and `{ t: IsolatedTrainerId }` still is.
 */
function requiresBrand(checker, type, brandProp, depth = 0, seen = new Set()) {
  if (!type || !brandProp || depth > CONTAINER_DEPTH) return false;
  const parts = constituents(type);
  if (parts.length === 0) return false;
  return parts.every((t) => typeContainsBrand(checker, t, brandProp, depth, seen));
}

/** Does this type MENTION the brand anywhere — the question an `as` TARGET is asked. */
function producesBrand(checker, type, brandProp, depth = 0, seen = new Set()) {
  if (!type || !brandProp) return false;
  return constituents(type).some((t) => typeContainsBrand(checker, t, brandProp, depth, seen));
}

// ── RESOLVING A TEMPLATE HOLE TO TEXT ─────────────────────────────────────────────────────────
//
// ONLY ENOUGH TO STOP A STATEMENT BEING ASSEMBLED OUT OF PIECES. A hole is resolved when it is a
// literal or a `const` bound to one, and otherwise it becomes the opaque atom. That is all this
// needs: `'INSERT INTO public.avail' + SUFFIX` must still read as a write to the guarded relation,
// and everything else is refused by position rather than resolved.

function resolveExpression(expr, ctx, depth = 0) {
  if (depth > 8) return null;
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr)) return resolveExpression(expr.expression, ctx, depth + 1);
  if (ts.isAsExpression(expr)) return resolveExpression(expr.expression, ctx, depth + 1);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isNumericLiteral(expr)) return [expr.text];
  if (ts.isTemplateExpression(expr)) return expandTemplate(expr, ctx, depth + 1);
  if (isConcatenation(expr)) {
    const left = resolveExpression(expr.left, ctx, depth + 1);
    const right = resolveExpression(expr.right, ctx, depth + 1);
    return cartesian(left, right);
  }
  // A NUMBER CANNOT CHANGE A STATEMENT'S SHAPE. It has no quote, no comma and no keyword in it,
  // so a numeric hole is text rather than an atom — which keeps ordinary interpolated lane
  // offsets from making a whole literal unreadable.
  const type = ctx.checker.getTypeAtLocation(expr);
  if (type && (type.flags & NUMERICISH) && !(type.flags & ts.TypeFlags.Any)) return ['0'];
  // ── CONSTANT FOLDING, NOT A DENY-LIST ─────────────────────────────────────────────────────
  //
  // A round-1 review assembled a slot INSERT as `['INSERT INTO public.avail', 'ability_slots…']
  // .join('')`: neither element names the relation, so neither was refused, and the joined text
  // was never formed. `+` was already folded here; `.join()` on a literal array of literals and
  // `.concat()` are the same question with different syntax, so they are folded too.
  //
  // WHAT THIS DELIBERATELY IS NOT is a list of forbidden methods. Anything this cannot fold stays
  // unresolved, which is stated in the honest claim rather than pretended away — the runtime
  // registry, not this reader, is what refuses a foreign trainer.
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const method = expr.expression.name.text;
    const receiver = expr.expression.expression;
    if (method === 'join') {
      const sepTexts = expr.arguments.length === 0
        ? [',']
        : resolveExpression(expr.arguments[0], ctx, depth + 1);
      const elements = arrayElementsOf(receiver, ctx, depth + 1);
      if (sepTexts === OVER_BOUND) return OVER_BOUND;
      if (sepTexts === null || sepTexts.length !== 1 || elements === null) return null;
      let acc = [''];
      for (let k = 0; k < elements.length; k += 1) {
        const piece = resolveExpression(elements[k], ctx, depth + 1);
        if (piece === OVER_BOUND) return OVER_BOUND;
        if (piece === null) return null;
        acc = cartesian(acc, k === 0 ? piece : piece.map((t) => sepTexts[0] + t));
        if (acc === OVER_BOUND) return OVER_BOUND;
        if (acc === null) return null;
      }
      return acc;
    }
    if (method === 'concat') {
      let acc = resolveExpression(receiver, ctx, depth + 1);
      for (const arg of expr.arguments) {
        acc = cartesian(acc, resolveExpression(arg, ctx, depth + 1));
        if (acc === OVER_BOUND) return OVER_BOUND;
        if (acc === null) return null;
      }
      return acc;
    }
    return null;
  }
  if (ts.isIdentifier(expr)) return resolveIdentifier(expr, ctx, depth);
  return null;
}

/**
 * An identifier's texts: a `const` bound to a literal, or a `for … of` binding over an array of
 * them — including the destructured `for (const [a, b] of pairs)` shape, where the identifier is
 * declared at a `BindingElement` rather than at the `VariableDeclaration`.
 *
 * THIS IS WHAT KEEPS R2 HONEST RATHER THAN NOISY. A probe fixture writes
 * `INSERT INTO public.${table}` over a two-element loop, and a reader that could not follow the
 * binding would refuse it as an unresolvable target — a true statement about the reader and a
 * false one about the code.
 */
function resolveIdentifier(ident, ctx, depth) {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decls = (sym && sym.declarations) || [];
  if (decls.length !== 1) return null;

  let decl = decls[0];
  let tupleIndex = null;
  if (ts.isBindingElement(decl)) {
    const pattern = decl.parent;
    if (!ts.isArrayBindingPattern(pattern)) return null;
    tupleIndex = pattern.elements.indexOf(decl);
    if (tupleIndex < 0) return null;
    // A rest element before ours makes the position unknowable.
    if (pattern.elements.slice(0, tupleIndex)
      .some((el) => ts.isBindingElement(el) && el.dotDotDotToken)) return null;
    if (decl.dotDotDotToken) return null;
    decl = pattern.parent;
  }
  if (!ts.isVariableDeclaration(decl)) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;

  if (tupleIndex === null && ts.isIdentifier(decl.name) && decl.initializer) {
    return resolveExpression(decl.initializer, ctx, depth + 1);
  }
  if (!ts.isForOfStatement(list.parent)) return null;
  const elements = arrayElementsOf(list.parent.expression, ctx, depth + 1);
  if (elements === null) return null;

  const out = [];
  for (const el of elements) {
    let target = el;
    if (tupleIndex !== null) {
      if (!ts.isArrayLiteralExpression(el)) return null;
      target = el.elements[tupleIndex];
      if (!target) return null;
    }
    const r = resolveExpression(target, ctx, depth + 1);
    if (r === OVER_BOUND) return OVER_BOUND;
    if (r === null) return null;
    out.push(...r);
    if (out.length > MAX_EXPANSIONS) return OVER_BOUND;
  }
  return out;
}

/**
 * The element expressions of an array, when it is an array LITERAL — written inline, or held by a
 * `const` this can follow to exactly one such literal. Anything else is null, which is a refusal
 * wherever the value could decide the shape of a statement.
 */
function arrayElementsOf(expr, ctx, depth) {
  if (depth > 8) return null;
  if (ts.isParenthesizedExpression(expr)) return arrayElementsOf(expr.expression, ctx, depth + 1);
  if (ts.isAsExpression(expr)) return arrayElementsOf(expr.expression, ctx, depth + 1);
  if (ts.isArrayLiteralExpression(expr)) {
    // A spread makes the element positions unknowable, so the whole array is unresolvable.
    if (expr.elements.some((el) => ts.isSpreadElement(el))) return null;
    return expr.elements;
  }
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decls = (sym && sym.declarations) || [];
    if (decls.length !== 1) return null;
    const decl = decls[0];
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return null;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
    return arrayElementsOf(decl.initializer, ctx, depth + 1);
  }
  return null;
}

const NUMERICISH = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;

const cartesian = (a, b) => {
  if (a === OVER_BOUND || b === OVER_BOUND) return OVER_BOUND;
  if (a === null || b === null) return null;
  const out = [];
  for (const x of a) {
    for (const y of b) {
      out.push(x + y);
      if (out.length > MAX_EXPANSIONS) return OVER_BOUND;
    }
  }
  return out;
};

/** Expand a template literal into every SQL text it can be, unresolved holes becoming atoms. */
function expandTemplate(node, ctx, depth = 0) {
  let acc = [node.head.text];
  for (const span of node.templateSpans) {
    const inner = resolveExpression(span.expression, ctx, depth + 1);
    if (inner === OVER_BOUND) return OVER_BOUND;
    acc = cartesian(acc, inner || [U]);
    if (acc === OVER_BOUND) return OVER_BOUND;
    if (acc === null) return null;
    acc = acc.map((s) => s + span.literal.text);
  }
  return acc;
}

/** A `+` expression — the composition form. */
const isConcatenation = (node) =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/**
 * The OUTERMOST `+` of a concatenation chain: the node that carries the whole assembled text.
 * Inner operands are still visited on their own, which costs nothing — a fragment that is not a
 * statement classifies as nothing, and a duplicate verdict on the same site collapses.
 */
const isOutermostConcatenation = (node) =>
  isConcatenation(node) && !(node.parent && isConcatenation(node.parent));

/** A `.join()` / `.concat()` assembly — the composition forms that are not `+`. */
const isFoldableAssembly = (node) =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  && (node.expression.name.text === 'join' || node.expression.name.text === 'concat');

/**
 * Every SQL text a literal node can be.
 *
 * THREE ANSWERS, NOT TWO: an array of texts; `OVER_BOUND`, which is refused unconditionally; or
 * `null`, which means "this composition could not be folded" and is a different thing entirely.
 * They were one value once, and the arm that handled them could decide neither.
 */
function expansionsOf(node, ctx) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return expandTemplate(node, ctx);
  if (isConcatenation(node) || isFoldableAssembly(node)) return resolveExpression(node, ctx);
  return null;
}

/** Is this literal PLAIN — one complete text, with no interpolation and no composition? */
const isPlainLiteral = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

// ── THE ANALYSIS ──────────────────────────────────────────────────────────────────────────────

/**
 * Every write to the guarded relation in these tokens, as `{ verb, at }`, plus every write whose
 * TABLE REFERENCE could not be resolved.
 *
 * `AFTER INSERT ON public.availability_slots` IS NOT ONE. A trigger definition names the verb and
 * the relation and writes nothing, so `INSERT` counts only when `INTO` follows it — which is what
 * lets the suite keep its planted-trigger fixtures without an exemption.
 */
function writesToTable(stmt) {
  const writes = [];
  const unresolved = [];
  for (let i = 0; i < stmt.length; i += 1) {
    const tok = stmt[i];
    if (tok.kind !== 'word') continue;
    // ── MERGE AND COPY GET THEIR TARGET READ, like the other two ────────────────────────────
    //
    // They used to ask only whether the guarded relation appeared ANYWHERE in the statement,
    // which a round-2 review showed is wrong in both directions: `MERGE INTO other USING
    // public.availability_slots` and `COPY public.availability_slots TO STDOUT` are READS that
    // were called writes, and a MERGE whose target is an interpolation was never examined at all.
    if (tok.value === 'merge' || tok.value === 'copy') {
      // `INTO` IS OPTIONAL AFTER `MERGE`. Reading it as required meant `MERGE public.x AS t
      // USING … WHEN MATCHED THEN UPDATE SET …` — a real write — was skipped entirely.
      const mAt = tok.value === 'merge'
        ? (isWord(stmt[i + 1], 'into') ? i + 2 : i + 1)
        : i + 1;
      const m = readTableRef(stmt, mAt);
      // `COPY t TO …` reads; `COPY t FROM …` writes. The direction word follows the relation and
      // an optional column list.
      if (tok.value === 'copy') {
        let j = m.next;
        if (isPunct(stmt[j], '(')) { const c = matchParen(stmt, j); if (c !== -1) j = c + 1; }
        if (!isWord(stmt[j], 'from')) continue;
      }
      if (m.table && namesTable(m.table)) { writes.push({ verb: tok.value, at: mAt }); continue; }
      if (m.table && hasAtom([m.table])) unresolved.push({ verb: tok.value, at: mAt });
      continue;
    }
    let at = -1;
    if (tok.value === 'insert' && isWord(stmt[i + 1], 'into')) at = i + 2;
    else if (tok.value === 'update' && !isLockingClause(stmt, i)) at = i + 1;
    if (at === -1) continue;
    const { table, next } = readTableRef(stmt, at);
    // ── THE TABLE NAME IS THE ANSWER, NOT THE POSITION ──────────────────────────────────────
    //
    // A round-1 review defeated an earlier version of this that asked whether `UPDATE` stood
    // where a statement could BEGIN: `WITH x AS (SELECT 1) UPDATE public.availability_slots …`
    // is a real write whose preceding token is `)`, so the verb was never read at all.
    //
    // Naming the guarded relation is decidable and is what actually matters, so it is asked
    // first and unconditionally. The positional test that used to gate this is GONE — a round-2
    // review showed it also hid the unresolved arm from the same CTE prefix. What keeps ordinary
    // prose out now is that `readTableRef` returns a keyword or nothing after `GRANT INSERT,
    // UPDATE …` or a policy's command list, and that `isLockingClause` catches `FOR UPDATE`.
    if (table && namesTable(table)) { writes.push({ verb: tok.value, at }); i = next - 1; continue; }
    // R2: A WRITE WHOSE TARGET IS A HOLE IS REFUSED. The relation may be the guarded one —
    // `INSERT INTO ${table} …` names nothing this reader can check, and assuming it is some other
    // table is exactly the assumption a gate must not make about itself.
    // A HOLE IN THE TARGET IS A REFUSAL WHEREVER THE VERB STANDS. The positional test used to
    // gate this arm too, so `WITH x AS (…) UPDATE public.${t} …` escaped it — a round-2 review's
    // finding. What keeps `GRANT INSERT, UPDATE …`, `FOR UPDATE` and a policy's command list out
    // is that none of them is followed by a HOLE: `readTableRef` returns a keyword or nothing.
    if (table && hasAtom([table])) unresolved.push({ verb: tok.value, at });
  }
  return { writes, unresolved };
}

/**
 * `FOR UPDATE`, `FOR NO KEY UPDATE` — a row-locking clause, never a verb.
 *
 * A round-4 review interpolated into one (`… FOR UPDATE ${lockMode}`), which put a HOLE where the
 * table reference would be and made the unresolved arm report a statement that updates nothing.
 * Walking back over the clause's own words is precise and does not reintroduce the positional
 * test that a round-2 review removed.
 */
function isLockingClause(stmt, i) {
  let j = i - 1;
  while (j >= 0 && (isWord(stmt[j], 'key') || isWord(stmt[j], 'no'))) j -= 1;
  return isWord(stmt[j], 'for');
}

/** How many statements in these tokens write the guarded relation. */
const countWritesToTable = (stmt) => writesToTable(stmt).writes.length;

// ══ G2, ANSWERED BY THE CANONICAL PARSER ═════════════════════════════════════════════════════
//
// THE CLAIM, NARROWED TO WHAT IS DECIDABLE. For every text spelled in the factory that writes the
// guarded relation, PostgreSQL's own grammar says: it is exactly one statement; the only relation
// it writes is the guarded one; wherever it assigns `trainer_id` — in a VALUES row, in a SELECT
// projection, in a `SET`, in a multi-column `SET`, in an `ON CONFLICT DO UPDATE`, in a
// data-modifying CTE, inside a PL/pgSQL body — the value is a bound parameter or a column of an
// `unnest($k)` alias belonging to that write; and the source is a single arm.
//
// WHAT THAT REPLACES, and why the replacement is not another enumeration. The predecessor walked
// tokens: it had to know that `INTO` is optional after `MERGE`, that `INSERT INTO t AS s (cols)`
// is legal, that a `SET` list ends at a `WHERE`/`FROM`/`RETURNING` at paren depth zero but not
// inside a subquery, that an `ON CONFLICT` belongs to the write at its own paren depth, that
// `SET (a,b) = (x,y)` is a real assignment form, that a parenthesised `UNION` puts both arms one
// level deeper. Every one of those is a rule the grammar already contains, and four review rounds
// found a spelling each hand-written version had missed. There are no clause boundaries to get
// wrong here: a write is a NODE, and its clauses are its own fields.
//
// ── THE RESIDUALS, STATED ─────────────────────────────────────────────────────────────────────
//
// A raw parse is not a plan. It does not know what `$2` will contain, and it does not follow a
// value through the server. That is the runtime registry's job and always was.

/** A legible name for the expression a trainer was bound to, for the refusal message. */
function describeValue(node) {
  const tag = tagOf(node);
  if (!tag) return 'nothing this could read';
  if (tag === 'A_Const') return 'a literal written into the statement';
  if (tag === 'FuncCall') {
    const parts = (node.FuncCall.funcname || []).map((f) => f.String && f.String.sval).filter(Boolean);
    return `a call to \`${parts.join('.') || '?'}()\``;
  }
  if (tag === 'ColumnRef') {
    const parts = (node.ColumnRef.fields || [])
      .map((f) => (f.String ? f.String.sval : '*')).filter(Boolean);
    return `the column \`${parts.join('.')}\``;
  }
  if (tag === 'SubLink') return 'a subquery';
  if (tag === 'SetToDefault') return 'DEFAULT';
  return `a \`${tag}\``;
}

/**
 * Every `unnest(<expr>) [WITH ORDINALITY] AS alias(col…)` in ONE select's own FROM clause.
 *
 * BOUNDED BY THE WRITE'S OWN SELECT, structurally. A round-6 review defeated the token version
 * from this exact side: an unrelated data-modifying CTE declared `unnest($1) AS t(id)` and an
 * outer `SELECT t.id FROM public.trainer_profiles AS t` was certified as parameter-bound while
 * `t.id` really came from the table. Here the alias can only come from the FROM clause of the
 * very select whose projection is being read, because that is the node it hangs off.
 */
function unnestAliases(select) {
  const out = [];
  for (const entry of (select && select.fromClause) || []) {
    const rf = entry && entry.RangeFunction;
    if (!rf) continue;
    const first = rf.functions && rf.functions[0] && rf.functions[0].List
      && rf.functions[0].List.items && rf.functions[0].List.items[0];
    const call = first && first.FuncCall;
    if (!call) continue;
    // ── THE BUILT-IN `unnest` IS `pg_catalog.unnest`, AND NOTHING ELSE IS ───────────────────
    //
    // Round 1 closed the SCHEMA-QUALIFIED lookalike: reading only the LAST element of the name
    // certified `FROM evil.unnest($1) WITH ORDINALITY AS t(id, i)`, an arbitrary set-returning
    // function of the caller's choosing whose first column was then accepted as a parameter-bound
    // trainer. The round-5 stop found the same hole through the spelling the factory used to
    // write: an UNQUALIFIED name resolves through `search_path`, which no reader here can see, so
    // a schema ahead of `pg_catalog` defining a competing `unnest(uuid[])` supplies the rows
    // instead — and the trainer the audit calls parameter-bound is whatever that function
    // returned. The owner closed it by EDIT: all three guarded statements now write
    // `pg_catalog.unnest`, and this accepts only that. The unqualified spelling is refused like
    // any other function (see `auditUnnestQualification`), so a revert is red on the real tree.
    const parts = (call.funcname || []).map((f) => f.String && f.String.sval);
    const isBuiltinUnnest = parts.length === 2
      && parts[0] === 'pg_catalog' && parts[1] === 'unnest';
    if (!isBuiltinUnnest) continue;
    const arg = unwrapValue((call.args || [])[0]);
    const param = tagOf(arg) === 'ParamRef' ? arg.ParamRef.number : null;
    const alias = rf.alias && rf.alias.aliasname ? rf.alias.aliasname : null;
    if (!alias) continue;
    const colnames = ((rf.alias && rf.alias.colnames) || [])
      .map((c) => c.String && c.String.sval);
    // ONLY THE FIRST ALIAS COLUMN IS THE UNNESTED VALUE. A second one is the ordinality, and
    // binding a trainer to it would silently write the row number.
    out.push({ alias, firstColumn: colnames.length > 0 ? colnames[0] : null, param });
  }
  return out;
}

/** A trainer expression is a bound parameter, an `unnest` alias column, or something refused. */
function classifyTrainerValue(value, select) {
  const v = unwrapValue(value);
  if (tagOf(v) === 'ParamRef') return { ok: true };
  if (tagOf(v) === 'ColumnRef') {
    const fields = (v.ColumnRef.fields || []).map((f) => f.String && f.String.sval);
    if (fields.length === 2 && fields[0] && fields[1]) {
      const binding = unnestAliases(select).find((b) => b.alias === fields[0]);
      if (binding && binding.param !== null && binding.firstColumn === fields[1]) {
        return { ok: true };
      }
    }
  }
  return { ok: false, what: describeValue(v) };
}

/** The `SET`-style assignments of an UPDATE or an `ON CONFLICT DO UPDATE`, audited. */
function auditAssignments(targetList, select, fail) {
  for (const item of targetList || []) {
    const res = item && item.ResTarget;
    if (!res || res.name !== TRAINER_COL) continue;
    let value = res.val;
    const tag = tagOf(value);
    if (tag === 'MultiAssignRef') {
      // `SET (trainer_id, location_id) = (…, …)` is a real assignment form and was SKIPPED by the
      // token reader, which looked for the single token `trainer_id` as the target. The parser
      // hands back the column's own position in the row, so the right element is read.
      const ref = value.MultiAssignRef;
      const source = ref && ref.source;
      const row = source && source.RowExpr;
      if (!row || !Array.isArray(row.args) || !ref.colno
        || ref.colno < 1 || ref.colno > row.args.length) {
        fail(`${TRAINER_COL} is assigned by a multi-column SET whose source this cannot decompose`);
        continue;
      }
      value = row.args[ref.colno - 1];
    }
    const verdict = classifyTrainerValue(value, select);
    if (!verdict.ok) {
      fail(`${TRAINER_COL} in a factory statement is bound to ${verdict.what} - inside the factory `
        + 'a trainer may only arrive as a bound parameter, so that the value the runtime registry '
        + 'checked is the value the server stores');
    }
  }
}

/** `ON CONFLICT … DO UPDATE SET …` is a SECOND write inside one statement, and is audited as one. */
function auditOnConflict(insert, fail) {
  const clause = insert.onConflictClause;
  if (!clause) return;
  if (clause.action === 'ONCONFLICT_NOTHING') return;
  if (clause.action !== 'ONCONFLICT_UPDATE') {
    fail('an ON CONFLICT action this cannot read - the action decides whether the trainer moves, '
      + 'so an unreadable one is refused rather than assumed to be DO NOTHING');
    return;
  }
  // The excluded-row pseudo-relation has no FROM clause of its own, so no alias can authorise a
  // trainer here: only a bound parameter can.
  auditAssignments(clause.targetList, null, fail);
}

/** One INSERT node, audited: its column list, its source, and its conflict clause. */
function auditInsert(insert, fail) {
  auditOnConflict(insert, fail);
  const cols = insert.cols || [];
  if (cols.length === 0) {
    // Without a column list there is no way to know which value lands in `trainer_id` — including
    // the column-less `INSERT INTO t VALUES (…)` form, where it lands by position.
    fail('an INSERT into the guarded relation with no column list this can read');
    return;
  }
  const names = cols.map((c) => (c.ResTarget && typeof c.ResTarget.name === 'string'
    ? c.ResTarget.name : null));
  if (names.some((n) => n === null)) {
    fail('an INSERT column list this cannot read as plain column names');
    return;
  }
  const idx = names.indexOf(TRAINER_COL);
  if (idx === -1) return;
  const select = insert.selectStmt && insert.selectStmt.SelectStmt;
  if (!select) {
    fail('an INSERT that names trainer_id in its column list but whose value source this cannot '
      + 'decompose');
    return;
  }
  // A COMPOUND SOURCE IS REFUSED, NOT HALF-READ: `SELECT … UNION ALL TABLE src` records a binding
  // for the readable arm while the other arm goes unread, and parenthesising the whole source was
  // what put both arms out of a depth-zero scan's reach. `op` is the grammar's own answer and is
  // the same for both spellings.
  if (select.op && select.op !== 'SETOP_NONE') {
    fail(`an INSERT whose value source is compound (${select.op}) - this reads ONE arm, so more `
      + 'than one is refused rather than half-read');
    return;
  }
  if (Array.isArray(select.valuesLists) && select.valuesLists.length > 0) {
    for (const row of select.valuesLists) {
      const items = (row && row.List && row.List.items) || [];
      // THE ARITY IS THE MAPPING. A row that is not as wide as the column list cannot be matched
      // positionally, and guessing which value lands in the trainer is the guess this refuses.
      if (items.length !== names.length) {
        fail(`an INSERT whose VALUES row has ${items.length} value(s) for ${names.length} column(s)`);
        continue;
      }
      const verdict = classifyTrainerValue(items[idx], select);
      if (!verdict.ok) {
        fail(`${TRAINER_COL} in a factory statement is bound to ${verdict.what} - inside the `
          + 'factory a trainer may only arrive as a bound parameter, so that the value the runtime '
          + 'registry checked is the value the server stores');
      }
    }
    return;
  }
  if (Array.isArray(select.targetList) && select.targetList.length > 0) {
    if (select.targetList.length !== names.length) {
      fail(`an INSERT whose source projects ${select.targetList.length} value(s) for `
        + `${names.length} column(s) - a source this cannot match positionally, such as \`TABLE src\` `
        + 'or `SELECT *`, is refused rather than guessed at');
      return;
    }
    const item = select.targetList[idx];
    const verdict = classifyTrainerValue(item && item.ResTarget && item.ResTarget.val, select);
    if (!verdict.ok) {
      fail(`${TRAINER_COL} in a factory statement is bound to ${verdict.what} - inside the factory `
        + 'a trainer may only arrive as a bound parameter, so that the value the runtime registry '
        + 'checked is the value the server stores');
    }
    return;
  }
  fail('an INSERT whose value source this cannot decompose (only VALUES and SELECT are read)');
}

/** Every write to the guarded relation in one parse tree, audited. Returns how many there were. */
function auditWritesIn(stmts, fail) {
  let seen = 0;
  for (const write of writeNodes(stmts)) {
    if (!namesRelation(write.node.relation, TABLE)) continue;
    seen += 1;
    if (write.verb === 'merge' || write.verb === 'copy') {
      fail(`${write.verb.toUpperCase()} against ${TABLE} is refused outright — no site uses it, and `
        + 'a form nothing exercises is a rule nobody has read');
      continue;
    }
    if (write.tag === 'UpdateStmt') {
      auditAssignments(write.node.targetList, write.node, fail);
      continue;
    }
    auditInsert(write.node, fail);
  }
  return seen;
}

/**
 * G2 for one complete literal text spelled inside the factory.
 *
 * TWO DETECTORS, ONE CERTIFIER. The lexer's count (`audit.lexerWrites`) and the oracle's own
 * write-set both DECIDE WHETHER TO AUDIT, and either one is enough; only the oracle decides what
 * the audit says. A detector that over-reports costs an audit that passes; a certifier that
 * over-reports is a hole, and there is exactly one certifier here.
 */
function auditFactoryText(text, audit, rel, line, result) {
  const fail = (detail) => result.violations.push({ file: rel, line, detail });
  // A TREE DEEPER THAN THE SHARED WALK is a tree this did not finish reading, and an unfinished
  // read is a refusal here rather than a quiet "no writes found".
  try {
    auditFactoryTextInner(text, audit, fail);
  } catch (e) {
    if (!isIncompleteWalk(e)) throw e;
    fail(`a factory literal whose parse tree is deeper than this reader walks (${e.message}) - `
      + 'an unfinished read is not an empty one');
  }
}

function auditFactoryTextInner(text, audit, fail) {
  const parsed = parseSql(text);
  if (!parsed.ok) {
    // ── AND NAMING THE RELATION IS ENOUGH, NOT ONLY THE LEXER SEEING A WRITE ─────────────────
    //
    // Asking only `audit.lexerWrites > 0` leaves one gap, and it is the batch's own failure mode
    // wearing a new hat: a text the LEXER reads happily as no-write while the canonical grammar
    // cannot read it at all — an unbalanced clause, say — is audited by neither, and "the lexer
    // saw no write" is a claim about the lexer, not about the statement. Inside the factory,
    // every literal that names the guarded relation must be one the oracle can read; one it
    // cannot read cannot be shown NOT to be a write.
    //
    // MEASURED BEFORE IT WAS ADOPTED: the factory holds 56 plain literals, 19 of which name the
    // relation, and all 19 parse. Nothing legitimate pays for the posture today.
    if (audit.lexerWrites > 0 || tolerantlyNamesTable(text)) {
      fail(`a factory literal naming ${TABLE} that ${oracleIdentity()} cannot parse `
        + `(${parsed.error}) - the factory's statements are audited by the canonical grammar, and `
        + 'one it cannot read is not audited at all');
    }
    return;
  }
  const directWrites = writeNodes(parsed.stmts)
    .filter((w) => namesRelation(w.node.relation, TABLE)).length;

  // ── A FUNCTION BODY IS READ WITH THE SAME ORACLE ────────────────────────────────────────────
  //
  // A raw parse stops at the outside of a dollar-quoted body, and the factory plants a trigger
  // function whose UPDATE lives inside one. The body is parsed as PL/pgSQL and every statement it
  // contains is audited exactly like a top-level one. A body this cannot read, in the factory, is
  // a refusal: this file is small, fully known, and its whole guarantee is that its statements
  // are readable.
  let bodyWrites = 0;
  const definesFunction = nodesOf(parsed.stmts, 'CreateFunctionStmt').length > 0
    || nodesOf(parsed.stmts, 'DoStmt').length > 0;
  if (definesFunction) {
    const descended = plpgsqlExpressions(text);
    if (!descended.ok) {
      fail(`a factory literal defines a function body ${oracleIdentity()} cannot read `
        + `(${descended.error}) - an unread body is an unaudited one`);
      return;
    }
    // ── A BODY THAT BUILDS SQL IS NOT A FIXED BODY ──────────────────────────────────────────
    //
    // `EXECUTE format('UPDATE public.availability_slots SET trainer_id = %L …', …)` sends a real
    // write while every FIXED text in the body says nothing about it, so a reader that collects
    // only the fixed texts reports zero writes and zero violations — the certifying direction,
    // in the one place the factory is allowed to carry a body at all.
    if (descended.dynamic.length > 0) {
      fail('a factory function body contains PL/pgSQL this cannot read as fixed SQL '
        + `(${[...new Set(descended.dynamic)].join(', ')}) - a body that BUILDS a statement sends `
        + 'one the fixed texts in it do not mention');
      return;
    }
    for (const { query } of descended.queries) {
      const sub = parseStatementOrExpression(query);
      if (!sub.ok) {
        fail('a statement inside a factory function body this cannot parse - an unread statement '
          + 'is an unaudited one');
        return;
      }
      bodyWrites += auditWritesIn(sub.stmts, fail);
    }
  }

  // A TRIGGER PLANTED ON THE GUARDED RELATION IS A WRITE WITH ANOTHER NAME: whatever its function
  // does runs on every row that lands there, and no clause of the definition says what that is.
  // ASKED BEFORE THE "IS THERE A WRITE HERE" GATE, because a trigger DEFINITION writes nothing
  // itself — which is exactly why the suite's planted triggers need no exemption, and exactly why
  // a rule placed after that gate would never run. The factory's own planted trigger is on
  // `public.rebook_rounds`, which is what makes this a rule rather than an exemption.
  for (const trig of nodesOf(parsed.stmts, 'CreateTrigStmt')) {
    if (namesRelation(trig.relation, TABLE)) {
      fail(`a factory literal plants a trigger ON ${TABLE} - whatever its function does then runs `
        + 'on every row written there, and this cannot read it from the definition');
    }
  }

  if (audit.lexerWrites === 0 && directWrites === 0 && bodyWrites === 0) return;

  // ONE LITERAL, ONE STATEMENT. Two statements in one factory literal would mean a second one the
  // byte-equality control has no constant to match, and a text whose halves are audited apart.
  if (parsed.stmts.length !== 1) {
    fail(`a factory literal that writes ${TABLE} carries ${parsed.stmts.length} statements - the `
      + 'factory spells one statement per constant, which is what the runtime byte-equality '
      + 'control compares against');
  }
  auditWritesIn(parsed.stmts, fail);
}

// ══ G3: THE CATALOGUE AUDIT ══════════════════════════════════════════════════════════════════
//
// The apply-side analogue of G2, one deliberate step stricter. G2 says the factory's statements
// are PLAIN; three of the catalogue's seven are not, because a NATIVE JavaScript `Array` does not preserve a non-one-based lower bound — the bound is not part of the value. `pg` can carry one as TEXT (`prepareValue('[0:1]={a,b}')` passes the string through), so rendering is how these statements get the bound and not the only way it could be got
// and that SHAPE is what the replay-shape controls are about. (Measured: `pg` DOES serialize a nested array — `[['a'],['b']]` becomes `{{"a"},{"b"}}` —
// and it passes a STRING through untouched, so `'[0:1]={a,b}'` can be bound as text. What cannot
// be done is getting a lower bound out of a JavaScript `Array`. The fourth templated statement,
// the refusal probe, renders one UUID and could have been parameterised.) So the rule is structural instead: a hole may only be a
// DIRECT CALL of a named private renderer — one syntactic level, no resolution, nothing to fold —
// and the statement, with those holes filled by this file's own canonical examples, is handed to
// PostgreSQL's grammar and must come back as one closed `SELECT … FROM public.<writing routine>`
// invoking that routine and nothing but pinned value built-ins.
//
// WHY THAT IS A DIFFERENT KIND OF CLAIM FROM THE ONE IT REPLACES. The census asked "does an
// `enteringApplyWrite` DOMINATE this `.query`", which is a dataflow question over a 30,000-line
// file and had no oracle to ask. This asks three questions with decided answers: is this hole a
// call to one of three named functions; does this text parse to this exact shape; is the body of
// this entrypoint these four statements. Every one of them is syntax, and syntax is decidable.

/** The two routines that WRITE. The lifecycle wrapper is a different name and is not one. */
export const WRITING_APPLY_ROUTINES = Object.freeze([
  'rebook_round_apply_normalized_core',
  'rebook_round_apply_command_as_actor',
]);

/** The catalogue's seven typed entrypoints, pinned so an eighth is a deliberate edit. */
export const EXPECTED_CATALOGUE_ENTRYPOINTS = Object.freeze([
  'applyCommandAsActorReachability', 'applyCommandAsActorReceiptPrivacy',
  'applyCommandAsActorRefusalProbe', 'applyCommandAsActorRenderedBarrier',
  'applyNormalizedCore', 'applyNormalizedCoreShaped', 'applyNormalizedCoreShapedExtend',
]);

/**
 * WHICH of the two writing routines each entrypoint is entitled to invoke.
 *
 * G3 used to accept EITHER, which made the audit blind to the one substitution that matters most:
 * a statement can keep every structural property — one plain `FROM` call, closed arguments, its
 * own routine exactly once — while invoking the OTHER writing routine. A review round swapped
 * `APPLY_NORMALIZED_CORE` from the core to the wrapper and the whole audit stayed clean, because
 * `entrypoint` was recorded beside each statement and then never read. It is read now.
 */
export const CATALOGUE_ENTRYPOINT_ROUTINE = Object.freeze({
  applyCommandAsActorReachability: 'rebook_round_apply_command_as_actor',
  applyCommandAsActorReceiptPrivacy: 'rebook_round_apply_command_as_actor',
  applyCommandAsActorRefusalProbe: 'rebook_round_apply_command_as_actor',
  applyCommandAsActorRenderedBarrier: 'rebook_round_apply_command_as_actor',
  applyNormalizedCore: 'rebook_round_apply_normalized_core',
  applyNormalizedCoreShaped: 'rebook_round_apply_normalized_core',
  applyNormalizedCoreShapedExtend: 'rebook_round_apply_normalized_core',
});

/**
 * The catalogue's whole VALUE export surface. Types are erased and are not on it.
 *
 * A RAW TEXT EXPORT IS WHAT THIS FORBIDS. The digests exist so a runtime control can prove an
 * entrypoint sent the statement this module holds without anything outside the module ever
 * holding a statement — so exporting one is the mutation, and this pin is what refuses it.
 */
export const EXPECTED_CATALOGUE_EXPORTS = Object.freeze([
  'APPLY_CANONICAL_EXAMPLES', 'APPLY_ENTRYPOINTS', 'APPLY_STATEMENT_DIGESTS',
  // THE ONE PLACE A BYTE VIEW IS STILL READ, and it reads what the DRIVER returns rather than
  // anything a caller hands in: `bytea` comes back from `pg` as a byte view, and a control that
  // wants to compare it against a fingerprint needs it in the boundary's own canonical hex. It is
  // exported because the realpg suite is what does that comparing; it is a CONVERTER, not a
  // statement, so publishing it takes nothing invocable out of this module.
  'canonicalByteaHexFromBytes',
  ...EXPECTED_CATALOGUE_ENTRYPOINTS,
].slice().sort());

/**
 * The ONE entrypoint entitled to guard an empty slot list, pinned as a one-entry list.
 *
 * This replaces a LABEL entitlement the census carried (`… (guarding no slots)`), which was a
 * property of a string a reader recovered. It is a property of the code now: the refusal matrix's
 * apply arm mints every array with `gen_random_uuid()` inside the statement, so it genuinely has
 * no client-minted slot to check, and no other entrypoint may say so.
 */
export const CATALOGUE_NO_SLOT_ENTRYPOINTS = Object.freeze(['applyCommandAsActorRefusalProbe']);

/**
 * The three entrypoints whose spec carries a SECOND target-bearing field, `targetArray` — a
 * rendered `uuid[]` presentation alongside the bound `targets` list. An adversarial review found
 * that `noteSlotsOwned` already claimed both (`[...(s.targets ?? []), ...uuidsOf(s.targetArray)]`)
 * while the stored-result verifier checked only `targets` — the two calls had drifted apart, and a
 * slot whose id came from `targetArray` alone had its STORED row never judged. Pinning both calls
 * to the identical shape (below) is what makes that drift a certifier failure instead of a silent
 * gap.
 */
export const CATALOGUE_TARGET_ARRAY_ENTRYPOINTS = Object.freeze([
  'applyNormalizedCoreShaped', 'applyNormalizedCoreShapedExtend',
  'applyCommandAsActorRenderedBarrier',
]);

/**
 * The closed renderer list, with the CANONICAL EXAMPLE this substitutes for each one's hole.
 *
 * The examples are the CHECKER'S, not the module's: substituting what the module would produce
 * would make the audit a function of the thing it audits. They are chosen to parse in every
 * position a hole actually stands in, which is why the array example carries its own cast.
 */
export const CATALOGUE_RENDERERS = Object.freeze({
  uuidLiteral: "'00000000-0000-4000-8000-000000000000'",
  // THE SUBSTITUTION MUST BE WHAT THE RENDERER ACTUALLY EMITS. It used to be a backslash-hex
  // bytea literal while the renderer produced a `pg_catalog.decode(…)` call, so the text this
  // guard parsed was not the text the module sends. `decode` is already a permitted built-in.
  byteaHexLiteral: "pg_catalog.decode('deadbeef','hex')",
  renderArray: "ARRAY['00000000-0000-4000-8000-000000000000']::uuid[]",
});

/** The value built-ins a catalogue statement may invoke beside its own routine, by FULL name. */
// BOTH ARE SCHEMA-QUALIFIED, and one of them used not to be. The comparison is by full dotted
// name, so a bare `gen_random_uuid` in this set permitted a bare call — and a bare call resolves
// through `search_path`, which another schema can shadow. A set that decides "this call is a
// harmless built-in" must not be satisfiable by a name that does not have to mean the built-in.
export const CATALOGUE_BUILTIN_CALLS =
  new Set(['pg_catalog.decode', 'pg_catalog.gen_random_uuid', 'pg_catalog.sha256']);

/** The two guard calls, in the order an entrypoint must make them. */
const CATALOGUE_GUARDS = ['assertSlotsNotForeign', 'noteSlotsOwned'];

/** The seal every entrypoint must open with — its ONE read of the caller's argument record. */
const CATALOGUE_SEAL = 'sealed';

/**
 * The stored-result verifier every slot-creating entrypoint must call after it sends and before
 * it returns, conditioned on ONE named check — never on a caller-supplied value. It lives in the
 * authority module — the same registry every argument-side check already asks — and it judges
 * what PostgreSQL actually stored, not what the call hoped it had sent.
 */
const CATALOGUE_STORED_RESULT_VERIFIER = 'verifyStoredSlots';

/**
 * THE ONE CONDITION THE VERIFICATION MAY SKIP UNDER — measured, not assumed. The read-back is an
 * ordinary, unprivileged `SELECT`, unlike the writing routines themselves, which are `SECURITY
 * DEFINER` and catch a malformed `auth.uid()` internally before ever reaching a refusal branch. A
 * caller whose own session carries a malformed subject trips no exception inside the writing
 * routine — it closes cleanly with `status = 'refused'` — but the read-back's plain `SELECT`
 * against `availability_slots` is subject to that table's own row-level security, whose policy
 * evaluates `auth.uid()` again, uncaught. Driving the real suite found exactly this: a
 * malformed-subject caller received a JavaScript exception instead of the uniform closed row
 * every other unauthorized caller gets — a NEW, distinguishing failure mode the wire protocol was
 * built not to have. So the verification is skipped when, and ONLY when, the send's own result
 * already reports `'refused'` — not a value this audit could be tricked into reading from anywhere
 * else.
 *
 * NARROWLY, NOT "NOTHING WAS WRITTEN" IN GENERAL — the writing routines answer several OTHER
 * zero-mutation statuses too (`invalid_request`, `round_not_found`, `expected_version_mismatch`,
 * and more), each reached only once the wrapper's own auth gate has already resolved a real,
 * authorized actor. This pin does not require those recognized: the oracle above is specific to a
 * malformed SESSION reaching the read-back with an auth context the writing routine's own
 * `EXCEPTION WHEN OTHERS` swallowed, and every other status is reached only past that gate, so the
 * read-back that follows one cannot reproduce it — attempting it there is redundant, not unsafe.
 */
const CATALOGUE_REFUSAL_CHECK = 'wasRefused';

/** A routine's FULL dotted name. Reading only the last element is the `evil.unnest` hole. */
const dottedName = (call) => ((call.funcname || [])
  .map((f) => (f.String && typeof f.String.sval === 'string' ? f.String.sval : ' '))
  .join('.'));

/** Is this argument one of the closed value forms a catalogue call may carry? */
function catalogueArgumentIsClosed(node, depth = 0) {
  if (depth > 8) return false;
  const tag = tagOf(node);
  if (tag === 'ParamRef' || tag === 'A_Const') return true;
  if (tag === 'TypeCast') return catalogueArgumentIsClosed(node.TypeCast.arg, depth + 1);
  if (tag === 'A_ArrayExpr') {
    return (node.A_ArrayExpr.elements || []).every((e) => catalogueArgumentIsClosed(e, depth + 1));
  }
  if (tag === 'FuncCall') return CATALOGUE_BUILTIN_CALLS.has(dottedName(node.FuncCall));
  return false;
}

/**
 * G3-b: one statement, one closed `SELECT … FROM public.<writing routine>(closed args)`.
 *
 * Everything a `SelectStmt` can carry BESIDE that shape is refused rather than ignored: a WHERE,
 * a CTE, a set operation, a second FROM entry, a table reference, a lock, a write anywhere in the
 * tree. The point is not that any of them would be wrong here — it is that this shape is small
 * enough to enumerate EXHAUSTIVELY, which is exactly what the JavaScript question never was.
 */
function auditCatalogueStatement(text, name, rel, line, result, expected) {
  const fail = (detail) => result.violations.push({ file: rel, line,
    detail: `the catalogue statement \`${name}\`: ${detail}` });
  let parsed;
  try {
    parsed = parseSql(text);
    if (!parsed.ok) {
      fail(`${oracleIdentity()} cannot parse it (${parsed.error}) - an unread statement is an `
        + 'unaudited one');
      return;
    }
    if (parsed.stmts.length !== 1) {
      fail(`it carries ${parsed.stmts.length} statements - one constant is one statement`);
      return;
    }
    if (writeNodes(parsed.stmts).length > 0) {
      fail('it carries a WRITE of its own - a catalogue statement INVOKES the apply routine and '
        + 'writes nothing itself');
      return;
    }
    if (nodesOf(parsed.stmts, 'RangeVar').length > 0) {
      fail('it names a TABLE - a catalogue statement reads no relation of its own');
      return;
    }
    const select = parsed.stmts[0].stmt && parsed.stmts[0].stmt.SelectStmt;
    if (!select) {
      fail('it is not a SELECT - the only closed shape is `SELECT … FROM public.<routine>(…)`');
      return;
    }
    for (const clause of ['whereClause', 'withClause', 'groupClause', 'havingClause',
      'sortClause', 'limitCount', 'limitOffset', 'lockingClause', 'windowClause',
      'distinctClause', 'intoClause', 'valuesLists']) {
      const carried = select[clause];
      if (carried !== undefined && carried !== null
        && !(Array.isArray(carried) && carried.length === 0)) {
        fail(`it carries a \`${clause}\` - the closed shape carries none`);
        return;
      }
    }
    if (select.op && select.op !== 'SETOP_NONE') {
      fail(`its value source is compound (${select.op})`);
      return;
    }
    const from = select.fromClause || [];
    if (from.length !== 1 || !from[0].RangeFunction) {
      fail(`its FROM clause has ${from.length} entry/entries and must be exactly one function `
        + 'call');
      return;
    }
    // ONE FUNCTION, NO COLUMN DEFINITION LIST. `functions` is a list of `List` nodes whose items
    // are the call and its optional `AS (col type, …)` — and a column definition list REDEFINES
    // the result shape the entrypoint's caller then reads, so an empty one is the only one this
    // accepts. `ROWS FROM (f(), g())` puts two entries in `functions` and is refused with it.
    const fns = from[0].RangeFunction.functions || [];
    const items = fns.length === 1 && fns[0].List ? (fns[0].List.items || []) : null;
    const call = items && items.length > 0 && items[0].FuncCall;
    const extras = items ? items.slice(1).filter((x) => Object.keys(x || {}).length > 0) : [];
    if (!call || extras.length > 0 || from[0].RangeFunction.is_rowsfrom
      || from[0].RangeFunction.ordinality || from[0].RangeFunction.lateral) {
      fail('its FROM entry is not ONE plain function call - a `ROWS FROM`, a `WITH ORDINALITY`, a '
        + 'LATERAL or a column definition list all change what the caller reads back');
      return;
    }
    const invoked = dottedName(call);
    if (!WRITING_APPLY_ROUTINES.some((r) => invoked === `public.${r}`)) {
      fail(`it invokes \`${invoked}\`, which is not one of the two writing apply routines this `
        + 'catalogue exists to contain, spelled `public.<routine>`');
      return;
    }
    // ...AND THE ONE ITS ENTRYPOINT IS ENTITLED TO, which is a different question. The two
    // routines have different privilege surfaces, so a statement that keeps every structural
    // property and swaps one for the other is exactly the substitution this audit exists to see.
    // FAIL CLOSED ON A MISSING MAPPING. `if (expected && …)` skipped the comparison entirely
    // when an entrypoint had no entry, so deleting a row from the table silently removed the
    // rule for that entrypoint — the shape a review round called failing open.
    if (!expected) {
      fail('the entrypoint that sends it has no pinned routine, so this audit cannot say which '
        + 'of the two writing routines it is entitled to - every entrypoint carries one, and a '
        + 'missing row is a rule that quietly stopped applying');
      return;
    }
    if (invoked !== `public.${expected}`) {
      fail(`it invokes \`${invoked}\`, but the entrypoint that sends it is entitled to `
        + `\`public.${expected}\` - the two writing routines are not interchangeable, and an `
        + 'audit that accepts either cannot see them being swapped');
      return;
    }
    const bad = (call.args || []).findIndex((a) => !catalogueArgumentIsClosed(a));
    if (bad !== -1) {
      fail(`argument ${bad + 1} is not a bound parameter, a constant, a cast, an array of those, `
        + `or one of the pinned value built-ins (${[...CATALOGUE_BUILTIN_CALLS].join(', ')})`);
      return;
    }
    // ...AND NO OTHER ROUTINE ANYWHERE IN THE TREE, by FULL name. Reading only the last element
    // is the lookalike hole `evil.unnest` opened on the slot side, and `evil.sha256` is the same
    // hole here: a schema-qualified name is a DIFFERENT routine.
    //
    // ── AND ITS OWN ROUTINE EXACTLY ONCE, WHICH IS NOT THE SAME RULE ─────────────────────────
    //
    // This loop used to SKIP every call whose name matched the one in the FROM clause, so a
    // SECOND invocation of the same writing routine — in the target list, in an argument, in a
    // cast — was accepted while the record said "exactly one closed statement invoking exactly
    // that routine". A review round found it, and it is worth more than the wording: the guard's
    // whole claim is that one entrypoint performs ONE apply, and two applies in one statement is
    // two writes under a single ownership check. Counted rather than skipped.
    let ownCalls = 0;
    for (const other of nodesOf(parsed.stmts, 'FuncCall')) {
      const full = dottedName(other);
      if (full === invoked) { ownCalls += 1; continue; }
      if (CATALOGUE_BUILTIN_CALLS.has(full)) continue;
      fail(`it also invokes \`${full}\`, which is neither its own routine nor a pinned built-in`);
      return;
    }
    if (ownCalls !== 1) {
      fail(`it invokes \`${invoked}\` ${ownCalls} times - a catalogue statement carries exactly `
        + 'ONE invocation of its own routine, because one entrypoint performs one apply and the '
        + 'ownership check ahead of it is written for one');
    }
  } catch (e) {
    if (!isIncompleteWalk(e)) throw e;
    fail(`its parse tree is deeper than this reader walks (${e.message})`);
  }
}

/**
 * G1-e: THE FACTORY'S OWN EXPORT SURFACE, PINNED — the same move G3-e makes for the catalogue,
 * asked of the file with the plainer architecture.
 *
 * `SLOT_STATEMENTS` used to be exported so a runtime control could compare what an entrypoint
 * sent against what the module holds. A caller outside the factory could import it too, and send
 * `SLOT_STATEMENTS.SLOT_UPDATE_TRAINER` on a connection of its own — the bytes are exactly what
 * this file audits, so G1/G2 have nothing to say about a write RE-SPELLED from this file's own
 * export. The module now publishes `SLOT_STATEMENT_DIGESTS` instead — a digest cannot be invoked
 * — and this rule is what makes that fact durable: a new export is a place where a reader is
 * asked whether it needs the ownership check, and re-exporting a raw statement text under any
 * name at all is refused here rather than left to whichever runtime test happened to enumerate
 * the surface that day.
 *
 * NARROWER THAN G3-e ON PURPOSE. The catalogue's four-statement/seal shape is a claim about HOW
 * each entrypoint reads its argument; the factory's entrypoints are not built to that pattern, so
 * this rule asks only the question that closes the leak this batch names: which NAMES are
 * exported. It does not re-derive the catalogue's stricter per-entrypoint shape audit, and it
 * does not fail on a module-level construct this cannot classify — every construct in the factory
 * is one of the ordinary kinds already read below (imports, types, `const`, `function`), and a
 * program that added an unrecognised top-level kind would still be read by TypeScript's own
 * parser and simply produce no export from it.
 */
export const EXPECTED_FACTORY_EXPORTS = Object.freeze([
  'SLOT_STATEMENT_DIGESTS',
  'insertSlot', 'insertSlotSeries', 'insertTemplateSlot', 'insertTemplateSlotSeries',
  'plantSourceDriftTrigger', 'setSlotBounds', 'setSlotCapacity', 'setSlotDuration',
  'setSlotExtraCosts', 'setSlotLocation', 'setSlotLocationAndShiftTimes',
  'setSlotParticipants', 'setSlotPrice', 'setSlotRatings', 'setSlotTrainer',
  'setSlotTrainerAndLocation', 'shiftSlotTimes', 'shiftSlotTimesAndSetTrainer',
  'shiftSlotTimesAndSetVisibility', 'writingIdentity',
]);

function checkFactoryExportSurface(source, rel, result) {
  const fail = (n, detail) => result.violations.push({ file: rel,
    line: n ? source.getLineAndCharacterOfPosition(n.getStart()).line + 1 : 0, detail });
  const isExported = (n) => ts.canHaveModifiers(n)
    && (ts.getModifiers(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const valueExports = [];
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || !isExported(st)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) valueExports.push(d.name.text);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) && st.name) valueExports.push(st.name.text);
  }
  const exportedNames = valueExports.slice().sort();
  const pinned = EXPECTED_FACTORY_EXPORTS.slice().sort();
  if (exportedNames.join('|') !== pinned.join('|')) {
    fail(null, `the factory exports [${exportedNames.join(', ')}], and its pinned surface is `
      + `[${pinned.join(', ')}] - the raw statement texts are deliberately not on it, because a `
      + 'digest cannot be invoked and a text can');
  }
}

/**
 * G3: the catalogue's structure, its statements, its renderers and its export surface.
 *
 * The statement constants are DERIVED FROM USE — they are exactly the things the entrypoints hand
 * to `client.query` — rather than pinned by name, so a constant that stops being sent stops being
 * audited AND stops being counted, which is one fact rather than two that can drift apart.
 */
function checkCatalogue(source, rel, result, routines = CATALOGUE_ENTRYPOINT_ROUTINE) {
  const lineOf = (n) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const fail = (n, detail) => result.violations.push({ file: rel, line: n ? lineOf(n) : 0, detail });
  const isExported = (n) => ts.canHaveModifiers(n)
    && (ts.getModifiers(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const consts = new Map();
  const functions = new Map();
  const valueExports = [];
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st)) continue;
    if (ts.isVariableStatement(st)) {
      if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) {
        fail(st, 'a mutable module-level binding in the catalogue - a statement or a renderer '
          + 'that can be reassigned is one this audit read once and the runtime sends twice');
        continue;
      }
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          fail(d, 'a destructured module-level binding in the catalogue this rule does not read');
          continue;
        }
        consts.set(d.name.text, { decl: d, exported: isExported(st) });
        if (isExported(st)) valueExports.push(d.name.text);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) && st.name) {
      functions.set(st.name.text, { decl: st, exported: isExported(st) });
      if (isExported(st)) valueExports.push(st.name.text);
      continue;
    }
    fail(st, 'a module-level construct in the catalogue this rule does not read - the catalogue '
      + 'is imports, types, `const` bindings and exported entrypoint functions, and nothing else');
  }

  /** Every name the module itself declares. Nothing inside an entrypoint may re-declare one. */
  const moduleNames = new Set([...consts.keys(), ...functions.keys()]);

  // ── G3-e: THE EXPORT SURFACE, PINNED ────────────────────────────────────────────────────────
  const exportedNames = valueExports.slice().sort();
  if (exportedNames.join('|') !== EXPECTED_CATALOGUE_EXPORTS.join('|')) {
    fail(null, `the catalogue exports [${exportedNames.join(', ')}], and its pinned surface is `
      + `[${EXPECTED_CATALOGUE_EXPORTS.join(', ')}] - the raw statement texts are deliberately `
      + 'not on it, because a digest cannot be invoked and a text can');
  }

  // ── G3-c: EACH ENTRYPOINT IS FOUR STATEMENTS, OR SIX IF IT CREATES OR CHANGES SLOTS ─────────
  //
  // FOUR was the whole shape once: the seal, the two guards, and one `return client.query(…)`.
  // That proved the ARGUMENT was checked before anything was sent — it said nothing about what
  // came BACK, and a `BEFORE` trigger rewriting `NEW.trainer_id`, or a server handing back an id
  // another identity already holds, are both invisible to an argument-side check by construction.
  // Every entrypoint that names TARGETS — every one but the refusal probe, which mints its own
  // server-side and is entitled to guard nothing — now reads them back and asks the registry to
  // judge the STORED row, not only the value that was sent. Two more statements, unskippable in
  // the same way the first four are: a fixed shape, checked structurally, with nothing after it
  // this audit did not read.
  const statementRefs = new Map();
  const sanctionedQueryCalls = new Set();
  for (const name of EXPECTED_CATALOGUE_ENTRYPOINTS) {
    const fn = functions.get(name);
    if (!fn || !fn.exported) {
      fail(null, `the catalogue entrypoint \`${name}\` is not an exported function declaration`);
      continue;
    }
    const verifiesStoredResult = !CATALOGUE_NO_SLOT_ENTRYPOINTS.includes(name);
    const expectedLength = verifiesStoredResult ? 6 : 4;
    const body = fn.decl.body;
    if (!body || body.statements.length !== expectedLength) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` is not exactly ${expectedLength} `
        + 'statements - '
        + (verifiesStoredResult
          ? 'the seal, the ownership check, the target claim, the send, the STORED-RESULT '
            + `verification (\`${CATALOGUE_STORED_RESULT_VERIFIER}\`), and the return`
          : 'the seal, the ownership check, the target claim, and one `client.query`')
        + ' - a branch, a second query or an extra statement is a place for a guard to be skipped');
      continue;
    }
    const [seal, first, second, ...rest] = body.statements;
    // ── THE SEAL, AND THE RULE THAT MAKES IT MEAN ANYTHING ──────────────────────────────────
    //
    // A review round showed the check and the send were TWO READS of the same property, so an
    // accessor could answer one thing to the guard and another to the driver. The seal reads the
    // caller's record ONCE; this rule is what stops the body from reading it again — after the
    // seal, the parameter's own identifier may not appear anywhere. That is a decidable
    // syntactic property, which is the only kind of question this design asks.
    // ── AND THE NAME THE SEND USES MUST BE THE MODULE'S, NOT A LOCAL ONE ────────────────────
    //
    // The statement and the renderers are recorded BY IDENTIFIER TEXT and then looked up among
    // the module's constants. A review round showed what that costs if anything else may declare
    // the same name: `export async function applyNormalizedCore(client, args,
    // APPLY_NORMALIZED_CORE = <some other text>)` shadows the constant, so the audit reads the
    // module's statement while the runtime sends the parameter's. The answer is not to resolve
    // the binding — resolution is the whole class of question this design removed — it is to make
    // shadowing UNCONSTRUCTIBLE: an entrypoint takes exactly two parameters, neither with an
    // initializer or a destructuring pattern, and declares exactly one local (the seal). Every
    // other identifier in the body is therefore the module's own.
    if (fn.decl.parameters.length !== 2
      || fn.decl.parameters.some((pm) => pm.initializer || pm.dotDotDotToken || pm.questionToken
        || !ts.isIdentifier(pm.name))) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not take exactly two plain `
        + 'parameters - a third one, a default or a destructuring can DECLARE a name this audit '
        + 'resolves to a module constant, and then the runtime sends something else');
      continue;
    }
    const param = fn.decl.parameters[1];
    const paramName = param && ts.isIdentifier(param.name) ? param.name.text : null;
    const sealDecl = ts.isVariableStatement(seal) && seal.declarationList.declarations.length === 1
      ? seal.declarationList.declarations[0] : null;
    const sealInit = sealDecl && sealDecl.initializer;
    const sealsParam = paramName !== null && sealDecl && ts.isIdentifier(sealDecl.name)
      && (seal.declarationList.flags & ts.NodeFlags.Const) !== 0
      && sealInit && ts.isCallExpression(sealInit) && ts.isIdentifier(sealInit.expression)
      && sealInit.expression.text === CATALOGUE_SEAL
      && sealInit.arguments.length === 1 && ts.isIdentifier(sealInit.arguments[0])
      && sealInit.arguments[0].text === paramName;
    // ...AND THE SEAL'S OWN LOCAL MAY NOT SHADOW A MODULE BINDING EITHER. `const
    // APPLY_NORMALIZED_CORE = sealed(args)` satisfies every shape rule above and makes
    // `client.query(APPLY_NORMALIZED_CORE, …)` send the sealed RECORD while this audit reads the
    // module's statement. Arity plus one local is not the property; not colliding with a module
    // name is.
    const localName = sealDecl && ts.isIdentifier(sealDecl.name) ? sealDecl.name.text : null;
    if (localName !== null && moduleNames.has(localName)) {
      fail(seal, `the catalogue entrypoint \`${name}\` names its sealed local \`${localName}\`, `
        + 'which is also a module binding - every identifier in the body must mean the module\'s, '
        + 'because that is what this audit resolves it to');
      continue;
    }
    if (!sealsParam) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not open with `
        + `\`const <local> = ${CATALOGUE_SEAL}(<its argument record>);\` - the check and the send `
        + 'must read the caller\'s values ONCE, or an accessor answers them differently');
      continue;
    }
    let readsParamAgain = false;
    const seekParam = (node) => {
      if (ts.isIdentifier(node) && node.text === paramName
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        readsParamAgain = true;
      }
      ts.forEachChild(node, seekParam);
    };
    for (const st of [first, second, ...rest]) seekParam(st);
    if (readsParamAgain) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` reads \`${paramName}\` again after `
        + 'sealing it - a second read of the caller\'s record is a second answer, which is the '
        + 'accessor shape the seal exists to remove');
    }
    const guardCall = (st) => (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)
      && ts.isIdentifier(st.expression.expression) ? st.expression : null);
    const g0 = guardCall(first);
    const g1 = guardCall(second);
    if (!g0 || g0.expression.text !== CATALOGUE_GUARDS[0]
      || !g1 || g1.expression.text !== CATALOGUE_GUARDS[1]) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not open with `
        + `\`${CATALOGUE_GUARDS[0]}(…)\` then \`${CATALOGUE_GUARDS[1]}(…)\` as its first two `
        + 'statements - the guard sequence is what makes the invocation unskippable');
      continue;
    }
    // THE NO-SLOTS ENTITLEMENT, AS A PINNED ONE-ENTRY LIST. A literal `[]` handed to the
    // ownership check means the entrypoint guards nothing, and exactly one may say so.
    // BOTH ARGUMENTS, not just the check's. An entrypoint entitled to guard no slots is entitled
    // to CLAIM no slots either, and a review round pointed out that pinning only the first left
    // `noteSlotsOwned([<anything>])` unsensed in the one place a literal `[]` is legitimate.
    const emptyLiteral = (call) => call.arguments.length > 0
      && ts.isArrayLiteralExpression(call.arguments[0]) && call.arguments[0].elements.length === 0;
    const guardsNoSlots = emptyLiteral(g0);
    if (guardsNoSlots && !emptyLiteral(g1)) {
      fail(g1, `the catalogue entrypoint \`${name}\` guards NO slots and yet claims something - `
        + 'the one no-slot entitlement covers both halves of the sequence');
    }
    if (guardsNoSlots !== CATALOGUE_NO_SLOT_ENTRYPOINTS.includes(name)) {
      fail(g0, `the catalogue entrypoint \`${name}\` `
        + `${guardsNoSlots ? 'guards NO slots' : 'guards a slot list'}, and the pinned no-slot `
        + `entitlement is [${CATALOGUE_NO_SLOT_ENTRYPOINTS.join(', ')}]`);
    }
    // THE CLAIM AND THE VERIFICATION MUST NAME THE SAME SET. `noteSlotsOwned` (g1) and
    // `verifyStoredSlots` (below, statement 5) each take an expression naming which slots this
    // call is responsible for — one PLAIN (`<local>.targets ?? []`) for the entrypoints with no
    // second target-bearing field, one COMBINED (`[...(<local>.targets ?? []),
    // ...uuidsOf(<local>.targetArray)]`) for the three pinned in `CATALOGUE_TARGET_ARRAY_ENTRYPOINTS`
    // — and an entrypoint may not answer the two calls with different shapes: that drift is exactly
    // how a slot named only in `targetArray` had its stored row claimed but never checked.
    const unwrapParen = (node) => (node && ts.isParenthesizedExpression(node) ? node.expression : node);
    const isPlainTargetsShape = (node) => {
      const n = unwrapParen(node);
      return !!n && ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression)
        && n.left.expression.text === localName && n.left.name.text === 'targets'
        && ts.isArrayLiteralExpression(n.right) && n.right.elements.length === 0;
    };
    const isCombinedTargetsShape = (node) => {
      if (!node || !ts.isArrayLiteralExpression(node) || node.elements.length !== 2) return false;
      const [e0, e1] = node.elements;
      if (!ts.isSpreadElement(e0) || !isPlainTargetsShape(e0.expression)) return false;
      if (!ts.isSpreadElement(e1) || !ts.isCallExpression(e1.expression)) return false;
      const call = e1.expression;
      return ts.isIdentifier(call.expression) && call.expression.text === 'uuidsOf'
        && call.arguments.length === 1 && ts.isPropertyAccessExpression(call.arguments[0])
        && ts.isIdentifier(call.arguments[0].expression) && call.arguments[0].expression.text === localName
        && call.arguments[0].name.text === 'targetArray';
    };
    const targetsClaimShape = (node) => (isPlainTargetsShape(node) ? 'plain'
      : isCombinedTargetsShape(node) ? 'combined' : null);
    const expectedClaimShape = guardsNoSlots ? null
      : CATALOGUE_TARGET_ARRAY_ENTRYPOINTS.includes(name) ? 'combined' : 'plain';
    const g1ClaimShape = guardsNoSlots ? null : targetsClaimShape(g1.arguments[0]);
    if (!guardsNoSlots && g1ClaimShape !== expectedClaimShape) {
      fail(g1, `the catalogue entrypoint \`${name}\` claims its targets with a shape this cannot `
        + `read as \`${expectedClaimShape}\` - CATALOGUE_TARGET_ARRAY_ENTRYPOINTS pins which `
        + 'entrypoints carry a second target-bearing field, and `noteSlotsOwned`\'s argument must '
        + 'say exactly that, in the exact form this checker recognizes');
    }
    // RECORDED BY IDENTIFIER TEXT, exactly as the module's own constants and renderers are —
    // used by both shapes below, so it is one function rather than two copies that can drift.
    const recordStatementRef = (arg) => {
      if (arg && ts.isIdentifier(arg)) {
        statementRefs.set(arg.text, { form: 'plain', node: arg, entrypoint: name });
      } else if (arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
        statementRefs.set(arg.expression.text, { form: 'rendered', node: arg, entrypoint: name });
      } else {
        fail(fn.decl, `the catalogue entrypoint \`${name}\` sends something that is neither a `
          + 'module constant nor a direct call of one - a statement this audit cannot name is a '
          + 'statement it cannot read');
      }
    };
    const queryCallOn = (expr) => (expr && ts.isCallExpression(expr)
      && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'query'
      && ts.isIdentifier(expr.expression.expression) && expr.expression.expression.text === 'client'
      ? expr : null);

    if (!verifiesStoredResult) {
      // ── THE ORIGINAL FOUR-STATEMENT SHAPE, FOR THE ONE ENTRYPOINT THAT NAMES NO TARGET ─────
      const [last] = rest;
      const call = ts.isReturnStatement(last) ? queryCallOn(last.expression) : null;
      if (!call) {
        fail(fn.decl, `the catalogue entrypoint \`${name}\` does not END with one `
          + '`return client.query(…)` - a query anywhere else is a send this audit did not read');
        continue;
      }
      sanctionedQueryCalls.add(call.expression);
      recordStatementRef(call.arguments[0]);
      continue;
    }

    // ── THE SIX-STATEMENT SHAPE: SEND INTO A LOCAL, VERIFY WHAT WAS STORED, RETURN THE SEND ──
    const [send, verify, ret] = rest;

    // (4) `const <local> = await client.query(<STATEMENT>, […]);` — the same send as before,
    // captured rather than returned directly, so its result can be judged before it leaves.
    const sendDecl = ts.isVariableStatement(send)
      && (send.declarationList.flags & ts.NodeFlags.Const) !== 0
      && send.declarationList.declarations.length === 1
      ? send.declarationList.declarations[0] : null;
    const sendLocalName = sendDecl && ts.isIdentifier(sendDecl.name) ? sendDecl.name.text : null;
    const awaited = sendDecl && sendDecl.initializer && ts.isAwaitExpression(sendDecl.initializer)
      ? sendDecl.initializer.expression : null;
    const sendCall = queryCallOn(awaited);
    // THE SEND'S OWN LOCAL MAY NOT COLLIDE EITHER — with a module binding, with the seal's local,
    // or with the parameter itself. Each is a name this audit would then resolve to the wrong
    // thing, exactly the reasoning the seal's own local is held to.
    if (sendLocalName === null || moduleNames.has(sendLocalName) || sendLocalName === localName
      || sendLocalName === paramName || !sendCall) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not open its second half with `
        + '`const <local> = await client.query(…);`, with a local that collides with nothing - a '
        + 'send this cannot read as one, or a name this audit would resolve to the wrong binding, '
        + 'is a place it loses the thread');
      continue;
    }
    sanctionedQueryCalls.add(sendCall.expression);
    recordStatementRef(sendCall.arguments[0]);

    // (5) `if (!wasRefused(<sendLocal>)) { await verifyStoredSlots(client, <seal>.targets ?? [],
    // '<label>'); }` — the DATABASE'S OWN ANSWER, judged, EXCEPT when the send's own trusted
    // result already says nothing was written. The condition may be nothing but a call to the
    // one pinned refusal check, negated, over the send's own local — never a caller-supplied
    // value, never a second read of anything, and no `else` branch that could carry a second
    // path. The call inside may read `client` and the SEALED local's `targets` — never the raw
    // parameter, which `readsParamAgain` already refuses — and a free-text label, exactly as the
    // two guard calls' own descriptive strings are.
    const skipsWhenRefused = ts.isIfStatement(verify) && !verify.elseStatement
      && ts.isPrefixUnaryExpression(verify.expression)
      && verify.expression.operator === ts.SyntaxKind.ExclamationToken
      && ts.isCallExpression(verify.expression.operand)
      && ts.isIdentifier(verify.expression.operand.expression)
      && verify.expression.operand.expression.text === CATALOGUE_REFUSAL_CHECK
      && verify.expression.operand.arguments.length === 1
      && ts.isIdentifier(verify.expression.operand.arguments[0])
      && verify.expression.operand.arguments[0].text === sendLocalName;
    if (!skipsWhenRefused) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not guard its verification with `
        + `\`if (!${CATALOGUE_REFUSAL_CHECK}(${sendLocalName ?? '…'})) { … }\`, with no \`else\` - `
        + 'the one condition this may skip verification under is the send\'s own trusted result, '
        + 'read once, negated, and nothing else');
      continue;
    }
    const verifyBody = ts.isBlock(verify.thenStatement) && verify.thenStatement.statements.length === 1
      ? verify.thenStatement.statements[0] : null;
    const verifyCall = verifyBody && ts.isExpressionStatement(verifyBody)
      && ts.isAwaitExpression(verifyBody.expression)
      && ts.isCallExpression(verifyBody.expression.expression)
      && ts.isIdentifier(verifyBody.expression.expression.expression)
      && verifyBody.expression.expression.expression.text === CATALOGUE_STORED_RESULT_VERIFIER
      ? verifyBody.expression.expression : null;
    const targetsArg = verifyCall && verifyCall.arguments.length === 3 ? verifyCall.arguments[1] : null;
    // THE SAME SHAPE `noteSlotsOwned` CLAIMED, not merely a shape this recognizes on its own — see
    // `targetsClaimShape` above. A verifier checking `targets` alone while the claim also covers
    // `targetArray` is the exact drift a review found: ownership taken over a wider set than the
    // stored-row judgement then covers.
    const readsSealedTargets = targetsClaimShape(targetsArg) === expectedClaimShape;
    if (!verifyCall || !ts.isIdentifier(verifyCall.arguments[0])
      || verifyCall.arguments[0].text !== 'client' || !readsSealedTargets
      || !ts.isStringLiteralLike(verifyCall.arguments[2])) {
      const wantShape = expectedClaimShape === 'combined'
        ? `[...(${localName}.targets ?? []), ...uuidsOf(${localName}.targetArray)]`
        : `${localName}.targets ?? []`;
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not verify the stored result with `
        + `\`await ${CATALOGUE_STORED_RESULT_VERIFIER}(client, ${wantShape}, '…');\` `
        + 'inside that one guarded branch - the database\'s own answer is what this step exists '
        + 'to judge, and a call shaped any other way is not that judgement, or claims a different '
        + 'set than `noteSlotsOwned` did');
      continue;
    }

    // (6) `return <sendLocal>;` — the send's own result, read once and handed back unchanged.
    if (!ts.isReturnStatement(ret) || !ret.expression || !ts.isIdentifier(ret.expression)
      || ret.expression.text !== sendLocalName) {
      fail(fn.decl, `the catalogue entrypoint \`${name}\` does not end with `
        + `\`return ${sendLocalName};\` - the value returned must be the send's own result, `
        + 'read once and handed back unchanged, not recomputed or replaced');
    }
  }

  // ...AND `query` IS OBTAINED NOWHERE ELSE IN THE MODULE, in any spelling. Same question the
  // scope tripwire asks of a sibling file, asked here of the one module that may legitimately
  // send: a second send is a statement no rule above read.
  const visitQuery = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'query'
      && !sanctionedQueryCalls.has(node)) {
      fail(node, 'the catalogue obtains `.query` outside an entrypoint\'s single send');
    }
    if (ts.isElementAccessExpression(node) || ts.isBindingElement(node)) {
      const key = ts.isBindingElement(node) ? (node.propertyName ?? node.name)
        : node.argumentExpression;
      const text = key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
        || ts.isIdentifier(key)) ? key.text : null;
      if (text === 'query') fail(node, 'the catalogue obtains `query` under another spelling');
      if (text === null && ts.isElementAccessExpression(node)
        && !(node.argumentExpression && ts.isNumericLiteral(node.argumentExpression))) {
        fail(node, 'the catalogue takes a COMPUTED member, which this cannot show is not `query`');
      }
    }
    ts.forEachChild(node, visitQuery);
  };
  ts.forEachChild(source, visitQuery);

  // ── G3-a / G3-b / G3-f: THE STATEMENTS THEMSELVES ───────────────────────────────────────────
  if (statementRefs.size !== EXPECTED_CATALOGUE_STATEMENTS) {
    fail(null, `the catalogue sends ${statementRefs.size} distinct statement(s), and its `
      + `inventory is pinned at ${EXPECTED_CATALOGUE_STATEMENTS}`);
  }
  for (const [name, ref] of statementRefs) {
    const held = consts.get(name);
    if (!held) {
      fail(ref.node, `the catalogue sends \`${name}\`, which is not a module constant`);
      continue;
    }
    // ── AND A STATEMENT IS NEVER EXPORTED, WHICH THE NAME EQUALITY DOES NOT SAY ─────────────
    //
    // This branch was deleted for one round as "redundant with the export-surface equality", and
    // the next review round showed the reasoning was wrong: the equality pins NAMES, not what
    // those names hold. Rename the private digest map and export a STATEMENT under the required
    // `APPLY_STATEMENT_DIGESTS` name — the exported set is still exactly the pinned one, while a
    // raw text has left the module, which is the one thing the digest inventory exists to
    // prevent. Restored, with a case of its own that the equality cannot answer.
    if (held.exported) {
      fail(ref.node, `the catalogue EXPORTS the statement \`${name}\` - a raw text export is what `
        + 'the digest inventory exists to avoid, and the export-surface equality pins names rather '
        + 'than what they hold');
      continue;
    }
    const init = held.decl.initializer;
    let template = null;
    if (ref.form === 'plain') {
      if (init && (ts.isNoSubstitutionTemplateLiteral(init) || ts.isStringLiteral(init))) {
        template = init;
      }
    } else if (init && ts.isArrowFunction(init) && init.body && !ts.isBlock(init.body)
      && (ts.isTemplateExpression(init.body) || ts.isNoSubstitutionTemplateLiteral(init.body))
      // ...AND IT DECLARES NOTHING. A rendered statement is an arrow of ONE plain parameter: a
      // default named `renderArray` would shadow the renderer this audit substitutes for, so the
      // checker would fill the hole from the module's function while the runtime called the
      // parameter's. Same shadowing question as the entrypoints', same answer — make it
      // unconstructible rather than resolve it.
      && init.parameters.length === 1
      && !init.parameters[0].initializer && !init.parameters[0].dotDotDotToken
      && !init.parameters[0].questionToken
      && ts.isIdentifier(init.parameters[0].name)
      // ...AND IT MAY NOT BE NAMED AFTER A MODULE BINDING. Arity alone is not the property: a
      // sole parameter called `renderArray` shadows the renderer this audit substitutes for, so
      // the checker fills the hole from the module's function while the runtime calls the
      // parameter's. Measured — the mutation produced no violation until this clause existed.
      && !moduleNames.has(init.parameters[0].name.text)) {
      template = init.body;
    }
    if (!template) {
      fail(held.decl, `the catalogue statement \`${name}\` is neither a plain literal nor an `
        + 'arrow whose whole body is one template literal - anything else is a statement this '
        + 'audit reads in a form the runtime does not send');
      continue;
    }
    // ── G3-a: EVERY HOLE IS A DIRECT CALL OF A NAMED RENDERER ───────────────────────────────
    let text = ts.isTemplateExpression(template) ? template.head.text : template.text;
    let closed = true;
    if (ts.isTemplateExpression(template)) {
      for (const span of template.templateSpans) {
        const e = span.expression;
        const renderer = ts.isCallExpression(e) && ts.isIdentifier(e.expression)
          ? e.expression.text : null;
        if (renderer === null
          || !Object.prototype.hasOwnProperty.call(CATALOGUE_RENDERERS, renderer)) {
          fail(span, `a hole in the catalogue statement \`${name}\` is \`${e.getText(source)}\`, `
            + 'which is not a direct call of a named private renderer '
            + `(${Object.keys(CATALOGUE_RENDERERS).join(', ')}) - one syntactic level, so there `
            + 'is nothing to resolve and nothing to fold');
          closed = false;
          break;
        }
        text += CATALOGUE_RENDERERS[renderer] + span.literal.text;
      }
    }
    if (!closed) continue;
    auditCatalogueStatement(text, name, rel, lineOf(held.decl), result,
      Object.prototype.hasOwnProperty.call(routines, ref.entrypoint)
        ? routines[ref.entrypoint] : undefined);
  }

  // ── G3-d: THE RENDERERS ARE PRIVATE, REACH NEITHER `query` NOR THE GUARD, AND RETURN TEXT ───
  for (const renderer of Object.keys(CATALOGUE_RENDERERS)) {
    const held = consts.get(renderer);
    if (!held || !held.decl.initializer || !ts.isArrowFunction(held.decl.initializer)) {
      fail(null, `the catalogue renderer \`${renderer}\` is not a module-level arrow function`);
      continue;
    }
    if (held.exported) {
      fail(held.decl, `the catalogue EXPORTS the renderer \`${renderer}\``);
    }
    const body = held.decl.initializer.body;
    const returns = [];
    const scan = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && CATALOGUE_GUARDS.includes(node.expression.text)) {
        fail(node, `the catalogue renderer \`${renderer}\` calls the ownership guard - a renderer `
          + 'produces text and decides nothing');
      }
      // ── A RENDERER-LOCAL `.query` RULE USED TO SIT HERE, AND IT IS DELETED ──────────────
      //
      // It was fully shadowed. `visitQuery` walks the WHOLE module from `ts.forEachChild(source,
      // …)` and fails on any `.query` access that is not one of the sanctioned sends, and a
      // renderer body is part of the module — so every input that could trip this rule tripped
      // that one first, and no fixture could ever distinguish them. An unsensed rule is not
      // defence in depth, it is an untested claim: it can rot, and nothing goes red. The
      // module-wide rule is the one that carries this, and it HAS cases.
      if (ts.isReturnStatement(node)) returns.push(node.expression);
      ts.forEachChild(node, scan);
    };
    scan(body);
    if (!ts.isBlock(body)) returns.push(body);
    if (returns.length === 0) {
      fail(held.decl, `the catalogue renderer \`${renderer}\` returns nothing this can read`);
    }
    for (const r of returns) {
      if (!r || !(ts.isTemplateExpression(r) || ts.isNoSubstitutionTemplateLiteral(r)
        || ts.isStringLiteral(r))) {
        fail(r || held.decl, `the catalogue renderer \`${renderer}\` returns `
          + `\`${r ? r.getText(source) : 'nothing'}\`, which is not a literal text - every return `
          + 'of a renderer is a template over validated locals');
      }
    }
  }

  // ...AND NO EXPORTED DECLARATION MAY CARRY A STATEMENT CONSTANT'S IDENTIFIER, which is how a
  // raw text would leave the module without appearing on the export surface as one.
  for (const [name, held] of consts) {
    if (!held.exported || !held.decl.initializer) continue;
    const seek = (node) => {
      if (ts.isIdentifier(node) && statementRefs.has(node.text)) {
        fail(node, `the exported \`${name}\` references the statement constant \`${node.text}\` - `
          + 'the raw texts stay inside this module');
      }
      ts.forEachChild(node, seek);
    };
    seek(held.decl.initializer);
  }
}

// ══ G4: WRITING-ROUTINE SPELLING CONTAINMENT ═════════════════════════════════════════════════
//
// Every `src/test/abc27*` file EXCEPT the catalogue — the guard's program AND the scope-drift set,
// so a sibling test cannot re-open the surface behind the program's back — is scanned for the two
// writing apply routine names. A DECODED string token, template part or identifier that spells
// one is REFUSED unless its content identity is in the pinned inventory below.
//
// ── WHY THIS IS A DIFFERENT KIND OF RULE FROM THE CENSUS IT REPLACES ─────────────────────────
//
// The census asked "does this `.query` reach a writing routine, and is it guarded" — a dataflow
// question over 30,000 lines, with no oracle, and four rounds each found the next enumeration
// hole. This asks "does this token spell one of two names", which is a question about TOKENS. It
// decides the four round-5 P1s instantly and in the same direction: a hole in an expression
// position that IS a call must still spell the routine somewhere (refused, string half); a
// `for…of` destructuring default selects a stored call text whose spelling is a property-access
// identifier (refused, identifier half); a computed subscript into a stored call map cannot
// select what is not there.
//
// ── AND WHAT IT DELIBERATELY DOES NOT CLAIM ──────────────────────────────────────────────────
//
// It makes NO dataflow claim at all. A routine name ASSEMBLED at run time out of fragments this
// cannot constant-fold is the named residual — the same residual class the slot-write promise
// already carries, and the same one the guard's honest claim states for composed SQL. The
// detector below folds the three shapes the retired scans were actually defeated by (`+`,
// `[…].join(…)`, `.concat()`) over LITERAL operands, and reports the folded text on its own
// identity. Over-reporting there is safe, because a report is a refusal somebody reads.
//
// THE RESIDUAL IS SHARPER THAN "FRAGMENTS THAT NEVER SPELL IT", and it is worth saying exactly:
// a fragment held in a VARIABLE is not folded, INCLUDING one whose value is a pinned mention. A
// pin decides a text; a composition around that text is a different text and is reported when the
// operands are literal, and is the residual when one of them is a binding. Resolving a binding is
// precisely the general JavaScript question this batch deleted rather than answered, and the
// runtime capability is what covers it: a smuggled statement still reaches no ownership check
// that the catalogue's entrypoints do not perform.
//
// COMMENTS ARE EXCLUDED, and that is a decision rather than an oversight: a JavaScript comment
// cannot reach a server. The names appear in dozens of comments across this suite explaining
// exactly this design, and refusing those would make the rule a ban on the words.
//
// BOUNDARY DISCIPLINE. A match must not be flanked by identifier characters, so a LONGER name
// that merely contains one of the two — a future `…_apply_command_as_actor_v2`, say — is a
// different routine and does not ride this refusal. `rebook_round_apply_lifecycle_command_as_actor`
// contains neither name at all (`apply_lifecycle_command` is not `apply_command`), so the shipped
// near-name is unaffected either way, and an acceptance fixture keeps that true.

// ── AN IDENTIFIER CHARACTER, NOT AN ASCII ONE ───────────────────────────────────────────────
//
// The boundary test is what keeps a LONGER name — a different routine — from riding this
// refusal. Spelled `[A-Za-z0-9_$]` it was ASCII-only, so `…_normalized_coreé`, `…_coreλ` and
// `…_core中` were all read as the guarded name followed by a non-identifier character: three
// false refusals of perfectly ordinary identifiers, found by a review round calling the matcher
// directly. PostgreSQL and JavaScript both admit those characters in an identifier, so the class
// is the Unicode one. `\p{L}` and `\p{N}` need the `u` flag; `$` and `_` are added explicitly.
// THE CLASS IS ECMASCRIPT'S `IdentifierPart`, ASKED BY NAME. Three versions of this were
// hand-assembled and each was missing something: first ASCII, then letters/numbers/marks, then
// those plus connector punctuation and the joiners — which still left out U+00B7 MIDDLE DOT and
// everything else Unicode carries in `Other_ID_Continue`. A name is an ORDINARY, LONGER
// identifier if it continues by ANY of them, so an incomplete class does not over-report, it
// REFUSES code that names something else. `ID_Continue` is the property the language cites;
// `$` and the two zero-width joiners are the additions the grammar makes on top of it.
const IDENT_CHAR = /[\p{ID_Continue}$\u200c\u200d]/u;

/** The code POINT at an index, so an astral letter is one character rather than half of one. */
const charAt = (text, at) => {
  if (at < 0 || at >= text.length) return '';
  const cp = text.codePointAt(at);
  return cp === undefined ? '' : String.fromCodePoint(cp);
};

/** ...and the code point ENDING at an index, for the character before a match. */
const charBefore = (text, at) => {
  if (at <= 0) return '';
  const prev = text.charCodeAt(at - 1);
  // A low surrogate is the second half of an astral character; step back one more for the pair.
  if (prev >= 0xDC00 && prev <= 0xDFFF && at >= 2) return text.slice(at - 2, at);
  return text[at - 1];
};

/**
 * Where in the syntax a mention stands, and which of them a pin may cover.
 *
 * `string` and `key` are pinnable: a text and a declared map key both NAME a routine without
 * reaching one. `read` and `composed` are not — obtaining something under the routine's name, or
 * assembling the name out of fragments, is what the containment is about, and there is nothing
 * outside the catalogue for either to legitimately reach.
 */
// TWO EXPORTED LISTS OF CATEGORIES USED TO SIT HERE AND NOTHING READ EITHER. They described the
// design — which categories exist, which may be pinned — while the code decided both for itself,
// so they could drift from it silently and one already had: `read` and `composed` were listed as
// pinnable in the unit assertion though the prose says neither is. The categories a pin may carry
// are asserted directly against `WRITING_ROUTINE_MENTIONS` in the unit suite instead.

/** `sha256(category | the token EXACTLY as written)`, first 16 hex — the existing pin idiom. */
/**
 * THE IDENTITY IS THE EXACT TEXT, NOT A TIDIED ONE. This used to collapse runs of whitespace and
 * trim the ends before hashing, which is right for DISPLAY and wrong for identity: `'  name  '`
 * and `'name'` hashed the same, so `' name '.trim()` inherited the pin written for the bare
 * inventory element. Folding is now done where the text is shown and nowhere else.
 */
export const mentionIdentity = (category, text) => createHash('sha256')
  .update(`${category}|${String(text)}`).digest('hex').slice(0, 16);

/** Does this decoded text spell a writing routine, on identifier boundaries, case-folded? */
export function namesWritingRoutine(text) {
  const hay = String(text).toLowerCase();
  for (const routine of WRITING_APPLY_ROUTINES) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(routine, from);
      if (at === -1) break;
      // CODE POINTS, NOT CODE UNITS. Reading one UTF-16 unit gave a surrogate HALF for an astral
      // letter — `…core𐐀` then read as the guarded name followed by a non-identifier character,
      // which is the same false refusal the ASCII class produced one alphabet earlier. Combining
      // marks are in the class for the same reason: `core` + U+0301 is one identifier.
      const before = charBefore(hay, at);
      const after = charAt(hay, at + routine.length);
      if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) return routine;
      from = at + 1;
    }
  }
  return null;
}

/**
 * The pinned inventory of DECIDED, NON-INVOKING mentions.
 *
 * Every entry is a text or an identifier that names a writing apply routine WITHOUT invoking one:
 * a catalog probe comparing `proname`, a `GRANT`/`REVOKE EXECUTE` whose object is a name, an
 * installed signature string, a `pg_get_functiondef` splicing anchor, a runbook-parity fragment,
 * or an expectation-map key. Each carries its own one-line rationale, and the set is asserted in
 * BOTH directions on the real tree: a new mention is a spelling nobody has justified, and a pin
 * nothing produces is a stale pin. That is the same discipline the census's content pins had,
 * over a question that is actually decidable.
 */
export const WRITING_ROUTINE_MENTIONS = Object.freeze([
  // ── CATALOG PROBES: `proname` compared, never called ────────────────────────────────────────
  ['d088ed2e7e02fcbe', 'template-whole', 1,
    'The Domain-A denial probe: `has_function_privilege(<role>, p.oid, \'EXECUTE\')` over a '
    + '`proname IN (…)` list. Both writing routines are named as CATALOG ROWS to be measured; '
    + 'the statement invokes neither, and `p.oid` is what the privilege question is asked of.'],
  ['731d1255376ed092', 'template-whole', 1,
    'The CORE_CLOSURE privilege probe, same shape: the five private cores named in a '
    + '`proname IN (…)` list so their effective `authenticated` privilege can be asserted.'],
  ['823468e8c6b7f7a7', 'string', 5,
    'The bare wrapper name `rebook_round_apply_command_as_actor`, as an element of an expectation '
    + 'list or a catalog inventory (`expect(rows.map(r => r.proname))`, the WRAPPERS list, the '
    + 'core/expressor pairs). A name in a JavaScript array is inert AS WRITTEN - not '
    + 'unreachable, which this cannot know: an element can be iterated. The pinned COUNT is '
    + 'what keeps a second spelling from inheriting the decision made about this one.'],
  ['99ed2366d53d0afe', 'string', 6,
    'The bare core name `rebook_round_apply_normalized_core`, in the same three roles: an '
    + 'expectation-list element, a catalog inventory row, and the private-core half of the '
    + 'core/expressor pairing that proves the activation published a pass-through.'],
  // ── GRANT / REVOKE TEXTS: the object of the statement is a NAME ─────────────────────────────
  ['ae676029a4e5ebec', 'template-whole', 2,
    'The deliberate IMPROPER grant control: `GRANT EXECUTE ON FUNCTION '
    + 'public.rebook_round_apply_normalized_core(<signature>) TO authenticated`, planted inside a '
    + 'transaction and rolled back, so the reachability probe beside it is proved to be able to '
    + 'see a grant if one existed. A GRANT names a routine; it does not run one.'],
  // ── INSTALLED SIGNATURE STRINGS ─────────────────────────────────────────────────────────────
  ['ebbc80cb24f67303', 'string', 1,
    'The installed apply WRAPPER signature, as one element of the sorted signature inventory the '
    + 'Stage-0 surface pin is taken over.'],
  ['a3b21fed2adf52f9', 'string', 1,
    'The installed apply CORE signature, in the same sorted inventory — the pair is what proves '
    + 'the wrapper and the core are two distinct installed identities rather than one name.'],
  // ── RUNBOOK-PARITY FRAGMENTS: text compared against a document ───────────────────────────────
  ['3a43178c3be886db', 'template-whole', 1,
    '`APPLY_TRANSFER_ENTRY` — the transfer-manifest LINE the ABC-27 migration is asserted to '
    + 'contain, spliced out and compared as text. It is an assertion about a file on disk.'],
  ['b2c0a477afd68058', 'template-whole', 1,
    '`APPLY_MANIFEST_ROW` — the transfer manifest VALUES row of the same document, compared the '
    + 'same way and for the same reason: the runbook and the migration must agree byte for byte.'],
  // ── `pg_get_functiondef` / MIGRATION-SOURCE SPLICING ANCHORS ────────────────────────────────
  ['b66f3c7273dcb54f', 'string', 1,
    'The opening splice anchor `CREATE OR REPLACE FUNCTION public.rebook_round_apply_normalized_'
    + 'core`, handed to `String.prototype.indexOf` over the migration text so the apply core\'s '
    + 'own body can be read out of it. An `indexOf` argument is not a statement.'],
  ['2183c9a88ae0efc8', 'string', 1,
    'The closing splice anchor `COMMENT ON FUNCTION public.rebook_round_apply_normalized_core`, '
    + 'the other end of the same `indexOf` pair.'],
  // ── EXPECTATION-MAP KEYS ────────────────────────────────────────────────────────────────────
  ['1b2a97ad431f22cf', 'key', 5,
    'The wrapper name as a declared MAP KEY: the reachability drive table, the closed-refusal row '
    + 'per wrapper, the two argument tables, and the per-migration mention census. A key declares '
    + 'an entry; obtaining one under that name is the `read` category, which has no pin at all.'],
]);

const PINNED_MENTIONS = new Set(WRITING_ROUTINE_MENTIONS.map(([id]) => id));
/** identity → the number of occurrences that were justified, which is pinned with the text. */
const PINNED_MENTION_COUNTS =
  new Map(WRITING_ROUTINE_MENTIONS.map(([id, , count]) => [id, count]));

/**
 * Which pinned mentions occur a different number of times than somebody justified.
 *
 * EXPORTED SO IT CAN BE DRIVEN. This comparison used to sit inline in the CLI, where no fixture
 * could reach it — the corpus analyses SOURCES, and this is a question about totals across the
 * whole tree. A rule only the CLI can run is a rule only a full green run exercises, and a full
 * green run cannot show what it would have refused.
 */
export const miscountedMentions = (seen, pinned = PINNED_MENTION_COUNTS) =>
  [...pinned.entries()]
    .map(([id, want]) => ({ id, want, got: seen.get(id) ?? 0 }))
    .filter(({ want, got }) => want !== got);

/** Fold the three composition shapes (`+`, `[…].join(…)`, `.concat(…)`). `null` = not folded. */
function foldedText(node, depth = 0) {
  if (depth > 8) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // A HOLE IS ONE NON-IDENTIFIER ATOM, so folding can never JOIN two fragments across it into a
    // name neither of them spells — which would be a refusal about nothing.
    return node.head.text
      + node.templateSpans.map((sp) => U + sp.literal.text).join('');
  }
  if (ts.isParenthesizedExpression(node)) return foldedText(node.expression, depth + 1);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldedText(node.left, depth + 1);
    const right = foldedText(node.right, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const target = node.expression.expression;
    if (method === 'join' && ts.isArrayLiteralExpression(target)) {
      const sep = node.arguments[0];
      const glue = node.arguments.length === 0 ? ','
        : (sep && (ts.isStringLiteral(sep) || ts.isNoSubstitutionTemplateLiteral(sep))
          ? sep.text : null);
      if (glue === null) return null;
      const parts = target.elements.map((e) => foldedText(e, depth + 1));
      return parts.some((x) => x === null) ? null : parts.join(glue);
    }
    if (method === 'concat') {
      const head = foldedText(target, depth + 1);
      if (head === null) return null;
      const parts = node.arguments.map((a) => foldedText(a, depth + 1));
      return parts.some((x) => x === null) ? null : head + parts.join('');
    }
  }
  return null;
}

/**
 * G4 over one source file. `rel` is only used to name the site; the pin set is global, because a
 * decided, non-invoking text is decided wherever it is written.
 */
export const positioned = (node, base) => {
  // EVERY MATCHING ANCESTOR, NOT THE FIRST. Returning at the first match meant a token that
  // stands in BOTH positions — `` `${CALL['name']}` `` — recorded only the inner one, so the
  // identity did not encode what the comment above says it encodes. The positions are
  // collected and sorted, so one identity means one arrangement.
  const found = new Set();
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isTemplateSpan(parent) && parent.expression === child) found.add('in-template-hole');
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) {
      found.add('in-subscript');
    }
    if (ts.isTaggedTemplateExpression(parent) && parent.template === child) {
      found.add('in-tagged-template');
    }
  }
  return found.size === 0 ? base : `${base}-${[...found].sort().join('-')}`;
};

export function checkWritingRoutineMentions(source, rel, result) {
  if (rel === CATALOGUE_REL) return;
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  /**
   * THE IDENTITY IS THE WHOLE TOKEN, NEVER THE FRAGMENT THAT MATCHED.
   *
   * A pin decides ONE TEXT — "the bare wrapper name, as an element of a catalog inventory" is a
   * decided, non-invoking mention. Keying on the fragment a DECODER produced let that pin cover
   * something else entirely: `U&"rebook!005F…" UESCAPE '!'` decodes to a token whose value IS the
   * bare name, so a whole statement INVOKING the routine inherited the inventory element's pin and
   * was accepted. The subject is therefore the token as written, and the decoded hit is reported
   * beside it — so a pin covers the text somebody justified and nothing else.
   */
  const report = (node, category, subject, hit) => {
    const identity = mentionIdentity(category, subject);
    // THE COUNT IS PART OF WHAT IS PINNED, and this is the change that closes the class. A pin
    // used to decide a TEXT, so a second occurrence of an already-justified text was accepted
    // without anybody deciding anything — which is how `for (const r of ['<pinned name>']) …`
    // reached a server through a decision written for an inventory element. Every occurrence is
    // counted, and the total is compared with the pinned total below.
    if (result.mentions) result.mentions.set(identity, (result.mentions.get(identity) ?? 0) + 1);
    // THE CATEGORY IS RECORDED, NOT JUST DECLARED. The inventory carries a category beside each
    // identity, and nothing compared it with reality: a `read` — which has no pin at all — could
    // be added while its entry called itself a `string`, and both the unit assertion and the CLI
    // accepted it, because the operational maps only ever read the id and the count.
    if (result.mentionCategories) result.mentionCategories.set(identity, category);
    if (PINNED_MENTIONS.has(identity)) return;
    const shown = String(subject).replace(/\s+/g, ' ').trim();
    const decoded = String(hit) === String(subject) ? ''
      : ` (it decodes to \`${String(hit).replace(/\s+/g, ' ').trim().slice(0, 60)}\`)`;
    result.violations.push({ file: rel, line: at(node),
      detail: `a ${category} spells a WRITING apply routine outside `
        + `${CATALOGUE_REL}: \`${shown.length > 120 ? `${shown.slice(0, 117)}...` : shown}\``
        + `${decoded} (identity ${identity}). Every invocation of those two routines is spelled in `
        + 'the catalogue and nowhere else; a decided, non-invoking mention is added to the pinned '
        + 'inventory with its own one-line rationale, which is a red, deliberate edit' });
  };
  // A DECODED TOKEN, IN BOTH DECODINGS. TypeScript hands back the JavaScript-cooked text, so a
  // `r`-escaped spelling is already resolved; `U&'…'`/`U&"…"` is SQL's own escape and is
  // decoded with the same machinery the lexer uses, so a name spelled that way inside a statement
  // is seen too.
  const spellings = (raw) => {
    const out = [raw];
    // ── THE SOURCE-LEVEL ENCODINGS, WHICH THE COOKED TEXT DOES NOT COVER ────────────────────
    //
    // TypeScript cooks escapes in ORDINARY strings, so `\u005f` in a quoted string is already an
    // underscore by the time this sees it. Two token kinds are handed over RAW:
    //
    //   · JSX text and attribute values, where `&#95;` is an underscore at runtime and this walk
    //     saw six literal characters — `<div>rebook&#95;round_apply_command_as_actor</div>`
    //     rendered the protected name and produced no finding at all;
    //   · a regular-expression literal, whose source keeps `\u005f` as four characters, so a
    //     named group can build the protected name out of escapes.
    //
    // Both are decoded here and asked as further spellings. Decoding can only ADD candidates, and
    // an added candidate can only add a refusal, so an over-eager decode is safe in this direction.
    // A CODE POINT THAT IS NOT ONE IS LEFT ALONE, NOT THROWN OVER. `String.fromCodePoint`
    // raises `RangeError` above U+10FFFF, so ordinary source text containing `&#xFFFFFF;` or
    // `&#9999999;` CRASHED the whole guard — a valid file could stop the analysis rather than be
    // analysed. A lone SURROGATE is accepted by `fromCodePoint` but is not a character either,
    // and splicing one in would only corrupt the text this then searches. Both are declined:
    // the escape is left exactly as written, which can only under-decode, never mis-decode.
    const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff
      && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null);
    const decodedSource = String(raw)
      .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m)
      .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d)) ?? m)
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m)
      .replace(/\\u([0-9a-f]{4})/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m)
      .replace(/\\x([0-9a-f]{2})/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m);
    if (decodedSource !== String(raw)) out.push(decodedSource);
    // The DEFAULT `U&` escape, decoded directly. TypeScript has already cooked any JavaScript
    // `\u` escape, so this is the SQL half of the same question.
    try { out.push(decodeUnicodeEscapes(raw)); } catch { /* an undecodable text is asked raw */ }
    // ── ...AND THE ESCAPE CHARACTER `UESCAPE` NAMES, WHICH IS NOT ALWAYS A BACKSLASH ─────────
    //
    // `U&"rebook\0055…" UESCAPE '!'` decodes with `!`, and a decoder that assumed the backslash
    // read the name as an unrelated identifier — a review round named exactly that. The answer is
    // not a second enumeration of escape characters: the SQL LEXER already implements the
    // `U&` … `UESCAPE` clause, comments and all, so it is asked, and every DECODED token value it
    // produces is a spelling. `U&` is the only SQL syntax that introduces a unicode escape, so
    // gating on it is a decidable precondition rather than a guess, and it keeps this off the
    // path for the tens of thousands of ordinary tokens in the scanned files.
    if (/u&/i.test(String(raw))) {
      try {
        for (const tok of lexSql(String(raw), { tolerant: true }).tokens) out.push(String(tok.value));
      } catch { /* a text the lexer cannot finish is asked in the spellings above */ }
    }
    return out;
  };
  /**
   * ══ THE POSITION IS PART OF THE IDENTITY, BECAUSE A PIN DECIDES A TEXT *SOMEWHERE* ═══════════
   *
   * The identity used to be `(kind, text)`, which quietly made every occurrence of one text
   * interchangeable. It is not. `'rebook_round_apply_command_as_actor'` as an ELEMENT OF A
   * CATALOG INVENTORY is inert — it names a routine and reaches nothing — and it is pinned on
   * exactly that ground. The same characters in a TEMPLATE VALUE HOLE are not inert at all:
   *
   *     client.query(`SELECT * FROM public.${"rebook_round_apply_command_as_actor"}()`, []);
   *
   * That is a complete invocation, and it USED TO PASS WITH ZERO VIOLATIONS. The hole is folded
   * to a neutral atom, so the composed text never spells the name, and the string token inherited
   * the inventory element's pin because both were category `string`. A subscript is the same
   * shape one step further along — `CALL['rebook_round_apply_command_as_actor']` READS the stored
   * call text under a pin written for an inventory entry.
   *
   * So the category now carries where the token stands. An inventory element keeps its identity;
   * the same text in a hole or a subscript is a DIFFERENT identity, is unpinned, and is refused.
   * Pinning one of those remains possible, but it is a separate, deliberate, red edit with its
   * own rationale — which is the whole point of the inventory.
   */
  const tokenText = (node, category, raw) => {
    for (const decoded of spellings(raw)) {
      if (namesWritingRoutine(decoded)) { report(node, category, raw, decoded); return; }
    }
  };
  const visit = (node) => {
    // ── THE KIND IS KEPT, BECAUSE THREE KINDS USED TO SHARE ONE CATEGORY ────────────────────
    //
    // A quoted string, a backtick with no substitution, and a SEGMENT of a template with
    // substitutions were all category `string`, so a pin written for one covered the others.
    // `` `name${''}` `` is a template head whose text is the whole name, and it inherited the
    // pin for the plain string. They are separate categories now.
    if (ts.isStringLiteral(node)) {
      tokenText(node, positioned(node, 'string'), node.text);
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      tokenText(node, positioned(node, 'template-whole'), node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokenText(node, positioned(node, 'template-segment'), node.text);
    } else if (ts.isJsxText(node)) {
      // (A JSX ATTRIBUTE arm used to sit above this one and is DELETED: an attribute's value is
      // an ordinary `StringLiteral`, which the first arm already visits, and the entity decoding
      // that made attributes matter now applies to every token. Disarming it changed no case —
      // the same reason the renderer-local `.query` rule went.)
      // JSX TEXT IS A STRING THE RUNTIME CAN READ, and this walk did not visit it. A `.tsx`
      // carrier that renders the name and a sibling that reads `props.children` is a spelling
      // outside the catalogue like any other.
      tokenText(node, positioned(node, 'jsx-text'), node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      // ── A REGEXP IS A TEXT CARRIER, AND THIS WALK USED TO BE BLIND TO IT ────────────────────
      //
      // `/rebook_round_apply_command_as_actor/.source` is a string with different punctuation,
      // and it reached a template hole without this walk ever seeing the name. The literal's own
      // text is asked, delimiters and all: `namesWritingRoutine` matches on identifier
      // boundaries, and `/` is not an identifier character, so the surrounding slashes neither
      // hide a name nor invent one.
      tokenText(node, positioned(node, 'regexp'), node.text);
    } else if (ts.isBindingElement(node) && node.propertyName
      && (ts.isStringLiteral(node.propertyName)
        || ts.isNoSubstitutionTemplateLiteral(node.propertyName))) {
      // `const { 'name': sql } = CALL;` OBTAINS the stored text under that name. The identifier
      // arm already called that a `read`; written as a string it reached the `string` arm and
      // inherited a pin meant for an inventory element.
      tokenText(node, positioned(node, 'read'), node.propertyName.text);
    } else if (ts.isPrivateIdentifier(node)) {
      // `#rebook_round_apply_command_as_actor` is an identifier this walk did not classify.
      tokenText(node, positioned(node, 'private'), node.text);
    } else if (ts.isIdentifier(node)) {
      // ── THE THREE POSITIONS AN IDENTIFIER CAN STAND IN, AND WHY ONLY ONE IS PINNABLE ──────
      //
      // A KEY declares a map entry — `CLOSED[…]`, `argsFor(…)`, an expectation map — and names a
      // routine without reaching one, so keys are pinnable. A READ obtains something under that
      // name: `CALL.rebook_round_apply_command_as_actor` is the exact round-5 P1-3 shape, where a
      // destructuring default selected a stored call text. There is no pin for a read, because
      // the thing being read cannot exist outside the catalogue in the first place.
      const parent = node.parent;
      const isKey = parent && ((ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isPropertyDeclaration(parent) && parent.name === node)
        || (ts.isEnumMember(parent) && parent.name === node));
      tokenText(node, positioned(node, isKey ? 'key' : 'read'), node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  // ── AND THE COMPOSED TEXT, which no single token spells ────────────────────────────────────
  const composed = (node) => {
    if (ts.isBinaryExpression(node) || ts.isCallExpression(node)) {
      const folded = foldedText(node);
      if (folded !== null && namesWritingRoutine(folded)) {
        // ── THE COMPOSED TEXT IS ITS OWN IDENTITY, ALWAYS ─────────────────────────────────
        //
        // This used to skip the report whenever some OPERAND already spelled the name, on the
        // grounds that it would otherwise be the same finding twice. A review round showed what
        // that costs: the bare wrapper name is a PINNED, decided mention — it is a catalog
        // inventory element — so `'SELECT public.' + <that pinned name> + '()'` had an operand
        // that "already spelled it", the operand was accepted by its pin, and the completed
        // invocation was never reported at all. A pin decides a TEXT, and the composed text is a
        // different text. It is reported on its own identity, and a legitimate composition
        // becomes a pinned entry with its own rationale like any other.
        report(node, positioned(node, 'composed'), folded, folded);
      }
    }
    ts.forEachChild(node, composed);
  };
  ts.forEachChild(source, composed);
}

/**
 * ══ THE GUARDED SQL SURFACES ═════════════════════════════════════════════════════════════════
 *
 * Three files hold SQL the RUNTIME sends on behalf of the ownership contract: the trainer
 * authority (the referential upsert), the slot-write factory, and the apply-invocation catalogue.
 * Every literal in one of them is read as SQL and held to the qualification rule below; the suite
 * and the guard's own unit file are not, because their statements are the SUBJECT of G1 rather
 * than part of the contract's own surface.
 */
const SQL_SURFACES = Object.freeze({
  [AUTHORITY_REL]: 'authority', [FACTORY_REL]: 'factory', [CATALOGUE_REL]: 'catalogue',
});

/**
 * ══ AN UNQUALIFIED FUNCTION NAME IS NOT A BUILT-IN, IT IS A `search_path` LOOKUP ═════════════
 *
 * `FROM unnest($1::uuid[])` resolves through `search_path`, which no reader here can see. A
 * schema ahead of `pg_catalog` that defines a competing `unnest(uuid[])` supplies the rows
 * instead, and the trainer an audit then calls "parameter-bound" is whatever that function
 * returned. The owner's decision was to close it by EDIT rather than by a `search_path` pin or a
 * narrowed claim: all three guarded statements write `pg_catalog.unnest`, and the unqualified
 * spelling is refused here — in the factory, in the authority module, and in the catalogue.
 *
 * FAIL-CLOSED ON BOTH SIDES OF THE PARSE. A text the grammar can read is judged on its
 * `FuncCall` nodes, which is the decided answer. A text it CANNOT read is refused if the word
 * survives a tolerant lex at all, because "the parser could not see an `unnest`" is a claim about
 * the parser. A function BODY is descended with the same oracle, for the same reason G2 descends.
 */
function auditUnnestQualification(text, surface, rel, line, result) {
  const fail = (detail) => result.violations.push({ file: rel, line, detail });
  const bare = (tree) => nodesOf(tree, 'FuncCall').some((call) => {
    const parts = (call.funcname || []).map((f) => f.String && f.String.sval);
    return parts.length === 1 && parts[0] === 'unnest';
  });
  const refuse = () => fail('an UNQUALIFIED `unnest` in the ' + surface + ' surface - an '
    + 'unqualified function name resolves through `search_path`, which this cannot see, so a '
    + 'schema ahead of `pg_catalog` defining `unnest(uuid[])` would supply the rows instead. '
    + 'Write `pg_catalog.unnest`, which is the same routine under every `search_path`');
  let parsed;
  try {
    parsed = parseSql(text);
    if (!parsed.ok) {
      if (tolerantlyNamesWord(text, 'unnest')) {
        fail('a literal naming `unnest` that ' + oracleIdentity() + ' cannot parse, in the '
          + surface + ' surface - an unread statement cannot be shown to qualify the name');
      }
      return;
    }
    if (bare(parsed.stmts)) { refuse(); return; }
    const definesFunction = nodesOf(parsed.stmts, 'CreateFunctionStmt').length > 0
      || nodesOf(parsed.stmts, 'DoStmt').length > 0;
    if (!definesFunction) return;
    // ── EVERY FAILURE PATH HERE IS CONDITIONED ON THE WORD, AND THAT IS DELIBERATE ─────────
    //
    // A body this cannot read as fixed SQL is ALREADY refused by G2, whose dynamic-statement
    // detector exists for exactly that. A rule that refused it again would be a redundant gate,
    // and a redundant gate hides its own mutation: disarming G2's detector changed no verdict
    // because this one caught the same fixture — measured, on the first run of the battery. So
    // this asks only about ITS question. An unreadable body that mentions `unnest` is still
    // refused here, because the qualification of a name this could not read is not decided.
    const descended = plpgsqlExpressions(text);
    if (!descended.ok || descended.dynamic.length > 0) {
      if (tolerantlyNamesWord(text, 'unnest')) {
        fail('a function body naming `unnest` in the ' + surface + ' surface that '
          + oracleIdentity() + ' cannot read as fixed SQL - an unread body cannot be shown to '
          + 'qualify the name');
      }
      return;
    }
    for (const { query } of descended.queries) {
      const sub = parseStatementOrExpression(query);
      if (!sub.ok) {
        if (tolerantlyNamesWord(query, 'unnest')) {
          fail('a statement naming `unnest` inside a function body in the ' + surface
            + ' surface this cannot parse');
        }
        return;
      }
      if (bare(sub.stmts)) { refuse(); return; }
    }
  } catch (e) {
    if (!isIncompleteWalk(e)) throw e;
    fail('a literal in the ' + surface + ' surface whose parse tree is deeper than this reader '
      + `walks (${e.message}) - an unfinished read is not an empty one`);
  }
}

// ══ R5: THE RUNTIME MODULES CANNOT BE DOWNSTREAM OF A READER ═════════════════════════════════
//
// Everything above is a READER. Readers have been wrong ten times across these batches, always in
// the certifying direction, and the reason none of those ten was a live defect is that no reader is
// upstream of a write: `requireOwnedByCurrentIdentity` and `assertSlotsNotForeign` decide, at
// execution time, on the strings that actually arrive.
//
// That is a property of the import graph, so it is pinned as one. A module that imports nothing
// but its own dependencies cannot consult a checker, a census or anything under `scripts/` — and
// therefore cannot have its runtime decision softened by a reader's verdict, however wrong that
// verdict is. A COMPUTED specifier is refused for the same reason a computed member call is:
// nothing here can show it is not the checker.
export const IMPORT_SURFACE = Object.freeze({
  [AUTHORITY_REL]: Object.freeze(['vitest', 'node:crypto', 'pg']),
  // `node:crypto` JOINED THIS PIN WHEN THE FACTORY'S OWN STATEMENT INVENTORY STOPPED BEING
  // EXPORTED AS TEXT. `SLOT_STATEMENTS` used to be public, so a runtime control elsewhere could
  // compare against it directly; now the factory publishes `SLOT_STATEMENT_DIGESTS` instead —
  // the same move the catalogue made for the same reason, below — and hashing is what it takes
  // to have a digest.
  [FACTORY_REL]: Object.freeze(['node:crypto', 'pg', './abc27TrainerAuthority']),
  // THE CATALOGUE IS THE THIRD RUNTIME MODULE, and it is pinned for the same reason: it is asked
  // at execution time whether the current test owns the slots an apply is about, so nothing a
  // READER produces may reach it. `node:crypto` is on the list because the statement inventory is
  // published as DIGESTS rather than as texts — a digest cannot be invoked, and hashing is what
  // it takes to have one.
  // `node:util/types` JOINED THIS PIN WITH THE CANONICAL HEX BOUNDARY. The catalogue no longer
  // accepts a caller's `Buffer`; the one place it still reads a byte view is the adapter for
  // what the DRIVER hands back, and that asks `isUint8Array`/`isArrayBuffer` — internal-slot
  // questions — instead of the `instanceof` and tag tests five review rounds defeated.
  [CATALOGUE_REL]: Object.freeze(['node:crypto', 'node:util/types', 'pg', './abc27TrainerAuthority']),
});

/**
 * Every module specifier a source obtains, with `null` text where the specifier is not a literal.
 *
 * ── THE SPELLINGS, AND THE ONE THAT WAS MISSING ───────────────────────────────────────────────
 *
 * Static `import` / `export … from`, `import x = require(…)`, dynamic `import(…)`, `require(…)`,
 * and the TYPE position `import('…').T` — which a rule that read only declarations and calls did
 * not visit at all.
 *
 * AND THE LOADERS THAT ARE NOT SPELLED LIKE IMPORTS. Node lets a module obtain another one
 * without any of the above: `process.getBuiltinModule('node:module').createRequire(import.meta.url)('./x.ts')`
 * loads a module while every construct here reads as an ordinary call. A review round found
 * exactly that. Obtaining the LOADER is what is reported now — the accessor names below are the
 * ways a module reaches one — with a `null` specifier, because what it would go on to load is not
 * a literal this can read.
 *
 * ── AND THE RESIDUAL, STATED RATHER THAN IMPLIED ──────────────────────────────────────────────
 *
 * This is an enumeration, and an enumeration of spellings is the shape this whole batch removed
 * elsewhere. It is kept here because there is no grammar to ask: "does this JavaScript obtain a
 * module" is the general dataflow question the guard's honest claim already refuses to answer. It
 * over-reports safely and under-reports for a loader nobody has named. THAT is why R5 is defence
 * in depth rather than the load-bearing part: what makes a reader's verdict unable to soften a
 * runtime decision is that no runtime module CONSULTS one — the checker and the census produce
 * assertions and exit codes, not a file, an env var or a config any runtime module reads.
 */
const MODULE_LOADER_ACCESSORS = new Set([
  'createRequire', 'getBuiltinModule', 'register', 'syncBuiltinESMExports', '_load',
]);

export function importSpecifiersOf(source) {
  const out = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const literal = (node) => (node
    && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) out.push({ text: literal(node.moduleSpecifier), line: at(node) });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      out.push({ text: ts.isExternalModuleReference(ref) ? literal(ref.expression) : null,
        line: at(node) });
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      out.push({ text: ts.isLiteralTypeNode(arg) ? literal(arg.literal) : null, line: at(node) });
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      out.push({ text: literal(node.arguments[0]), line: at(node) });
    } else if ((ts.isPropertyAccessExpression(node) && MODULE_LOADER_ACCESSORS.has(node.name.text))
      || (ts.isElementAccessExpression(node) && node.argumentExpression
        && (ts.isStringLiteral(node.argumentExpression)
          || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
        && MODULE_LOADER_ACCESSORS.has(node.argumentExpression.text))) {
      out.push({ text: null, line: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return out;
}

/** R5: the three runtime modules import exactly what they are pinned to, and nothing else. */
export function checkImportSurface(source, rel, result, surface = IMPORT_SURFACE) {
  const allowed = surface[rel];
  if (!allowed) return;
  const seen = new Set();
  for (const { text, line } of importSpecifiersOf(source)) {
    if (text !== null && allowed.includes(text)) { seen.add(text); continue; }
    result.violations.push({ file: rel, line,
      detail: `${rel} obtains \`${text ?? '<a module this cannot read a name for>'}\`, which is `
        + `not one of its pinned dependencies (${allowed.join(', ')}) - this module is what the `
        + 'RUNTIME asks before it writes, so nothing a reader produces may reach it' });
  }
  // ── ...AND THE PIN IS AN EQUALITY, NOT A CEILING ───────────────────────────────────────────
  //
  // This rule used to check ONE direction: nothing unexpected. A module that imported NOTHING
  // satisfied it perfectly, and so did one that quietly stopped using `./abc27TrainerAuthority`
  // — which is the module the ownership check lives in. That is the direction that matters: the
  // pin is supposed to say what this module IS, and half a pin says only what it is not.
  // Both directions are now asserted, so dropping a dependency is as red as adding one, and the
  // list has to be edited deliberately either way.
  const missing = allowed.filter((m) => !seen.has(m));
  if (missing.length > 0) {
    result.violations.push({ file: rel, line: 1,
      detail: `${rel} no longer obtains ${missing.map((m) => `\`${m}\``).join(', ')}, which its `
        + `pinned surface says it does (${allowed.join(', ')}). The pin is an EQUALITY: a module `
        + 'that stops obtaining the authority module has stopped asking the ownership check, and '
        + 'an allow-list alone would call that clean' });
  }
}

/**
 * R1: outside the authority module nothing may forge the brand — IN EITHER DIRECTION.
 *
 * RESOLVED BY THE CHECKER, NOT BY SPELLING. A rule that looked for the text `IsolatedTrainerId`
 * missed an aliased import (`import { type IsolatedTrainerId as Id }` then `raw as Id`), so both
 * the target type and the operand type are resolved and tested.
 *
 * THIS IS DEFENCE IN DEPTH, AND SAYING SO MATTERS. What actually stops a forged brand from
 * writing a row is `requireOwnedByCurrentIdentity()`, which asks the registry about the string
 * that arrives. This rule keeps the brand meaning what it says in the source a reader reads.
 */
function checkBrandContainment(source, rel, ctx, result) {
  if (rel === AUTHORITY_REL) return;
  const { checker, brandProp } = ctx;
  const brandedNode = (node) => !!node && isBrandedType(checker.getTypeAtLocation(node), brandProp);
  const brandedArrayNode = (node) =>
    !!node && isBrandedArrayType(checker, checker.getTypeAtLocation(node), brandProp);
  const visit = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const fail = (detail) => result.violations.push({ file: rel, line, detail });
    const assertion = ts.isAsExpression(node)
      || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
      || ts.isTypeAssertionExpression(node);
    if (assertion) {
      const targetType = checker.getTypeFromTypeNode(node.type);
      if (producesBrand(checker, targetType, brandProp)) {
        fail('a type assertion PRODUCING IsolatedTrainerId outside the authority module - the '
          + 'brand may only be minted by the authority');
      } else if (brandedArrayNode(node.expression)) {
        fail('a type assertion that WIDENS an array of IsolatedTrainerId outside the authority '
          + 'module - the widened alias shares identity with the branded array, so mutating it '
          + 'poisons a value the checker still calls branded');
      }
    }
    // ── EVERY PLACE A VALUE CAN WIDEN INTO A BRAND, AS ONE RULE ──────────────────────────────
    //
    // Under `strict: false` an `any` is assignable to everything, so a brand can be acquired with
    // no cast at all. `getContextualType` is what the checker uses to decide that very
    // assignability, so asking it here closes annotated initializers, assignment right-hand
    // sides, returned expressions, arguments to branded parameters, and members of branded arrays
    // and object literals together.
    //
    // AND THE CONTEXTUAL TYPE IS ASKED ABOUT CONTAINERS TOO. `{ t: IsolatedTrainerId }` is not
    // the brand and not an array of it, and a round found exactly that gap.
    if (ts.isExpression(node) && !ts.isIdentifier(node.parent ?? node)) {
      const contextual = checker.getContextualType(node);
      if (contextual && requiresBrand(checker, contextual, brandProp)
        && !requiresBrand(checker, checker.getTypeAtLocation(node), brandProp)) {
        fail('a value that is not branded reaching a position whose type CONTAINS a brand - under '
          + '`strict: false` that widening needs no cast, and afterwards the checker reads the '
          + 'value as branded');
      }
    }
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))
      && node.name.text === 'IsolatedTrainerId') {
      fail('a re-declaration of IsolatedTrainerId outside the authority module');
    }
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && /isolatedTrainerBrand/i.test(node.name.text)) {
      fail('a re-declaration of the brand symbol outside the authority module');
    }
    if (ts.isModuleDeclaration(node) && /abc27TrainerAuthority/.test(node.name.getText())) {
      fail('a module augmentation of the authority module, declared outside it');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/** One string/template literal: expand it, lex it, split it, classify every statement. */
function analyseLiteral(node, source, rel, ctx, result) {
  const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  // THE LITERAL'S OWN START, not just its line: a round-4 review put two identical literals on
  // ONE physical line, where file+line+verb+offset collided and the Set recorded one site.
  const site = { file: rel, line, at: node.getStart(),
    plain: isPlainLiteral(node), isFactory: ctx.isFactory };

  const texts = expansionsOf(node, ctx);
  // ── THE OVER-BOUND ARM STOPS ASKING A QUESTION IT CANNOT ANSWER ─────────────────────────────
  //
  // It used to ask whether the RAW TypeScript source named the relation, which is precisely the
  // question the SQL lexer exists to stop anyone asking: a literal that expands past the bound
  // AND spells the relation through JavaScript escapes was refused by neither arm — not by this
  // one, which could not decode, and not by the reader, which never ran.
  //
  // Deciding it properly would mean reading a text that was never formed. So it is not decided:
  // exceeding the bound is REFUSED, in the factory and outside it alike. Measured before it was
  // adopted — the guarded files contain no over-bound literal today, so nothing legitimate pays
  // for the posture, and a future one is a deliberate edit rather than a silent sample.
  if (texts === OVER_BOUND) {
    result.violations.push({ file: rel, line,
      detail: `a literal expands into more than ${MAX_EXPANSIONS} texts - refused rather than `
        + 'sampled, because a text this never formed is a text it cannot read' });
    return;
  }
  if (texts === null) {
    // ── THE UNRESOLVED ARM ASKS ABOUT THE ASSEMBLED TEXT, AND THAT TEXT WAS NEVER FORMED ──────
    //
    // This arm is reached only for a `+`/`.join()`/`.concat()` assembly this could not fold — a
    // template always expands, with unresolved holes becoming atoms. EVERY STRING OPERAND OF SUCH
    // AN ASSEMBLY IS VISITED ON ITS OWN, cooked by TypeScript, and read as SQL there; so a
    // JavaScript escape spelling the relation inside one of them is already decoded and refused
    // one node down, which is why asking the same question of "cooked parts" here would add no
    // discrimination and was not kept. What is left for this arm is the text those operands would
    // COMPOSE INTO — which no operand spells and which was never built. That is a value the
    // program computes by means this cannot fold: the residual stated in the honest claim above,
    // and the runtime registry's to refuse, not this reader's. The raw question is the tripwire's
    // honest remainder here and can only ADD a refusal.
    if (tolerantlyNamesTable(node.getText())) {
      result.violations.push({ file: rel, line,
        detail: `a literal naming ${TABLE} is composed by means this cannot fold - refused rather `
          + 'than left unread' });
    }
    return;
  }
  for (const text of texts) {
    const audit = { lexerWrites: 0 };
    analyseSqlText(text, { ...site, audit }, rel, line, ctx, result, 0);
    // ── G2 IS THE ORACLE'S, AND IT IS ASKED OF THE WHOLE LITERAL ─────────────────────────────
    //
    // A non-plain factory literal is already refused by the plainness rule above; the parse would
    // see hole atoms and fail, which would say nothing more.
    if (ctx.isFactory && site.plain) auditFactoryText(text, audit, rel, line, result);
    // ...AND THE QUALIFICATION RULE IS ASKED OF EVERY TEXT IN A GUARDED SURFACE, plain or not: a
    // template that interpolates around an unqualified `unnest` is exactly as unqualified.
    if (ctx.surface) auditUnnestQualification(text, ctx.surface, rel, line, result);
  }
}

/**
 * Does this text name the guarded relation when it is read as far as it CAN be read?
 *
 * Only reached when the strict lexer threw. Every terminator is relaxed, the decoded tokens are
 * compared to the relation rather than the raw characters, and dollar-quoted and string bodies are
 * asked the same question. Anything still unreadable answers yes: on this path a gate that says
 * "no" is certifying a text it could not read.
 */
function tolerantlyNamesWord(text, word, depth = 0) {
  if (depth > 3) return true;
  if (String(text).toLowerCase().includes(word)) return true;
  let lexed;
  try {
    lexed = lexSql(String(text), { tolerant: true });
  } catch {
    return true;
  }
  for (const tok of lexed.tokens) {
    if (String(tok.value).toLowerCase() === word) return true;
    if ((tok.kind === 'dollar' || tok.kind === 'string')
      && tolerantlyNamesWord(String(tok.value), word, depth + 1)) return true;
  }
  return false;
}

const tolerantlyNamesTable = (text, depth = 0) => tolerantlyNamesWord(text, TABLE, depth);

function analyseSqlText(text, site, rel, line, ctx, result, depth) {
  if (depth > 3) {
    result.violations.push({ file: rel, line,
      detail: 'dollar-quoted bodies nested more than three deep - refused rather than descended' });
    return;
  }
  let lexed;
  try {
    lexed = lexSql(text);
  } catch (e) {
    // ── A TEXT THIS CANNOT LEX IS ASKED AGAIN, TOLERANTLY ─────────────────────────────────────
    //
    // The fallback here used to be `text.includes(TABLE)` on the RAW source — which is precisely
    // the question this lexer exists to stop anyone asking. A spelling that made the lexer throw
    // could name the relation in a form the raw text does not contain, and then neither half
    // reported it. So the text is re-read with the terminators relaxed and the DECODED tokens are
    // asked instead, recursively through dollar-quoted and string bodies; a text that cannot be
    // read even then is refused outright.
    if (tolerantlyNamesTable(text)) {
      result.violations.push({ file: rel, line,
        detail: `a literal naming ${TABLE} could not be lexed as SQL (${e.message}) - refused` });
    }
    return;
  }
  // A DOLLAR-QUOTED BODY IS ALWAYS READ. A PLAIN string is read only where SQL puts one in an
  // EXECUTABLE position — `EXECUTE '…'` and `CREATE … FUNCTION … AS '…'` — because reading every
  // string constant as SQL would refuse ordinary data that merely reads like a statement.
  for (let k = 0; k < lexed.tokens.length; k += 1) {
    const tok = lexed.tokens[k];
    if (tok.kind === 'dollar') {
      // THE NESTED BODY GETS ITS OWN SITE POSITION. A round-6 review put two dollar-quoted
      // bodies in ONE literal, each with its exemption marker at the same offset INSIDE its own
      // body: the recursion reused the outer literal's start, the marker positions were
      // body-local and equal, and two deliberate writes collapsed into one exemption record. The
      // token's own position composes into the site, so a body's records are that body's.
      analyseSqlText(String(tok.value), { ...site, at: `${site.at}#${tok.pos}` },
        rel, line, ctx, result, depth + 1);
      continue;
    }
    if (tok.kind !== 'string') continue;
    const prev = lexed.tokens[k - 1];
    const executable = isWord(prev, 'execute')
      || (isWord(prev, 'as') && lexed.tokens.slice(0, k).some((t) => isWord(t, 'function')
        || isWord(t, 'procedure')));
    if (executable) {
      analyseSqlText(String(tok.value), { ...site, at: `${site.at}#${tok.pos}` },
        rel, line, ctx, result, depth + 1);
    }
  }
  for (const { toks, from, to } of splitStatements(lexed.tokens, text.length)) {
    // THE MARKER EXEMPTS THE STATEMENT IT IS WRITTEN IN, and only that one. A literal-wide flag
    // would let a marker on the census control exempt a second statement beside it, which is
    // exactly the over-reach the retired scan's 2,200-character window had.
    // THE MARKER'S OWN POSITION IS PART OF THE RECORD. A round-5 review put two separately-marked
    // exempt writes on ONE physical line: each was individually exempt and correct, and both
    // collapsed into a single `file:line` record, so the budget of one still held while two
    // deliberate shared-namespace writes existed. The comment's byte offset inside the literal,
    // plus the literal's own start, makes each occurrence its own record.
    const marker = lexed.comments.find(
      (cm) => cm.text.includes(EXEMPTION_MARKER) && cm.pos >= from && cm.pos < to);
    const exempt = marker !== undefined;
    const { writes, unresolved } = writesToTable(toks);
    for (const u of unresolved) {
      result.violations.push({ file: rel, line,
        detail: `an ${u.verb.toUpperCase()} whose target relation this cannot resolve - it may be `
          + `${TABLE}, and assuming otherwise is the assumption a gate must not make about `
          + `itself: \`${render(toks)}\`` });
    }
    if (writes.length === 0) continue;
    if (exempt) {
      // ONE EXEMPTION IS ONE WRITE. The marker suppresses the rule for the statement it is
      // written in, so a data-modifying CTE carrying several writes would spend one exemption on
      // all of them. Counted, and more than one is refused.
      if (writes.length > 1) {
        result.violations.push({ file: rel, line,
          detail: `an exempt statement carries ${writes.length} writes to ${TABLE} - an exemption `
            + 'covers ONE deliberate write, not a statement that can hold any number' });
        continue;
      }
      // THE EXEMPTED STATEMENT'S OWN TEXT, DIGESTED. `file`/`line` name WHERE the exemption sits
      // — brittle to any edit above it in the file — but the digest names WHAT it exempts, and
      // holds across every unrelated edit. R3 pins both: a marker moved to a different write, or
      // one added elsewhere in the same file, changes the digest even when the line still reads
      // the same number by coincidence.
      result.exemptions.push({
        file: rel, line, at: `${site.at}#${marker.pos}`,
        digest: createHash('sha256').update(render(toks)).digest('hex'),
      });
      result.writeSites.add(`${rel}:${line}@${site.at}:exempt:${marker.pos}`);
      continue;
    }
    if (!site.isFactory) {
      // ── G1 ──────────────────────────────────────────────────────────────────────────────────
      for (const w of writes) {
        result.violations.push({ file: rel, line,
          detail: `an ${w.verb.toUpperCase()} to ${TABLE} spelled outside `
            + `${FACTORY_REL} - every slot write goes through that factory, whose statements are `
            + 'fixed literals and whose entrypoints ask the ownership registry before they write; '
            + 'a statement written here asks nothing' });
      }
      continue;
    }
    // ── G2 ────────────────────────────────────────────────────────────────────────────────────
    if (!site.plain) {
      result.violations.push({ file: rel, line,
        detail: `a ${TABLE} statement in the factory is built from an interpolated or concatenated `
          + 'literal - the factory\'s whole guarantee is that no value can change what a statement '
          + 'IS, and a hole is a value that can' });
      continue;
    }
    // ONE KEY PER WRITE, NOT PER LINE-AND-VERB. A round-1 review pointed out that two UPDATEs
    // inside one literal — the planted trigger's body is exactly such a literal — share a source
    // line and a verb, so the `Set` collapsed them and the inventory tripwire could not see one
    // being added. The token offset of the verb distinguishes them and is stable across
    // reformatting of anything else in the file.
    for (const w of writes) {
      // THE TOKEN'S OWN POSITION IN THE TEXT, not its index within its statement. A round-2
      // review pointed out that `w.at` restarts at zero for every statement `splitStatements`
      // produces, so two `UPDATE`s separated by a `;` inside one literal still collapsed to one
      // key. `pos` is the byte offset the lexer recorded and is unique across the whole literal.
      result.writeSites.add(
        `${rel}:${line}@${site.at}:${w.verb}:${toks[w.at] ? toks[w.at].pos : w.at}`);
    }
    // ── THE LEXER DETECTS; THE ORACLE DECIDES ──────────────────────────────────────────────
    //
    // What used to follow here was a hand-rolled audit of the write's own clauses — region
    // scoping, SET terminators, conflict clauses, positional column/value matching, `unnest`
    // alias resolution. Every one of those was a piece of PostgreSQL's grammar re-implemented,
    // and four review rounds found four spellings each of them had not enumerated. It is gone.
    // The COUNT travels up to `analyseLiteral`, which asks the canonical parser about the whole
    // literal; the lexer's remaining job here is to say "there is a write in this text", which is
    // a claim in the reporting direction and can only cause an audit to happen.
    if (site.audit) site.audit.lexerWrites += writes.length;
  }
}

/**
 * Does this file SEND SQL? Parsed, not matched: a comment mentioning the call is not a call, and a
 * call assembled from any spelling of its argument is still a call.
 *
 * THREE SHAPES, AND THE THIRD IS WHY THIS IS NOT A ONE-LINER.
 *
 *   `client.query(…)`      — the ordinary member call.
 *   `client['query'](…)`   — the same call written with a literal subscript. A round-5 review used
 *                            exactly this: reading only `PropertyAccessExpression` missed it, and
 *                            with the verb and the relation in separate declarations neither the
 *                            raw nor the squashed text carried a complete `INSERT` either.
 *   `client[expr](…)`      — a COMPUTED member call. Nothing here can say which member it names,
 *                            so it is reported. That is the deny-by-default posture this file
 *                            takes everywhere: a call this cannot read is a call it must not
 *                            certify. No `src/test/abc27*` file outside the program contains one.
 *
 * Returns the reason, or null.
 */
function sendsSql(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true);
  let found = null;
  const visit = (node) => {
    if (found) return;
    // ── THE QUESTION IS "DOES IT OBTAIN `query`", NOT "DOES IT CALL `query` HERE" ─────────────
    //
    // A round-6 review took the send one hop away from the call: `const send =
    // client.query.bind(client)` then `send(text, values)`. The callee of the call is `bind` and
    // the callee of the send is a bare identifier, so a rule that only read CALLEES saw neither —
    // and with the verb and the relation in separate declarations the text match saw nothing
    // either. A function value cannot be called unless it is first OBTAINED, so obtaining it is
    // what is read: a member READ named `query`, in any spelling, and a destructuring of one.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'query') {
      found = 'it reads a `.query` member';
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
        if (key.text === 'query') { found = "it reads a `['query']` member"; return; }
      } else if (key && ts.isNumericLiteral(key)) {
        // AN ORDINARY INDEX IS NOT A MEMBER NAME. `rows[0]` cannot be `query`, and reporting it
        // would make this a ban on subscripting rather than a question about SQL.
      } else {
        found = 'it takes a COMPUTED member, which this cannot show is not `query`';
        return;
      }
    }
    // `const { query } = client` — the member is obtained without ever being written as access.
    // AND THE NAME MAY BE QUOTED OR COMPUTED. `{ 'query': send }` is the same destructuring and
    // `{ [k]: send }` cannot be shown not to be, so the first is matched by its text and the
    // second is reported — reading only an identifier missed both.
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (name && ts.isComputedPropertyName(name)) {
        const key = name.expression;
        if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
          if (key.text === 'query') { found = 'it destructures a `query` member'; return; }
        } else {
          found = 'it destructures a COMPUTED member, which this cannot show is not `query`';
          return;
        }
      } else if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)
        || ts.isNoSubstitutionTemplateLiteral(name)) && name.text === 'query') {
        found = 'it destructures a `query` member';
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * THE SCOPE CANNOT DRIFT SILENTLY.
 *
 * This guard reads FIVE named files — the trainer authority, the slot-write factory, the apply
 * invocation catalogue, the ABC-27 realpg suite and the guard's own unit suite — and that is a
 * bounded claim only while no OTHER file of the same family writes the guarded table, or spells a
 * writing apply routine, behind its back. (The number was wrong here for a whole round: it said
 * four while the program held five, which is the kind of stale prose a stop record has to carry
 * because nothing else notices it.)
 *
 * So every `src/test/abc27*` file outside the program is checked — coarsely and deliberately:
 * this is a tripwire that says "put this file in the program", not a classification. A new ABC-27
 * file that writes `availability_slots`, or that SENDS SQL at all, is a deliberate edit to
 * `analyze`'s file list or it is a refusal. G4 is asked of these files directly rather than as a
 * tripwire, because the mention rule needs no type information to decide.
 */
export function checkScopeDrift(fileNames, repoRoot, result) {
  const root = path.join(repoRoot, 'src', 'test');
  if (!fs.existsSync(root)) return;
  const inProgram = new Set(fileNames.map((f) => path.resolve(f)));
  // THE VERB ALONE. This is a tripwire whose only demand is "put this file in the program", so
  // anything cleverer than the four verbs is a way for it to miss — `INSERT--x\nINTO` and
  // `MERGE/**/INTO` both defeated a pattern that insisted on seeing the `INTO`.
  const WRITE_VERB = /\b(insert|update|merge|copy)\b/i;
  // The two closed sets the sweep below is held to. Neither may grow by accident.
  const EXECUTABLE_SIBLING_EXTENSIONS = new Set([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  ]);
  const INERT_SIBLING_EXTENSIONS = new Set(['.json', '.md', '.snap', '.txt', '.sql', '.map']);
  // ...AND THE NAME IS SOUGHT IN THE SQUASHED TEXT AS WELL AS THE RAW TEXT.
  //
  // A round-2 review pointed out that the main analyser folds `['INSERT INTO public.avail',
  // 'ability_slots…'].join('')` while THIS reads raw source — so a sibling file outside the
  // program could carry that composition, contain no contiguous `availability_slots`, and be
  // invisible to both: never entering the program, so never folded either.
  //
  // Squashing deletes the SEAMS between adjacent string literals — a closing quote, whatever
  // punctuation joins them (`+`, `,`, `.concat(`, `.join(…)`), any whitespace, and the reopening
  // quote. It is deliberately coarse, because this is a tripwire whose only demand is that the
  // file join the program, where the real reader is.
  const squash = (text) => text.replace(
    /['"`]\s*(?:\+|,|\.concat\(|\.join\([^)]*\)|\)\s*\.join\([^)]*\))?\s*['"`]/g, '');
  // RECURSIVE AND CASE-INSENSITIVE. A file in a subdirectory is as much part of the suite family
  // as one beside it, and SQL keywords and identifiers fold case.
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out.push(...walk(full)); continue; }
      // ── A CLOSED EXTENSION CONTRACT, AND AN UNKNOWN ONE IS A REFUSAL ────────────────────
      //
      // The claim beside this sweep is "every `src/test/abc27*` file", and the pattern has been
      // wrong twice: `.ts`/`.tsx` only, then those plus `.mts`/`.cts` — while `.js`, `.jsx`,
      // `.mjs` and `.cjs` are equally importable by an in-program file and equally unread.
      // Guessing the set a third time would be the same mistake, so BOTH sets are closed and an
      // extension in neither is REPORTED rather than skipped: a new executable kind becomes a
      // deliberate decision instead of a silent omission.
      // THE NAME AND THE EXTENSION ARE SEPARATE QUESTIONS, and folding them into one pattern
      // REGRESSED this sweep: `^abc27[^.]*(\.[^.]+)$` permits exactly one dot, so the two
      // `abc27*.runtime.test.ts` files that already exist stopped being swept at all — they are
      // not in the program either, so they were checked by nothing. A compound name is the
      // ordinary shape in this tree, not an exotic one.
      //
      // The name is asked of the whole PATH, not just the basename: a file at
      // `src/test/abc27Cases/bypass.ts` belongs to the family as much as a sibling beside it,
      // and matching only the basename skipped the directory form.
      const inFamily = path.relative(root, full).split(path.sep)
        .some((seg) => /^abc27/i.test(seg));
      if (!inFamily) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (EXECUTABLE_SIBLING_EXTENSIONS.has(ext)) { out.push(full); continue; }
      if (!INERT_SIBLING_EXTENSIONS.has(ext)) undecided.push(full);
    }
    return out;
  };
  const undecided = [];
  for (const full of walk(root)) {
    if (inProgram.has(path.resolve(full))) continue;
    const text = fs.readFileSync(full, 'utf8');
    const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
    // ── G4 REACHES THE SCOPE-DRIFT SET TOO ──────────────────────────────────────────────────
    //
    // Containment that stopped at the program's edge would be containment a SIBLING re-opens: a
    // new `src/test/abc27*` file could spell a writing routine, send it, and be outside every
    // rule that reads statements. The mention rule needs no type information, so it is asked of
    // every file of the family whether or not it is in the program.
    checkWritingRoutineMentions(
      ts.createSourceFile(full, text, ts.ScriptTarget.ES2020, true), rel, result);
    // ── THE STRUCTURAL DEMAND, WHICH NO SPELLING DEFEATS ────────────────────────────────────
    //
    // Round 3 split the relation across a string-literal seam; round 4 then split the VERB across
    // two `const` declarations, where no amount of squashing reaches. Both are the same answer to
    // the same wrong question — "does this file's TEXT look like a slot write" — so the question
    // changed: does this file SEND SQL AT ALL?
    //
    // A file that calls `<something>.query(…)` and is outside the program has statements nobody
    // reads. That is decidable from the syntax tree, needs no type information (the file is not
    // in the program, which is the point), and is immune to how the text was assembled — and to
    // comments, which a text match is not. No `src/test/abc27*` file outside the program calls it
    // today, so the rule costs nothing and forecloses the whole family.
    const sends = sendsSql(text, full);
    if (sends) {
      result.violations.push({ file: rel, line: 0,
        detail: `this ABC-27 file sends SQL (${sends}) but is OUTSIDE the guard's program, so no `
          + 'statement in it is read — add it to the analysed file list deliberately, or the '
          + 'scope of this guard is narrower than it reads' });
      continue;
    }
    // ...AND THE TEXT MATCH SURVIVES BESIDE IT, for a file that carries slot SQL without sending
    // it itself — a constant exported to somewhere else. Both texts are asked both questions.
    const lower = text.toLowerCase();
    const squashed = squash(lower);
    const names = lower.includes(TABLE) || squashed.includes(TABLE);
    const writes = WRITE_VERB.test(lower) || WRITE_VERB.test(squashed);
    if (!names || !writes) continue;
    result.violations.push({ file: rel, line: 0,
      detail: `this ABC-27 file names ${TABLE} beside a write verb but is OUTSIDE the guard's `
        + 'program, so none of its write sites are proved — add it to the analysed file list '
        + 'deliberately, or the scope of this guard is narrower than it reads' });
  }
  // ...AND AN EXTENSION THIS SWEEP HAS NO OPINION ABOUT IS A REFUSAL, NOT A SKIP.
  for (const full of undecided) {
    result.violations.push({ file: path.relative(repoRoot, full).replace(/\\/g, '/'), line: 0,
      detail: 'this ABC-27 sibling has an extension the scope sweep neither reads as code nor '
        + `knows to be inert (executable: ${[...EXECUTABLE_SIBLING_EXTENSIONS].join(' ')}; inert: `
        + `${[...INERT_SIBLING_EXTENSIONS].join(' ')}). The sweep guessed this set wrong twice, so `
        + 'it no longer guesses: decide which it is and say so' });
  }
}

/** The whole analysis. Files are injected so the self-test can point it at fixtures. */
export function analyze({ files, repoRoot = REPO_ROOT, factoryFiles } = {}) {
  const fileNames = files || [AUTHORITY_REL, FACTORY_REL, CATALOGUE_REL, SUITE_REL, SELFTEST_REL]
    .map((rel) => path.join(repoRoot, rel));
  // WHICH FILES ARE THE FACTORY IS A PARAMETER, and its default is the single real one. The
  // self-test needs adversarial fixtures that are analysed AS the factory, and inferring that
  // from a filename would put a hatch in the production path: any file whose name matched would
  // acquire the right to spell a slot write. Passed explicitly, the real scan has exactly one.
  const factorySet = new Set(
    [...(factoryFiles || [path.join(repoRoot, FACTORY_REL)])].map((f) => path.resolve(f)));
  const result = { violations: [], writeSites: new Set(), exemptions: [], mentions: new Map(), mentionCategories: new Map() };
  // Only on the real repository scan: a fixture program is not the suite, and asking it about the
  // suite's siblings would make every fixture verdict depend on the tree around it.
  if (!files) checkScopeDrift(fileNames, repoRoot, result);
  for (const f of fileNames) {
    if (!fs.existsSync(f)) {
      result.violations.push({ file: path.relative(repoRoot, f), line: 0,
        detail: 'the file does not exist' });
      return result;
    }
  }
  const program = ts.createProgram(fileNames, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    noImplicitAny: false,
    baseUrl: repoRoot,
    paths: { '@/*': ['./src/*'] },
    types: [],
  });
  const checker = program.getTypeChecker();
  const authoritySource = program.getSourceFiles()
    .find((s) => s.fileName.replace(/\\/g, '/').endsWith('/' + AUTHORITY_REL));
  const brandProp = brandPropertyName(checker, authoritySource);
  if (!brandProp) {
    result.violations.push({ file: AUTHORITY_REL, line: 0,
      detail: 'the IsolatedTrainerId brand could not be read from the authority module - without '
        + 'it every binding would resolve as unbranded, so this refuses outright rather than '
        + 'reporting a flood of violations or, worse, a pass' });
    return result;
  }
  const ctx = { checker, brandProp, repoRoot, isFactory: false, surface: null };

  for (const f of fileNames) {
    const source = program.getSourceFile(f);
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    if (!source) {
      result.violations.push({ file: rel, line: 0, detail: 'the file is not part of the program' });
      continue;
    }
    ctx.isFactory = factorySet.has(path.resolve(f));
    // FACTORY-NESS IS INJECTED so fixtures can be analysed as the factory; the other two surfaces
    // are the real files by name, and a battery mutation that reverts either one's qualification
    // is red on the real tree rather than only in a fixture.
    ctx.surface = ctx.isFactory ? 'factory' : (SQL_SURFACES[rel] ?? null);
    checkBrandContainment(source, rel, ctx, result);
    checkImportSurface(source, rel, result);
    // KEYED ON THE REAL FILE, EXACTLY AS G3 IS. The self-test's factory fixtures are small
    // synthetic snippets built to drive G1/G2's write-surface rules, not full replicas of the
    // real module's export list, so pinning the export surface against every such fixture would
    // refuse the fixture corpus rather than the production file.
    if (rel === FACTORY_REL) checkFactoryExportSurface(source, rel, result);
    if (rel === CATALOGUE_REL) checkCatalogue(source, rel, result);
    checkWritingRoutineMentions(source, rel, result);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateExpression(node) || isOutermostConcatenation(node)
        || isFoldableAssembly(node)) {
        analyseLiteral(node, source, rel, ctx, result);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  // A concatenation is analysed as a whole AND its operands are visited on their own, so the same
  // verdict can be reached twice. Identical verdicts at one site are one finding.
  const seen = new Set();
  result.violations = result.violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // DEDUPLICATED BY OCCURRENCE, NOT BY LINE. A concatenation is analysed as a whole and its
  // operands again, so one exemption really can be recorded twice — but two DIFFERENT exempt
  // writes on one line are two exemptions, and keying on `file:line` alone hid the second.
  const seenEx = new Set();
  result.exemptions = result.exemptions.filter((e) => {
    const key = `${e.file}:${e.line}:${e.at}`;
    if (seenEx.has(key)) return false;
    seenEx.add(key);
    return true;
  });
  return result;
}

// ── THE CLI ───────────────────────────────────────────────────────────────────────────────────

/**
 * `analyzeFn` IS A TEST SEAM, and it exists because a rule can be right while nothing calls it.
 *
 * The occurrence-count comparison has its own cases, but those drive the FUNCTION. Deleting the
 * two lines below that call it left every committed test green — the real tree has no miscount to
 * find, so a clean run cannot show what the CLI would have refused. Handing `main` a result is
 * how the WIRING gets a negative test that lives in the repository rather than in a scratch
 * mutation harness.
 */
export function main({
  log = console.log, err = console.error, repoRoot = REPO_ROOT, analyzeFn = analyze,
} = {}) {
  const {
    violations, writeSites, exemptions, mentions, mentionCategories,
  } = analyzeFn({ repoRoot });
  const factorySites = [...writeSites].filter((s) => s.startsWith(FACTORY_REL + ':')).length;

  if (violations.length > 0) {
    err(`\n❌ ABC-27 slot write surface — ${violations.length} refusal(s):\n`);
    for (const v of violations) err(`  ${v.file}:${v.line}  ${v.detail}`);
    err(`\nEvery write to public.availability_slots in this suite must be spelled in`);
    err(`${FACTORY_REL}, whose statements are fixed literals and whose entrypoints ask`);
    err('src/test/abc27TrainerAuthority.ts whether the current test owns the trainer before they');
    err('write. This gate refuses direct bypasses; the registry is what refuses reuse at runtime.');
    return 1;
  }
  if (exemptions.length !== EXPECTED_EXEMPTIONS) {
    err(`\n❌ ABC-27 slot write surface — ${exemptions.length} ${EXEMPTION_MARKER} `
      + `exemption(s), expected exactly ${EXPECTED_EXEMPTIONS}.`);
    for (const e of exemptions) err(`  ${e.file}:${e.line}`);
    err('\nThe one permitted exemption is the census control, which writes a shared-namespace slot');
    err('on purpose and rolls it back. A second one is not an exemption, it is a hatch.');
    return 1;
  }
  // ── AND THE COUNT ALONE IS NOT THE PIN ──────────────────────────────────────────────────────
  //
  // A count of one is satisfied by ANY one exempt write, anywhere the marker sits — moving it to
  // a different statement, in a different file, changes nothing the check above sees. The
  // exemption must be the CENSUS CONTROL specifically: in the realpg suite, and exempting the
  // exact statement this was reviewed against, identified by the sha256 of its own rendered text
  // rather than by a line number that shifts with every unrelated edit above it.
  const [exemption] = exemptions;
  if (exemption.file !== SUITE_REL || exemption.digest !== EXPECTED_EXEMPTION_DIGEST) {
    err(`\n❌ ABC-27 slot write surface — the one ${EXEMPTION_MARKER} exemption is not the `
      + 'pinned census control.');
    err(`  found:   ${exemption.file}:${exemption.line}  digest ${exemption.digest}`);
    err(`  pinned:  ${SUITE_REL}  digest ${EXPECTED_EXEMPTION_DIGEST}`);
    err('\nA marker moved to a different write — or added to a different file — satisfies the');
    err('COUNT while exempting something this was never reviewed against. Move the census control');
    err('back, or re-pin the digest deliberately if the reviewed statement itself changed.');
    return 1;
  }
  // A SEPARATE STALE-PIN BRANCH USED TO SIT HERE, AND IT IS DELETED. It reported a pinned
  // identity that nothing in the tree produces — which the occurrence-count comparison below
  // already refuses, as `pinned N, found 0`, because every pinned count is positive. Two rules
  // for one condition means one of them is never the reason anything failed, and an unsensed
  // rule is an untested claim. The count comparison keeps the whole of it.
  // ── ...AND THE NUMBER OF OCCURRENCES IS PINNED WITH THE TEXT ────────────────────────────────
  //
  // A pin decided a TEXT, so once one occurrence was justified every further occurrence of the
  // same text was accepted silently — and a second occurrence can be an entirely different act.
  // A review round showed the cost: `for (const r of ['<a pinned name>']) await c.query(…)`
  // spells a name already justified as an inventory element and produced no finding at all.
  //
  // THIS RECORD USED TO ARGUE AGAINST PINNING COUNTS, and the argument was wrong. It said counts
  // would "churn on every unrelated edit in a 30,000-line file". They do not: this number moves
  // only when an occurrence of a WRITING ROUTINE NAME is added or removed, which is exactly the
  // edit that should be looked at. Unrelated edits do not touch it.
  // ...AND THE DECLARED CATEGORY MUST BE THE ONE ACTUALLY SEEN. Without this the category beside
  // each pin is a comment: the operational maps read only the id and the count, so an identity of
  // a category that has NO pin — a `read` — could be added to the inventory declaring itself a
  // `string`, and nothing would disagree.
  const misdeclared = WRITING_ROUTINE_MENTIONS
    .map(([id, category]) => ({ id, category, seen: (mentionCategories ?? new Map()).get(id) }))
    .filter(({ category, seen }) => seen !== undefined && seen !== category);
  if (misdeclared.length > 0) {
    err(`\n❌ ABC-27 writing-routine containment — ${misdeclared.length} pinned mention(s) whose `
      + 'declared category is not the category it is seen in:\n');
    for (const { id, category, seen } of misdeclared) {
      err(`  ${id}  declared \`${category}\`, seen as \`${seen}\``);
    }
    err('\nThe category decides WHICH pin a token can inherit, so a wrong one is not a typo: it');
    err('is a pin written for one kind of occurrence being applied to another.');
    return 1;
  }
  const miscounted = miscountedMentions(mentions);
  if (miscounted.length > 0) {
    err(`\n❌ ABC-27 writing-routine containment — ${miscounted.length} pinned mention(s) whose `
      + 'OCCURRENCE COUNT moved:\n');
    for (const { id, want, got } of miscounted) {
      err(`  ${id}  pinned ${want}, found ${got}`);
    }
    err('\nA pin decides a text AS MANY TIMES AS SOMEBODY JUSTIFIED IT. A new occurrence of an');
    err('already-justified name is a new act that nobody has looked at - it is how a name that is');
    err('inert in an inventory reaches a server from somewhere else. If the new occurrence is');
    err('legitimate, raise the count deliberately and say why in the rationale.');
    return 1;
  }
  if (factorySites !== EXPECTED_FACTORY_STATEMENTS) {
    err(`\n❌ ABC-27 slot write surface — ${factorySites} statement(s) in ${FACTORY_REL}, expected `
      + `exactly ${EXPECTED_FACTORY_STATEMENTS}:`);
    for (const s of [...writeSites].sort()) err(`  ${s}`);
    err('\nThis is a TRIPWIRE, not the proof: G1 is what says there are no writes elsewhere and G2');
    err('is what says these are plain. Adding one is a deliberate edit that must restate this.');
    return 1;
  }
  log(`✅ ABC-27 slot write surface — ${factorySites} fixed statement(s) in ${FACTORY_REL}, no `
    + `slot write spelled anywhere else (${exemptions.length} declared exemption: the residue `
    + 'census control). Ownership itself is enforced at runtime by the authority registry.');
  // ── AND THE APPLY SIDE, WHICH IS THE OTHER HALF OF THE SAME CONTAINMENT ───────────────────
  log(`✅ ABC-27 apply invocation surface — ${EXPECTED_CATALOGUE_STATEMENTS} audited statement(s) `
    + `in ${CATALOGUE_REL}, ${EXPECTED_CATALOGUE_ENTRYPOINTS.length} typed entrypoint(s), and `
    + `${WRITING_ROUTINE_MENTIONS.length} pinned non-invoking mention(s) over `
    + `${mentions.size} identity/identities seen. No writing apply routine is spelled elsewhere `
    + 'in the abc27 family. This makes NO dataflow claim: a name assembled at run time from '
    + 'fragments this cannot constant-fold - a binding among them included - is the stated '
    + 'residual, and the runtime ownership check is what covers it.');
  // THE ORACLE NAMES ITSELF ON EVERY RUN. A grammar that moves under this gate would otherwise be
  // visible only in a lockfile; printed here, a library bump shows up in the gate's own output.
  log(`   audited by ${oracleIdentity()}`);
  return 0;
}
// ── THE SELF-TEST ─────────────────────────────────────────────────────────────────────────────
//
// The mutation evidence for the guard itself. Every ADVERSARIAL fixture must be REFUSED and every
// CLEAN one ACCEPTED; weaken the lexer, the table reader or a rule and a named fixture below stops
// discriminating. The reviewer's escapes from every retired predecessor are fixtures by name, so
// "the approach was replaced" is a claim with evidence attached rather than an assertion.
//
// ONE PROGRAM FOR ALL OF THEM. Each fixture is its own file in one `ts.createProgram`, and the
// verdicts are partitioned by file afterwards — a program per fixture re-parsed the authority
// module once per fixture — a hundred-odd times over the current corpus — for no additional
// discrimination.

/** The fixture prelude. `c` is `any` so the fixtures depend on no database typings at all. */
const FIXTURE_PRELUDE = [
  "import { declareTrainers, mintTrainerRange, newTrainerId, testTrainer,",
  "  type IsolatedTrainerId } from '../src/test/abc27TrainerAuthority';",
  "import { insertSlot, insertTemplateSlot } from '../src/test/abc27SlotFixtures';",
  'declare const c: any;',
  'declare const anything: any;',
  "const ACADEMY = '11111111-1111-4111-8111-111111111111';",
  "const RAW = '55555555-5555-4555-8555-555555555555';",
  'export async function fixture() {',
].join('\n');

const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);

/**
 * The corpus. `verdict` is what the guard must say; `why` is what the fixture is evidence FOR.
 * `factory: true` means the file is analysed AS the slot-write factory — G2's rules instead of
 * G1's — which is how the factory's own guarantees get adversarial fixtures of their own.
 *
 * Exported so the vitest unit selftest drives exactly these, rather than a second copy that could
 * drift away from the one CI runs.
 */
export const FIXTURES = [
  // ── The clean controls. If these ever refuse, every "refused" verdict below means nothing. ──
  { name: 'clean-factory-call', verdict: 'accept',
    why: 'the ordinary shape: the suite calls the factory and spells no SQL at all',
    body: `  const t = await testTrainer(c);
  await insertSlot(c, { trainer: t, academy: ACADEMY,
    start: { at: 'fromNow', days: 1 }, end: { at: 'fromNow', days: 1, minutes: 60 } });` },
  { name: 'clean-non-slot-write', verdict: 'accept',
    why: 'a write to another relation is not this guard’s business, however it is spelled',
    body: `  await c.query(${BT}INSERT INTO public.bookings(slot_id,player_id,status)
    VALUES ($1,$2,'confirmed')${BT}, [anything, anything]);` },
  { name: 'clean-slot-select', verdict: 'accept',
    why: 'reading the guarded relation creates no overlap namespace',
    body: `  await c.query(${BT}SELECT id FROM public.availability_slots WHERE id=$1 FOR UPDATE${BT},
    [anything]);` },
  { name: 'clean-slot-delete', verdict: 'accept',
    why: 'DELETE removes a namespace rather than creating one, so it is outside the four verbs',
    body: `  await c.query(${BT}DELETE FROM public.availability_slots WHERE id=$1${BT}, [anything]);` },
  { name: 'clean-trigger-on-slots', verdict: 'accept',
    why: 'AFTER INSERT ON names the verb and the relation and writes nothing - the suite plants '
      + 'real triggers, and counting a definition as a write would force an exemption for each',
    body: `  await c.query(${BT}CREATE TRIGGER zz_t AFTER INSERT ON public.availability_slots
    FOR EACH ROW EXECUTE FUNCTION public.zz_f()${BT});` },
  { name: 'clean-interpolated-other-table', verdict: 'accept',
    why: 'an interpolation into a statement that does not write the guarded relation is ordinary',
    body: `  await c.query(${BT}INSERT INTO public.cycles(id,name) VALUES (gen_random_uuid(),'\${RAW}')${BT});` },
  { name: 'clean-table-name-as-data', verdict: 'accept',
    why: 'the table NAME inside a string is data - a reader that matched substrings refused this',
    body: `  await c.query(${BT}SELECT relname FROM pg_class WHERE relname = 'availability_slots'${BT});` },
  { name: 'clean-branded-array-to-param', verdict: 'accept',
    why: 'a branded array reaching an untyped query parameter is the ordinary shape and must not '
      + 'be refused - the widening rule is about explicit casts, not about every use',
    body: `  const ids = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 3);
  await c.query(${BT}SELECT unnest($1::uuid[])${BT}, [ids]);` },

  // ── G1: A SLOT WRITE SPELLED OUTSIDE THE FACTORY, IN EVERY SPELLING ────────────────────────
  { name: 'g1-plain-insert', verdict: 'refuse',
    why: 'the base case: a slot INSERT written in a suite file',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    VALUES ($1,$2)${BT}, [anything, ACADEMY]);` },
  { name: 'g1-insert-with-branded-trainer', verdict: 'refuse',
    why: 'THE ARCHITECTURAL CHANGE, as a fixture. The predecessor ACCEPTED this - the binding was '
      + 'authority-issued, which was the whole thing it proved. It is refused now because the '
      + 'statement asks the ownership registry nothing at the moment it writes',
    body: `  const t = await newTrainerId(c);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    VALUES ($1,$2)${BT}, [t, ACADEMY]);` },
  { name: 'g1-comment-split-verb', verdict: 'refuse',
    why: "the reviewer's own escape from the retired regex scan: INSERT/**/INTO",
    body: `  await c.query(${BT}INSERT/**/INTO public.availability_slots(trainer_id) VALUES ($1)${BT},
    [anything]);` },
  { name: 'g1-lowercase-verb', verdict: 'refuse',
    why: 'SQL keywords fold case, so a spelling-based reader missed this one too',
    body: `  await c.query(${BT}insert   into   public.availability_slots(trainer_id) values ($1)${BT},
    [anything]);` },
  { name: 'g1-unicode-escaped-table', verdict: 'refuse',
    why: 'U&"availability\\005Fslots" names the relation, and only a decoder sees it',
    body: `  await c.query(${BT}INSERT INTO public.U&"availability${BS}${BS}005Fslots"(trainer_id)
    VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-uescape-custom-escape-names-the-table', verdict: 'refuse',
    why: 'A ROUND-6 ESCAPE, and a fail-OPEN rather than a mis-read. The lexer threw on any escape '
      + 'character but the default, and the catch that surrounds it asked its fallback question of '
      + 'the UNDECODED text — so this perfectly ordinary PostgreSQL spelling of the relation lexed '
      + 'to nothing, carried no contiguous table name for the fallback to find, and was reported '
      + 'as nothing at all. UESCAPE is decoded now',
    body: `  await c.query(${BT}INSERT INTO public.U&"availability!005Fslots" UESCAPE '!'(trainer_id)
    VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-uescape-custom-escape-names-another-relation', verdict: 'accept',
    why: 'THE CONTROL FOR THE DECODER ITSELF: the same custom escape spelling a DIFFERENT relation '
      + 'is accepted, so the refusal above is decoding rather than a blanket ban on UESCAPE',
    body: `  await c.query(${BT}INSERT INTO public.U&"other!005Ftable" UESCAPE '!'(trainer_id)
    VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-unlexable-text-still-names-the-table-through-escapes', verdict: 'refuse',
    why: 'THE FALLBACK ITSELF, WHICH USED TO READ RAW CHARACTERS. An unterminated dollar-quote at '
      + 'the end makes the strict lexer throw; the raw text spells the relation nowhere; and the '
      + 'old fallback therefore said nothing about a statement that writes it. The text is re-read '
      + 'with terminators relaxed and the DECODED tokens are asked instead',
    body: `  await c.query(${BT}INSERT INTO public.U&"availability!005Fslots" UESCAPE '!'(trainer_id)
    VALUES ($1); SELECT $q$${BT}, [anything]);` },
  { name: 'g1-unlexable-text-that-names-no-relation-of-ours', verdict: 'accept',
    why: 'THE CONTROL FOR THAT FALLBACK: a text the strict lexer also refuses, naming nothing this '
      + 'guards, is accepted — so a lex failure is not itself the refusal',
    body: `  await c.query(${BT}SELECT 'a' FROM public.other_table; SELECT $q$${BT}, [anything]);` },
  { name: 'g1-uescape-separated-by-a-comment', verdict: 'refuse',
    why: 'PostgreSQL separates grammar tokens with COMMENTS as freely as with spaces, so this is '
      + 'one construct — and skipping only whitespace decoded with the default escape and then '
      + 'read `UESCAPE` as an unrelated word, leaving a different identifier entirely',
    body: `  await c.query(${BT}INSERT INTO public.U&"availability!005Fslots"
    /* a comment is whitespace */ UESCAPE '!'(trainer_id) VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-uescape-separated-by-a-comment-naming-another-relation', verdict: 'accept',
    why: 'THE CONTROL: the same comment-separated construct spelling a DIFFERENT relation is '
      + 'accepted, so the refusal above is decoding and not a ban on the shape',
    body: `  await c.query(${BT}INSERT INTO public.U&"other!005Ftable"
    /* a comment is whitespace */ UESCAPE '!'(trainer_id) VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-over-bound-literal-names-the-table-through-escapes', verdict: 'refuse',
    why: 'THE OVER-BOUND ARM, WHICH ALSO READ RAW CHARACTERS. Eighty-one expansions exceed the '
      + 'bound, so the literal is never lexed — and the arm that decides what to do about that '
      + 'could not see a relation spelled through escapes any more than the lex-failure arm could',
    body: `  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (const a of nine) {
    for (const b of nine) {
      await c.query(${BT}\${a}\${b}INSERT INTO public.U&"availability!005Fslots" UESCAPE '!'
      (trainer_id) VALUES ($1)${BT}, [anything]);
    }
  }` },
  { name: 'g1-over-bound-literal-is-refused-whatever-it-names', verdict: 'refuse',
    why: 'THE ARM NO LONGER ASKS A QUESTION IT CANNOT ANSWER. This fixture was an ACCEPTANCE: a '
      + 'literal past the bound naming another relation passed, because the arm asked whether the '
      + 'RAW TypeScript source named the guarded one. That question is undecidable on this path — '
      + 'the text was never formed — and the JavaScript-escape fixture below is what it could not '
      + 'answer. Exceeding the bound is now the refusal, measured first: the four guarded files '
      + 'contain no over-bound literal at all',
    body: `  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (const a of nine) {
    for (const b of nine) {
      await c.query(${BT}\${a}\${b}INSERT INTO public.other_table
      (trainer_id) VALUES ($1)${BT}, [anything]);
    }
  }` },
  { name: 'g1-in-bound-composition-that-names-nothing-of-ours', verdict: 'accept',
    why: 'THE CONTROL FOR THE BOUND ITSELF, which the refusal above would otherwise leave with '
      + 'none: sixty-four expansions is AT the bound and is read normally, so what refuses is '
      + 'exceeding the bound rather than composing a literal at all',
    body: `  const eight = ['1', '2', '3', '4', '5', '6', '7', '8'];
  for (const a of eight) {
    for (const b of eight) {
      await c.query(${BT}\${a}\${b}INSERT INTO public.other_table
      (trainer_id) VALUES ($1)${BT}, [anything]);
    }
  }` },
  { name: 'g1-over-bound-literal-names-the-table-through-javascript-escapes', verdict: 'refuse',
    why: 'THE A1 SHAPE, WHICH THE RAW-TEXT ARM COULD NOT SEE AT ALL. Eighty-one expansions exceed '
      + 'the bound, so the SQL reader never runs; the relation is spelled with a JAVASCRIPT '
      + 'escape, so the raw source the old arm matched on contains no `availability_slots` and the '
      + 'SQL lexer — which decodes SQL escapes, not JavaScript ones — never sees the text either. '
      + 'Restore the raw `getText()` question and this fixture is accepted',
    body: `  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (const a of nine) {
    for (const b of nine) {
      await c.query(${BT}\${a}\${b}INSERT INTO public.${BS}u0061vailability_slots
      (trainer_id) VALUES ($1)${BT}, [anything]);
    }
  }` },
  { name: 'g1-quoted-table', verdict: 'refuse',
    why: 'a double-quoted identifier is the same relation',
    body: `  await c.query(${BT}INSERT INTO public."availability_slots"(trainer_id) VALUES ($1)${BT},
    [anything]);` },
  { name: 'g1-split-literal', verdict: 'refuse',
    why: 'a statement assembled from two literals, neither of which names the relation whole',
    body: `  await c.query('INSERT INTO public.avail' + 'ability_slots(trainer_id) VALUES ($1)',
    [anything]);` },
  { name: 'g1-joined-literal-array', verdict: 'refuse',
    why: "a round-1 review's own escape: a statement assembled by `.join('')` from two literals, "
      + 'neither of which names the relation whole',
    body: `  const parts = ['INSERT INTO public.avail',
    'ability_slots(trainer_id) VALUES ($1)'];
  await c.query(parts.join(''), [anything]);` },
  { name: 'g1-concat-method', verdict: 'refuse',
    why: '...and the same assembly written with `.concat()` rather than `+` or `.join()`',
    body: `  await c.query('INSERT INTO public.avail'.concat('ability_slots(trainer_id) VALUES ($1)'),
    [anything]);` },
  { name: 'g1-dollar-quoted-body', verdict: 'refuse',
    why: 'a write inside a PL/pgSQL body, which a reader that stopped at the string token missed',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz_f() RETURNS trigger LANGUAGE plpgsql AS $zz$
    BEGIN
      UPDATE public.availability_slots SET price_per_session = 1.0 WHERE id = NEW.id;
      RETURN NEW;
    END $zz$${BT});` },
  { name: 'g1-execute-string', verdict: 'refuse',
    why: 'a string in an EXECUTE position is SQL, and is read as SQL',
    body: `  await c.query(${BT}DO $do$ BEGIN
      EXECUTE 'INSERT INTO public.availability_slots(trainer_id) VALUES (gen_random_uuid())';
    END $do$${BT});` },
  { name: 'g1-update-slot', verdict: 'refuse',
    why: 'an UPDATE of the guarded relation is a write, whichever column it moves',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET max_participants=6 WHERE id=$1${BT},
    [anything]);` },
  { name: 'g1-update-trainer', verdict: 'refuse',
    why: 'and moving the trainer itself is the most direct form of the collision',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET trainer_id=$2 WHERE id=$1${BT},
    [anything, anything]);` },
  { name: 'g1-merge', verdict: 'refuse',
    why: 'MERGE is refused outright: no site uses it, and an unexercised form is an unread rule',
    body: `  await c.query(${BT}MERGE INTO public.availability_slots t USING (SELECT 1) s ON false
    WHEN NOT MATCHED THEN INSERT (trainer_id) VALUES ($1)${BT}, [anything]);` },
  { name: 'g1-copy', verdict: 'refuse',
    why: 'COPY likewise',
    body: `  await c.query(${BT}COPY public.availability_slots(trainer_id) FROM STDIN${BT});` },
  { name: 'g1-union-values-arm', verdict: 'refuse',
    why: "the round-5 escape: a set-operation arm smuggled through an unnest alias. It needed a "
      + 'reader that counted arms; it now needs nothing, because the statement is in the wrong file',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    SELECT t.id, $1 FROM unnest($2::uuid[]) AS t(id)
    UNION ALL VALUES ('99999999-9999-4999-8999-999999999999'::uuid, $1)${BT}, [ACADEMY, anything]);` },

  // ── R2: THE UNRESOLVABLE ───────────────────────────────────────────────────────────────────
  { name: 'r2-interpolated-table', verdict: 'refuse',
    why: 'a write whose target relation is a hole may BE the guarded relation, and assuming it is '
      + 'some other one is the assumption a gate must not make about itself',
    body: `  await c.query(${BT}INSERT INTO public.\${anything}(trainer_id) VALUES ($1)${BT}, [anything]);` },
  { name: 'r2-unlexable-literal', verdict: 'refuse',
    why: 'a literal naming the relation that does not lex is not the statement it appears to be',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('unterminated${BT});` },

  // ── R1: THE BRAND ──────────────────────────────────────────────────────────────────────────
  { name: 'r1-as-cast', verdict: 'refuse',
    why: 'the only forge the type system leaves open under `strict: false`',
    body: `  const t = RAW as unknown as IsolatedTrainerId;
  await insertSlot(c, { trainer: t, academy: ACADEMY,
    start: { at: 'fromNow', days: 1 }, end: { at: 'fromNow', days: 1 } });` },
  { name: 'r1-aliased-as-cast', verdict: 'refuse',
    why: 'an aliased import defeated a rule that matched the type NAME',
    body: `  const t = RAW as unknown as Aliased;
  void t;`,
    tail: "import type { IsolatedTrainerId as Aliased } from '../src/test/abc27TrainerAuthority';" },
  { name: 'r1-containing-type-annotation', verdict: 'refuse',
    why: 'THE ROUND-5 P1. `{ t: IsolatedTrainerId }` is neither the brand nor an array of it, so '
      + 'annotating a CONTAINER walked straight past a rule that asked only those two questions',
    body: `  const box: { t: IsolatedTrainerId } = anything;
  await insertSlot(c, { trainer: box.t, academy: ACADEMY,
    start: { at: 'fromNow', days: 1 }, end: { at: 'fromNow', days: 1 } });` },
  { name: 'r1-containing-array-annotation', verdict: 'refuse',
    why: 'and a tuple or array of containers is the same hole one level further out',
    body: `  const boxes: Array<{ t: IsolatedTrainerId }> = anything;
  void boxes;` },
  { name: 'r1-branded-array-widened-by-cast', verdict: 'refuse',
    why: 'casting a branded array DOWN to string[] leaves an alias that shares identity with it, '
      + 'so mutating the alias poisons a value the checker still calls branded',
    body: `  const ids = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 3);
  const loose = ids as unknown as string[];
  loose.push(RAW);` },
  { name: 'r1-brand-redeclaration', verdict: 'refuse',
    why: 'a second declaration of the type name would make the brand mean two things',
    body: '  void 0;',
    tail: 'export type IsolatedTrainerId = string;' },
  { name: 'r1-brand-symbol-redeclaration', verdict: 'refuse',
    why: 'and re-declaring the symbol is the same move one level down',
    body: '  void 0;',
    tail: 'declare const isolatedTrainerBrand: unique symbol;' },
  { name: 'r1-module-augmentation', verdict: 'refuse',
    why: 'augmenting the authority module from outside is minting by another name',
    body: '  void 0;',
    tail: "declare module '../src/test/abc27TrainerAuthority' { export const extra: number; }" },

  // ── G2: THE FACTORY'S OWN STATEMENTS ───────────────────────────────────────────────────────
  { name: 'g2-plain-insert-param-trainer', verdict: 'accept', factory: true,
    why: 'the factory shape: a complete fixed literal whose trainer is a bound parameter',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots
    (id, trainer_id, academy_profile_id, start_time, end_time)
    VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, now(), now())
    RETURNING id${BT}, [anything, anything, ACADEMY]);` },
  { name: 'g2-unnest-series', verdict: 'accept', factory: true,
    why: 'a lane of slots, one per supplied trainer, paired by WITH ORDINALITY — and the name is '
      + 'catalog-qualified, which is the only spelling that IS the built-in',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots
    (id, trainer_id, academy_profile_id, start_time, end_time)
    SELECT gen_random_uuid(), t.id, $2::uuid, now(), now()
      FROM pg_catalog.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)
    RETURNING id${BT}, [anything, ACADEMY]);` },
  { name: 'g2-unqualified-unnest', verdict: 'refuse', factory: true,
    why: 'THE ROUND-5 P1, AND THE ONLY FIXTURE THAT ISOLATES ITS RULE. The trainer here is a '
      + 'well-behaved bound parameter and the `unnest` alias authorises nothing, so the binding '
      + 'audit has no complaint at all — what refuses is the UNQUALIFIED name, which resolves '
      + 'through a `search_path` no reader can see. Every guarded surface writes '
      + '`pg_catalog.unnest`, and reverting either half of that is red here',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT $1, $2 FROM unnest($3::int[]) AS g(i)${BT}, [anything, ACADEMY, anything]);` },
  { name: 'g2-update-without-trainer', verdict: 'accept', factory: true,
    why: 'an UPDATE that does not move the trainer needs no trainer binding to audit',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET max_participants = $2::int
    WHERE id = $1::uuid${BT}, [anything, 4]);` },
  { name: 'g2-update-trainer-param', verdict: 'accept', factory: true,
    why: 'and one that does moves it to a bound parameter',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET trainer_id = $2::uuid
    WHERE id = $1::uuid${BT}, [anything, anything]);` },
  { name: 'g2-dollar-body-update', verdict: 'accept', factory: true,
    why: 'the planted drift trigger: a body that takes no bind parameters, so it reads its facts '
      + 'from session settings and stays a fixed literal',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz_c_pdrift() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER AS $zz$
    BEGIN
      UPDATE public.availability_slots
         SET price_per_session = current_setting('abc27.drift_price')::numeric
       WHERE id = current_setting('abc27.drift_slot')::uuid;
      RETURN NEW;
    END $zz$${BT});` },
  { name: 'g2-interpolated-statement', verdict: 'refuse', factory: true,
    why: 'a hole in a factory statement is a value that can change what the statement IS, which '
      + 'is the one guarantee the factory exists to make',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET max_participants = \${anything}
    WHERE id = $1::uuid${BT}, [anything]);` },
  { name: 'g2-concatenated-statement', verdict: 'refuse', factory: true,
    why: 'and composition is interpolation with an extra step',
    body: `  await c.query('UPDATE public.availability_slots SET is_public = false WHERE id = '
    + anything);` },
  { name: 'g2-sql-side-trainer', verdict: 'refuse', factory: true,
    why: 'THE SITE THAT DEFEATED THE REGEX GUARD, inside the factory this time: an unordered '
      + 'server pick names no trainer at all, so a deny-list had nothing to match',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.id, $1 FROM public.trainer_profiles t LIMIT 1${BT}, [ACADEMY]);` },
  { name: 'g2-literal-trainer', verdict: 'refuse', factory: true,
    why: 'a trainer written into the statement is a namespace the registry never issued',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    VALUES ('55555555-5555-4555-8555-555555555555', $1)${BT}, [ACADEMY]);` },
  { name: 'g2-sql-minted-trainer', verdict: 'refuse', factory: true,
    why: 'the retired lpad mint: a trainer computed inside the statement, which no type reaches',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT ('9e0f9e0f-0000-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid, $1
      FROM generate_series(1, 5) AS g(i)${BT}, [ACADEMY]);` },
  { name: 'g2-unnest-ordinality-column', verdict: 'refuse', factory: true,
    why: 'the SECOND alias column is the ordinality, not the unnested value - binding a trainer '
      + 'to it would silently write the row number',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.i, $2 FROM pg_catalog.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT},
    [anything, ACADEMY]);` },
  { name: 'g2-unnest-not-a-parameter', verdict: 'refuse', factory: true,
    why: 'an unnest over an array written IN the statement is a SQL-side source like any other',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.id, $1 FROM pg_catalog.unnest(ARRAY['55555555-5555-4555-8555-555555555555'::uuid])
      WITH ORDINALITY AS t(id, i)${BT}, [ACADEMY]);` },
  { name: 'g2-cte-unnest-alias-does-not-authorize-the-outer-write', verdict: 'refuse', factory: true,
    why: 'A ROUND-6 ESCAPE, and the region scoping defeated from the other side. The write\'s '
      + 'CLAUSES were read from its own region, but the ALIAS one of them resolved through was '
      + 'sought across the whole statement — so an unrelated CTE declaring `unnest($1) AS t(id)` '
      + 'made an outer `SELECT t.id FROM public.trainer_profiles AS t` read as parameter-bound '
      + 'while the trainer really came from the table',
    body: `  await c.query(${BT}WITH unused AS (SELECT id FROM pg_catalog.unnest($1::uuid[]) AS t(id))
    INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.id, $2 FROM public.trainer_profiles AS t LIMIT 1${BT}, [anything, ACADEMY]);` },
  { name: 'g2-merge-in-factory', verdict: 'refuse', factory: true,
    why: 'MERGE stays refused even here: no site uses it, and admitting it admits an unread rule',
    body: `  await c.query(${BT}MERGE INTO public.availability_slots t USING (SELECT 1) s ON false
    WHEN NOT MATCHED THEN INSERT (trainer_id) VALUES ($1)${BT}, [anything]);` },
  { name: 'g2-parenthesised-compound-source', verdict: 'refuse', factory: true,
    why: 'A ROUND-4 ESCAPE: parenthesising the whole source puts both arms at depth one, out of '
      + 'reach of a depth-zero scan, while remaining valid PostgreSQL',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    (SELECT $1, $2 UNION ALL TABLE src)${BT}, [anything, ACADEMY]);` },
  { name: 'g2-on-conflict-do-update-trainer', verdict: 'refuse', factory: true,
    why: 'the conflict clause is a SECOND write inside one statement, and its assignment was '
      + 'never audited while the INSERT\'s own binding was a well-behaved parameter',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id, trainer_id)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE
      SET trainer_id = '55555555-5555-4555-8555-555555555555'::uuid${BT}, [anything, anything]);` },
  { name: 'g2-cte-hides-the-outer-conflict', verdict: 'refuse', factory: true,
    why: 'A ROUND-5 ESCAPE. A data-modifying CTE puts its own `ON CONFLICT … DO NOTHING` FIRST, so '
      + 'a reader that took "the first ON CONFLICT anywhere" found that one, returned no binding, '
      + 'and never reached the outer clause where a fixed foreign trainer was assigned',
    body: `  await c.query(${BT}WITH x AS (
      INSERT INTO public.other_table(id) VALUES ($3) ON CONFLICT (id) DO NOTHING RETURNING id
    )
    INSERT INTO public.availability_slots(id, trainer_id)
    SELECT $1, $2
    ON CONFLICT (id) DO UPDATE SET trainer_id = '55555555-5555-4555-8555-555555555555'::uuid${BT},
    [anything, anything, anything]);` },
  { name: 'g2-nested-cte-conflict-inside-the-source', verdict: 'refuse', factory: true,
    why: 'THE SHAPE THE DEPTH TEST IS FOR. Bounding the scan to the write\'s own region is enough '
      + 'when the CTE sits BEFORE the write; it is not when a CTE sits INSIDE the write\'s source, '
      + 'where its `DO NOTHING` is inside the region and comes first. Only "at the write\'s own '
      + 'paren depth" tells the two clauses apart.',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id, trainer_id)
    SELECT z.id, $2 FROM (
      WITH y AS (
        INSERT INTO public.other_table(id) VALUES ($3) ON CONFLICT (id) DO NOTHING RETURNING id
      )
      SELECT id FROM y
    ) z
    ON CONFLICT (id) DO UPDATE SET trainer_id = '55555555-5555-4555-8555-555555555555'::uuid${BT},
    [anything, anything, anything]);` },
  { name: 'g2-cte-conflict-does-not-mask-a-clean-outer', verdict: 'accept', factory: true,
    why: '...and the same CTE beside a well-bound outer clause is FINE, so the rule above is about '
      + 'reading the right clause rather than about refusing statements that contain two',
    body: `  await c.query(${BT}WITH x AS (
      INSERT INTO public.other_table(id) VALUES ($3) ON CONFLICT (id) DO NOTHING RETURNING id
    )
    INSERT INTO public.availability_slots(id, trainer_id)
    SELECT $1, $2
    ON CONFLICT (id) DO UPDATE SET trainer_id = $2${BT}, [anything, anything, anything]);` },
  { name: 'g1-slot-write-inside-a-cte', verdict: 'refuse',
    why: 'a slot write nested in a data-modifying CTE is a slot write, and is detected at whatever '
      + 'depth it stands',
    body: `  await c.query(${BT}WITH s AS (
      INSERT INTO public.availability_slots(trainer_id) VALUES ($1) RETURNING id
    )
    SELECT count(*) FROM s${BT}, [anything]);` },
  { name: 'g2-cte-slot-write-audited-on-its-own-clauses', verdict: 'refuse', factory: true,
    why: 'and when the CTE is the one writing the guarded relation, ITS conflict clause is the one '
      + 'read — the outer statement\'s clause must not stand in for it',
    body: `  await c.query(${BT}WITH s AS (
      INSERT INTO public.availability_slots(id, trainer_id) VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET trainer_id = '55555555-5555-4555-8555-555555555555'::uuid
      RETURNING id
    )
    INSERT INTO public.other_table(id) SELECT id FROM s ON CONFLICT (id) DO NOTHING${BT},
    [anything, anything]);` },
  { name: 'g2-on-conflict-unreadable-action', verdict: 'refuse', factory: true,
    why: 'an ON CONFLICT whose action this cannot read is refused rather than assumed harmless — '
      + 'the action is what decides whether the trainer moves',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id, trainer_id)
    VALUES ($1, $2) ON CONFLICT (id)${BT}, [anything, anything]);` },
  { name: 'g2-on-conflict-do-update-param', verdict: 'accept', factory: true,
    why: '...and a conflict clause that moves the trainer to a bound PARAMETER is fine, so the '
      + 'rule above is about the binding rather than about the clause existing',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id, trainer_id)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET trainer_id = $2${BT}, [anything, anything]);` },
  { name: 'g2-subquery-before-trainer-in-set', verdict: 'refuse', factory: true,
    why: 'a subquery in an EARLIER assignment carries a `FROM`, and a terminator sought at any '
      + 'depth stopped the scan there — before it ever reached the trainer assignment',
    body: `  await c.query(${BT}UPDATE public.availability_slots
    SET extra_costs = (SELECT '[]'::jsonb FROM pg_catalog.pg_class LIMIT 1),
        trainer_id = '55555555-5555-4555-8555-555555555555'::uuid
    WHERE id = $1::uuid${BT}, [anything]);` },
  { name: 'g2-compound-source', verdict: 'refuse', factory: true,
    why: 'A COMPOUND SOURCE IS REFUSED, NOT HALF-READ. A round-3 review recorded a binding for the '
      + 'readable arm, which made "did I find any binding" answer yes while the other arm went '
      + 'unread — so more than one arm is now a refusal in itself',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT $1, $2 UNION ALL TABLE src${BT}, [anything, ACADEMY]);` },
  { name: 'g2-table-source', verdict: 'refuse', factory: true,
    why: 'and a lone `TABLE src` source names the column while giving this nothing to classify',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    TABLE src${BT});` },
  { name: 'g2-tuple-set-target', verdict: 'refuse', factory: true,
    why: '`SET (trainer_id, location_id) = (…)` is valid PostgreSQL whose target is not one plain '
      + 'column, so it used to be skipped rather than read',
    body: `  await c.query(${BT}UPDATE public.availability_slots
    SET (trainer_id, location_id) = ('55555555-5555-4555-8555-555555555555'::uuid, $2::uuid)
    WHERE id = $1::uuid${BT}, [anything, anything]);` },
  { name: 'g1-merge-without-into', verdict: 'refuse',
    why: '`INTO` is OPTIONAL after MERGE, and reading it as required skipped a real slot write',
    body: `  await c.query(${BT}MERGE public.availability_slots AS t USING (SELECT 1) s ON false
    WHEN NOT MATCHED THEN INSERT (trainer_id) VALUES ($1)${BT}, [anything]);` },
  // ── G2 THROUGH THE CANONICAL PARSER: the shapes only a grammar decides ──────────────────────
  { name: 'g2-multi-assign-set-with-parameters', verdict: 'accept', factory: true,
    why: 'THE DECODED TWIN OF `g2-tuple-set-target`, and the round-6 lesson applied: the '
      + 'multi-column `SET (a, b) = (x, y)` used to be REFUSED OUTRIGHT because reading it '
      + 'positionally "would be one more grammar to get wrong". The grammar reports the assigned '
      + "column's own position in the row, so the form is now DECODED — bound to parameters it is "
      + 'accepted, and `g2-tuple-set-target` still refuses the one that writes a literal',
    body: `  await c.query(${BT}UPDATE public.availability_slots
    SET (trainer_id, location_id) = ($2::uuid, $3::uuid)
    WHERE id = $1::uuid${BT}, [anything, anything, anything]);` },
  { name: 'g2-two-statements-in-one-literal', verdict: 'refuse', factory: true,
    why: 'ONE CONSTANT IS ONE STATEMENT. Two in a literal means a second the runtime '
      + 'byte-equality control has no constant to compare against, and two halves audited apart',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET max_participants = $2::int
    WHERE id = $1::uuid; UPDATE public.availability_slots SET is_public = false
    WHERE id = $1::uuid${BT}, [anything, 4]);` },
  { name: 'g2-trigger-planted-on-the-guarded-relation', verdict: 'refuse', factory: true,
    why: 'A TRIGGER ON THE GUARDED RELATION IS A WRITE WITH ANOTHER NAME: whatever its function '
      + 'does runs on every row written there, and the definition says nothing about that. It '
      + 'writes nothing itself, so this rule is asked BEFORE the "is there a write here" gate — '
      + "after it, the rule would never run. The factory's own planted trigger is on "
      + '`public.rebook_rounds`, which is what makes this a rule rather than an exemption',
    body: `  await c.query(${BT}CREATE TRIGGER zz_t AFTER INSERT ON public.availability_slots
    FOR EACH ROW EXECUTE FUNCTION public.zz_f()${BT});` },
  { name: 'g2-factory-statement-the-parser-refuses', verdict: 'refuse', factory: true,
    why: 'A STATEMENT THE CANONICAL GRAMMAR CANNOT READ IS NOT AUDITED AT ALL, so it is refused '
      + 'rather than passed: `ON CONFLICT (id)` with no action is not valid PostgreSQL, and the '
      + 'action is what decides whether the trainer moves',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id, trainer_id)
    VALUES ($1, $2) ON CONFLICT (id)${BT}, [anything, anything]);` },
  { name: 'g2-projection-arity-mismatch', verdict: 'refuse', factory: true,
    why: 'THE MAPPING IS THE ARITY, and this is the shape ONLY that rule catches: three projected '
      + 'values for two columns puts a well-behaved `$1` at the trainer position while the '
      + 'statement PostgreSQL would accept is a different one. A factory statement whose columns '
      + 'and values cannot be matched one for one is refused rather than read at an index that '
      + 'means nothing',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT $1, $2, $3${BT}, [anything, ACADEMY, anything]);` },
  { name: 'g2-values-row-arity-mismatch', verdict: 'refuse', factory: true,
    why: '...and the same rule over a VALUES row, which is a separate arm of the audit and would '
      + 'otherwise have no fixture of its own',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    VALUES ($1, $2, $3)${BT}, [anything, ACADEMY, anything]);` },
  { name: 'g2-unparseable-literal-naming-the-relation', verdict: 'refuse', factory: true,
    why: 'THE GAP BETWEEN THE TWO DETECTORS. This text LEXES cleanly and carries no write verb, so '
      + 'the token reader reports nothing — and the canonical grammar cannot read it at all. '
      + '"The lexer saw no write" is a claim about the lexer, not about the statement, so a '
      + 'factory literal naming the guarded relation that the oracle cannot parse is refused',
    body: `  await c.query(${BT}SELECT id FROM public.availability_slots GROUP BY (${BT}, []);` },
  { name: 'g2-readable-select-in-the-factory', verdict: 'accept', factory: true,
    why: 'THE CONTROL FOR THAT RULE: a factory literal that names the relation, parses, and only '
      + 'READS is accepted — so what refuses above is unreadability, not naming the relation',
    body: `  await c.query(${BT}SELECT id FROM public.availability_slots WHERE id = $1${BT},
    [anything]);` },
  { name: 'g2-unqualified-relation-with-a-literal-trainer', verdict: 'refuse', factory: true,
    why: 'AN ABSENT SCHEMA IS NOT SOME OTHER SCHEMA. `INSERT INTO availability_slots` resolves '
      + 'through `search_path`, which no reader here can see, so it MAY be the guarded relation — '
      + 'and assuming otherwise is the assumption a gate must not make about itself. Audited like '
      + 'the qualified spelling, its literal trainer is refused',
    body: `  await c.query(${BT}INSERT INTO availability_slots(trainer_id, academy_profile_id)
    VALUES ('55555555-5555-4555-8555-555555555555'::uuid, $1)${BT}, [ACADEMY]);` },
  { name: 'g2-select-star-source', verdict: 'refuse', factory: true,
    why: 'A `SELECT *` SOURCE IS REFUSED BY THE VALUE RULE, not only by the arity one: the item at '
      + 'the trainer position is the star itself, which is no bound parameter — so the refusal '
      + 'survives even where the column count happens to line up',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT * FROM public.trainer_profiles${BT});` },
  { name: 'g2-sql-language-body-writes-the-relation', verdict: 'refuse', factory: true,
    why: 'A `LANGUAGE sql` BODY IS PLAIN SQL AND IS READ, NOT REFUSED AND NOT SKIPPED. The '
      + 'PL/pgSQL descent SUCCEEDS on this text and returns no statements at all, so a reader that '
      + 'took "no statements" for "nothing in the body" certified a body it never opened. The '
      + 'body is parsed directly and its literal trainer refused',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz_sqlbody() RETURNS void LANGUAGE sql
    AS $zz$ INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
      VALUES ('55555555-5555-4555-8555-555555555555'::uuid, '11111111-1111-4111-8111-111111111111'::uuid) $zz$${BT});` },
  { name: 'g2-dynamic-execute-in-a-function-body', verdict: 'refuse', factory: true,
    why: 'A BODY THAT BUILDS SQL IS NOT A FIXED BODY. Every literal here is fixed and every text '
      + 'the body carries is `format(...)`, whose write-set is empty — so the token reader saw no '
      + 'write, the raw parse saw no write, and a real UPDATE of the guarded relation with a '
      + 'LITERAL trainer reached the server unaudited. The body\'s statement KINDS are read '
      + 'against an allow-list, so every dynamic form is refused without enumerating them',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz_dyn() RETURNS trigger
    LANGUAGE plpgsql AS $zz$
    BEGIN
      EXECUTE format('UPDATE public.availability_slots SET trainer_id = %L WHERE id = %L',
        '55555555-5555-4555-8555-555555555555', NEW.id);
      RETURN NEW;
    END $zz$${BT});` },
  { name: 'g2-unnest-lookalike-in-another-schema', verdict: 'refuse', factory: true,
    why: 'A QUALIFIED `unnest` IS A DIFFERENT ROUTINE. Reading only the LAST element of the '
      + 'function name accepted `FROM evil.unnest($1) WITH ORDINALITY AS t(id, i)` as the '
      + 'built-in, so an arbitrary set-returning function supplied the trainer while the audit '
      + 'called it parameter-bound',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.id, $2 FROM evil.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT},
    [anything, ACADEMY]);` },
  { name: 'g2-unnest-catalog-qualified', verdict: 'accept', factory: true,
    why: '...and the explicitly catalog-qualified spelling IS the built-in, so the rule above is '
      + 'about identity rather than a ban on qualifying the name',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    SELECT t.id, $2 FROM pg_catalog.unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT},
    [anything, ACADEMY]);` },
  { name: 'g2-function-body-the-oracle-cannot-read', verdict: 'refuse', factory: true,
    why: 'A DOLLAR-QUOTED BODY IS READ WITH THE SAME ORACLE, and one it cannot read is an '
      + 'unaudited one. The factory plants a trigger function whose UPDATE lives inside a body; a '
      + 'body the PL/pgSQL parser refuses could hold any statement at all',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz_broken() RETURNS trigger
    LANGUAGE plpgsql AS $zz$ BEGIN THIS IS NOT PLPGSQL END $zz$${BT});` },
  { name: 'g2-quoted-and-cased-relation-with-a-literal-trainer', verdict: 'refuse', factory: true,
    why: 'THE AUDIT FOLDS CASE AND QUOTING TOO, not only the detection: a statement that reaches '
      + 'the guarded relation through `"public"."availability_slots"` and an upper-case verb is '
      + 'audited exactly like the plain spelling, and its literal trainer is refused',
    body: `  await c.query(${BT}INSERT INTO "public"."availability_slots"(trainer_id, academy_profile_id)
    VALUES ('55555555-5555-4555-8555-555555555555'::uuid, $1)${BT}, [ACADEMY]);` },
  // ── G4: WRITING-ROUTINE SPELLING CONTAINMENT ───────────────────────────────────────────────
  //
  // The four round-5 P1s were one shape: a READER asked whether a JavaScript expression reached a
  // writing apply routine, and every answer was an enumeration. These fixtures are the same
  // inputs put to a question that is decidable instead — does this TOKEN spell the name.
  { name: 'g4-invocation-through-a-hole', verdict: 'refuse',
    why: 'THE ROUND-5 P1-2, REPRODUCED. A hole in an ordinary expression position can BE a call: '
      + 'the substituted atom lands as a `ColumnRef`, which the retired position test called '
      + 'inert, so `send(\'public.rebook_round_apply_command_as_actor()\')` was certified. The '
      + 'value has to SPELL the routine somewhere, and here it does — in a string token',
    body: `  const sqlExpr = 'public.rebook_round_apply_command_as_actor()';
  await c.query(${BT}SELECT \${sqlExpr}${BT}, []);` },
  { name: 'g4-stored-call-read-through-a-destructuring-default', verdict: 'refuse',
    why: 'THE ROUND-5 P1-3, REPRODUCED. JavaScript selects the destructuring DEFAULT, and the '
      + 'retired resolver treated an `undefined` arm as a decided non-text and never looked at '
      + 'the initializer. The default OBTAINS something under the routine\'s name, which is the '
      + '`read` category — the one G4 has no pin for, because the thing being read cannot exist '
      + 'outside the catalogue at all',
    body: `  const store: Record<string, string> = {};
  for (const [, sql = store.rebook_round_apply_command_as_actor] of [['x', undefined]]) {
    await c.query(sql, []);
  }` },
  { name: 'g4-pinned-bare-name-inside-a-template-value-hole', verdict: 'refuse',
    why: 'THE ROUND-2 CONTAINMENT GAP, REPRODUCED EXACTLY. This returned ZERO violations. The '
      + 'hole folds to a neutral atom so the composed text never spells the routine, and the '
      + 'string token inherited the PIN written for the bare name as a catalog-inventory element '
      + '— identity `823468e8c6b7f7a7`, which is genuinely in the pinned set. Two inert '
      + 'characters-in-a-list and a complete invocation shared one identity. The position is now '
      + 'part of the identity, so the inventory element keeps its pin and this does not get it',
    body: `  await c.query(${BT}SELECT * FROM public.\${'rebook_round_apply_command_as_actor'}()${BT}, []);` },
  { name: 'g4-pinned-bare-name-used-as-a-subscript', verdict: 'refuse',
    why: 'THE SAME INHERITED PIN, ONE STEP FURTHER ALONG. A subscript READS something stored '
      + 'under the routine\'s name, which is the `read` category G4 has no pin for — but written '
      + 'as a STRING it used to be categorised `string` and inherit the inventory element\'s pin '
      + 'just as the template hole did. The position is part of the identity for a subscript too',
    body: `  await c.query(CALL['rebook_round_apply_command_as_actor'], []);` },
  { name: 'g4-name-in-a-template-SEGMENT-not-a-plain-string', verdict: 'refuse',
    why: 'A QUOTED STRING, A BACKTICK WITH NO SUBSTITUTION AND A TEMPLATE SEGMENT USED TO SHARE '
      + 'ONE CATEGORY, so a pin written for one covered all three. `` `name${\'\'}` `` is a '
      + 'template HEAD whose text is the whole routine name, and it inherited the plain string\'s '
      + 'pin. The three kinds are separate categories now',
    body: `  const n = ${BT}rebook_round_apply_command_as_actor\${''}${BT};
  await c.query(${BT}SELECT public.\${n}()${BT}, []);` },
  { name: 'g4-regexp-that-spells-the-name-with-unicode-escapes', verdict: 'refuse',
    why: 'A REGEXP LITERAL IS HANDED OVER RAW. TypeScript cooks escapes in ordinary strings, so '
      + '`\\u005f` is already an underscore by the time the walk sees one — but a regexp keeps its '
      + 'source, so `\\u005f` stayed four characters and a named group could assemble the '
      + 'protected name out of escapes the walk never decoded',
    body: '  const routine = /rebook\\u005fround\\u005fapply\\u005fcommand\\u005fas\\u005factor/.source;\n'
      + `  await c.query(${BT}SELECT * FROM public.\${routine}()${BT}, []);` },
  { name: 'g4-an-out-of-range-entity-does-not-crash-the-guard', verdict: 'accept',
    why: 'A CODE POINT THAT IS NOT ONE USED TO STOP THE ANALYSIS. `String.fromCodePoint` raises '
      + '`RangeError` above U+10FFFF, so ordinary text containing `&#xFFFFFF;` or `&#9999999;` '
      + 'crashed the guard instead of being analysed - a valid file could take the whole check '
      + 'down. A lone SURROGATE is accepted by `fromCodePoint` and is still not a character. All '
      + 'three are left exactly as written, which can only under-decode and never mis-decode',
    body: `  const label = 'a&#xFFFFFF;b &#9999999; c&#xD800;d';
  await c.query(label, []);` },
  { name: 'g4-an-out-of-range-entity-still-does-not-hide-a-name', verdict: 'refuse',
    why: '...AND DECLINING TO DECODE IS NOT DECLINING TO LOOK. A text carrying both an undecodable '
      + 'escape and a real spelling of the routine is still refused, so the fail-soft above is '
      + 'about the ESCAPE and not about the search',
    body: `  const label = '&#xFFFFFF; rebook&#95;round&#95;apply&#95;command&#95;as&#95;actor';
  await c.query(label, []);` },
  { name: 'g4-name-spelled-with-hex-escapes', verdict: 'refuse',
    why: 'THE DECODER HAS THREE FORMS AND ONLY ONE HAD A CASE. `\\x5f` is an underscore in a '
      + 'regexp source exactly as `\\u005f` is, and a decoder that handled only the `\\u` form '
      + 'could lose the other without any case going red',
    body: '  const routine = /rebook\\x5fround\\x5fapply\\x5fcommand\\x5fas\\x5factor/.source;\n'
      + `  await c.query(${BT}SELECT * FROM public.\${routine}()${BT}, []);` },
  { name: 'g4-name-spelled-with-braced-unicode-escapes', verdict: 'refuse',
    why: '...and `\\u{5f}`, the braced form, is the third. Each is driven so none can be dropped '
      + 'behind another one\'s case',
    body: '  const routine = /rebook\\u{5f}round\\u{5f}apply\\u{5f}command\\u{5f}as\\u{5f}actor/u.source;\n'
      + `  await c.query(${BT}SELECT * FROM public.\${routine}()${BT}, []);` },
  { name: 'g4-a-middle-dot-suffix-is-a-different-routine', verdict: 'accept',
    why: 'U+00B7 MIDDLE DOT is `Other_ID_Continue`, so it CONTINUES an identifier and a name '
      + 'carrying one is an ordinary longer identifier. Three hand-assembled boundary classes in '
      + 'a row each missed something, and each miss REFUSED code that names nothing guarded. The '
      + 'class asks Unicode for `ID_Continue` now, and this is the value that proves it',
    body: `  const rebook_round_apply_normalized_core\u00b7suffix = 1;
  void rebook_round_apply_normalized_core\u00b7suffix;` },
  { name: 'g4-a-zero-width-joiner-suffix-is-a-different-routine', verdict: 'accept',
    why: 'THE BOUNDARY CLASS IS ECMASCRIPT\'S, NOT AN APPROXIMATION OF IT. A zero-width joiner '
      + 'and connector punctuation are `IdentifierPart`, so a name carrying one is an ORDINARY '
      + 'LONGER identifier naming something else. The class omitted them, so this was refused as '
      + 'the routine followed by a boundary - a refusal about code that names nothing guarded',
    body: `  const rebook_round_apply_command_as_actor\u200djoined = 1;
  void rebook_round_apply_command_as_actor\u200djoined;` },
  { name: 'g4-name-as-a-private-class-field', verdict: 'refuse',
    why: 'A PRIVATE IDENTIFIER IS AN IDENTIFIER THIS WALK DID NOT CLASSIFY. It was neither a '
      + 'string nor an `Identifier`, so `#rebook_round_apply_command_as_actor` fell through every '
      + 'arm. The `#` is not an identifier character, so the boundary test sees the name beside '
      + 'it exactly as it sees a bare one',
    body: `  class Holder { #rebook_round_apply_command_as_actor = 1; }
  void Holder;` },
  { name: 'g4-name-in-a-tagged-template', verdict: 'refuse',
    why: 'A TAGGED TEMPLATE hands its raw text to a function this cannot resolve. The token is a '
      + 'no-substitution template, which is now its own category and additionally records that it '
      + 'stands in a tag position',
    body: `  dispatch${BT}rebook_round_apply_command_as_actor${BT};` },
  { name: 'g4-stored-call-read-through-a-STRING-binding-element', verdict: 'refuse',
    why: 'THE `read` CATEGORY, SPELLED AS A STRING. `const { name: sql } = CALL` was already the '
      + '`read` category through the identifier arm; written as a quoted property name it reached '
      + 'the `string` arm instead and inherited an inventory pin. A binding element\'s literal '
      + 'property name is a read like any other',
    body: `  const { 'rebook_round_apply_command_as_actor': sql } = CALL;
  await c.query(sql, []);` },
  { name: 'g4-whitespace-around-a-pinned-name-is-a-different-text', verdict: 'refuse',
    why: 'THE IDENTITY USED TO BE A TIDIED TEXT. Runs of whitespace were collapsed and the ends '
      + 'trimmed before hashing, so `\' name \'.trim()` hashed identically to the bare inventory '
      + 'element and inherited its pin. Folding belongs to DISPLAY; identity is the exact text',
    body: `  const r = ' rebook_round_apply_command_as_actor '.trim();
  await c.query(${BT}SELECT * FROM public.\${r}()${BT}, []);` },
  { name: 'g4-routine-name-carried-by-a-regexp-literal', verdict: 'refuse',
    why: 'A REGEXP IS A TEXT CARRIER THE WALK WAS BLIND TO. `.source` turns the literal back into '
      + 'a string, so the name reached a hole without any token this walk visited ever spelling '
      + 'it. The literal is asked with its delimiters: `/` is not an identifier character, so the '
      + 'slashes can neither hide a name nor manufacture one',
    body: `  const routine = /rebook_round_apply_command_as_actor/.source;
  await c.query(${BT}SELECT * FROM public.\${routine}()${BT}, []);` },
  { name: 'g4-uppercase-spelling', verdict: 'refuse',
    why: 'SQL folds unquoted identifiers, so a spelling that differs only in case names the same '
      + 'routine. The match is case-insensitive, and this is the only fixture that says so',
    body: `  await c.query(${BT}SELECT * FROM PUBLIC.REBOOK_ROUND_APPLY_NORMALIZED_CORE()${BT}, []);` },
  { name: 'g4-composed-name-that-no-operand-spells', verdict: 'refuse',
    why: 'A NAME ASSEMBLED FROM FRAGMENTS is the residual G4 states rather than closes — but the '
      + 'compositions the retired scans were actually defeated by (`+` and `[…].join(…)`) are '
      + 'folded and reported, because over-reporting a detector is safe. No operand here spells '
      + 'the routine and the folded text does',
    body: `  await c.query('SELECT public.rebook_round_apply_' + 'command_as_actor()', []);` },
  { name: 'g4-composed-around-a-pinned-operand', verdict: 'refuse',
    why: 'A PIN DECIDES A TEXT, AND A COMPOSED TEXT IS A DIFFERENT TEXT. The bare wrapper name is '
      + 'a pinned, decided mention — it is a catalog-inventory element — so a composition BUILT '
      + 'around it had an operand that "already spelled it", and the report used to be skipped as '
      + 'a duplicate. The completed invocation went unreported. The composed identity now stands '
      + 'on its own',
    body: `  await c.query('SELECT public.' + 'rebook_round_apply_command_as_actor' + '()', []);` },
  { name: 'g4-composed-by-join', verdict: 'refuse',
    why: '...and the folding covers `[…].join(…)` as well as `+`, which is a separately '
      + 'implemented branch and had no fixture of its own',
    body: `  await c.query(['SELECT public.rebook_round_apply_normalized', 'core()'].join('_'), []);` },
  { name: 'g4-composed-by-concat', verdict: 'refuse',
    why: '...and `.concat()`, which is the third branch',
    body: `  await c.query('SELECT public.rebook_round_apply_'.concat('command_as_actor()'), []);` },
  { name: 'g4-uescape-with-a-custom-escape-character', verdict: 'refuse',
    why: 'A `U&"…" UESCAPE \'!\'` identifier decodes with the character the clause NAMES, not with '
      + 'a backslash — so a decoder that assumed the backslash read the routine name as an '
      + 'unrelated identifier. The SQL lexer already implements the clause, comments and all, so '
      + 'it is asked rather than re-enumerated, and every token value it decodes is a spelling',
    body: `  await c.query(${BT}SELECT * FROM public.U&"rebook!005Fround!005Fapply!005Fcommand!005Fas!005Factor"
    UESCAPE '!'()${BT}, []);` },
  { name: 'g4-uescape-in-a-plain-string-must-not-inherit-the-bare-name-pin', verdict: 'refuse',
    why: 'THE IDENTITY IS THE TOKEN AS WRITTEN, NOT WHAT IT DECODES TO, and this is the fixture '
      + 'that senses it. A plain STRING carrying a `U&"…" UESCAPE` spelling decodes to the bare '
      + 'wrapper name — which is pinned, in the SAME `string` category — so keying the identity '
      + 'on the decoded fragment would hand this statement the inventory element\'s decision. '
      + 'The earlier UESCAPE fixture can no longer sense that: it is a backtick template, so its '
      + 'category differs from the pin\'s and the collision cannot arise',
    body: `  const sql = "SELECT * FROM public.U&\\"rebook!005Fround!005Fapply!005Fcommand!005Fas!005Factor\\" UESCAPE '!'()";
  await c.query(sql, []);` },
  { name: 'g4-lifecycle-wrapper-is-a-different-routine', verdict: 'accept',
    why: 'THE NEAR-NAME CONTROL, and the reason the rule is a substring test with BOUNDARIES '
      + 'rather than a word list. `rebook_round_apply_lifecycle_command_as_actor` is a shipped '
      + 'wrapper this suite calls freely; it contains neither writing name '
      + '(`apply_lifecycle_command` is not `apply_command`), and it must never ride the refusal',
    body: `  await c.query(${BT}SELECT * FROM public.rebook_round_apply_lifecycle_command_as_actor($1)${BT},
    [ACADEMY]);` },
  { name: 'g4-a-longer-name-is-a-different-routine', verdict: 'accept',
    why: '...AND THE SAME DISCIPLINE FROM THE OTHER SIDE: a name that CONTAINS a writing routine '
      + 'name as a prefix is a different routine, so the boundary check leaves it alone. This is '
      + 'what keeps a future `…_as_actor_v2` from being refused as if it were the routine it is '
      + 'not — and it is the honest cost of the rule, stated as a fixture rather than discovered',
    body: `  await c.query(${BT}SELECT * FROM public.rebook_round_apply_command_as_actor_v2($1)${BT},
    [ACADEMY]);` },
  { name: 'g4-a-unicode-suffixed-name-is-a-different-routine', verdict: 'accept',
    why: 'THE BOUNDARY CLASS IS UNICODE, NOT ASCII. Spelled `[A-Za-z0-9_$]` it read '
      + '`…_normalized_coreé` as the guarded name followed by a non-identifier character, and '
      + 'refused three ordinary identifiers that name no routine of ours. PostgreSQL and '
      + 'JavaScript both admit those characters in an identifier, so the class is the Unicode one',
    body: `  await c.query(${BT}SELECT public.rebook_round_apply_normalized_coreé(),
    public.rebook_round_apply_normalized_coreλ(), public.rebook_round_apply_normalized_core中(),
    public.rebook_round_apply_normalized_core\u{10400}(),
    public.rebook_round_apply_normalized_core\u0301()${BT}, []);` },
  { name: 'g4-a-comment-is-not-a-token', verdict: 'accept',
    why: 'A JAVASCRIPT COMMENT CANNOT REACH A SERVER. The two routine names appear in dozens of '
      + 'comments across this suite explaining exactly this design, and refusing those would make '
      + 'the rule a ban on the words rather than on the spelling',
    body: `  // rebook_round_apply_command_as_actor and rebook_round_apply_normalized_core are
  // named here, in a comment, and reach nothing.
  await c.query(${BT}SELECT 1${BT}, []);` },
  { name: 'g4-a-pinned-mention-is-accepted', verdict: 'accept',
    why: 'THE PIN TABLE IS CONSULTED, and this is the fixture that says so. The bare wrapper name '
      + 'as a catalog-inventory element is a decided, non-invoking mention with its own rationale '
      + 'in the pinned inventory; delete that pin and this goes red beside the real tree',
    body: `  const inventory = ['rebook_round_apply_command_as_actor'];
  await c.query(${BT}SELECT $1::text${BT}, [inventory[0]]);` },
  { name: 'g2-second-values-row', verdict: 'refuse', factory: true,
    why: 'A MULTI-ROW VALUES IS READ WHOLE. The fragment escape closed one row and opened another '
      + 'of the right arity; the second row is now classified like the first',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id, academy_profile_id)
    VALUES ($1, $2), ('55555555-5555-4555-8555-555555555555', $2)${BT}, [anything, ACADEMY]);` },
];

export const EXEMPTION_FIXTURES = [
  { name: 'two-exemptions-on-one-line', exemptions: 2, violations: 0,
    why: 'A ROUND-5 ESCAPE. Each write is separately marked and individually exempt, and both '
      + 'collapsed into one `file:line` record — so the budget of ONE still held while TWO '
      + 'deliberate shared-namespace writes existed. The marker\'s own byte offset separates them.',
    // BOTH ON ONE PHYSICAL LINE, which is the whole shape: a `file:line` record cannot tell them
    // apart. A block comment carries the marker so the statement can stay on one line.
    body: `  await c.query(${BT}INSERT INTO public.availability_slots `
      + `/* SHARED_NAMESPACE_CONTROL */ (trainer_id) VALUES ($1)${BT}, [RAW]); `
      + `await c.query(${BT}INSERT INTO public.availability_slots `
      + `/* SHARED_NAMESPACE_CONTROL */ (trainer_id) VALUES ($1)${BT}, [RAW]);` },
  { name: 'two-exemptions-in-two-dollar-bodies-of-one-literal', exemptions: 2, violations: 0,
    why: 'A ROUND-6 ESCAPE, one hop further along. The recursion into a dollar-quoted body reused '
      + 'the OUTER literal\'s start while each marker position is body-local, so two bodies whose '
      + 'markers sit at the same offset inside themselves produced one record — the same collapse '
      + 'the round-5 fix closed for one nesting level only. The body token\'s own position '
      + 'composes into the site.',
    // IDENTICAL LEADING TEXT IN BOTH BODIES, which is what puts the two markers at the same
    // body-relative offset. Different dollar tags keep them two bodies.
    body: `  await c.query(${BT}CREATE FUNCTION f() RETURNS trigger AS $x$`
      + '/* SHARED_NAMESPACE_CONTROL */ UPDATE public.availability_slots SET price_per_session=1;'
      + ' $x$ LANGUAGE plpgsql; CREATE FUNCTION g() RETURNS trigger AS $y$'
      + '/* SHARED_NAMESPACE_CONTROL */ UPDATE public.availability_slots SET price_per_session=1;'
      + ` $y$ LANGUAGE plpgsql;${BT});` },
  { name: 'exemption-in-comment', exemptions: 1, violations: 0,
    body: `  await c.query(${BT}INSERT INTO public.availability_slots -- SHARED_NAMESPACE_CONTROL
    (trainer_id,academy_profile_id) VALUES ($1,$2)${BT}, [RAW, ACADEMY]);` },
  { name: 'exemption-in-string', exemptions: 0, violations: 1,
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    VALUES ('\${RAW}','SHARED_NAMESPACE_CONTROL')${BT});` },
];

/**
 * Run every fixture through ONE program and partition the verdicts by file.
 * The fixture directory lives inside the repository so `../src/test/…` resolves to the REAL
 * authority module rather than to a copy that could drift, and it is removed in a `finally`.
 */
export function analyzeFixtures(fixtures, { repoRoot = REPO_ROOT } = {}) {
  // NAME IS THE RESULT KEY AND THE TEMPORARY FILENAME. A collision is therefore data loss, not a
  // cosmetic duplicate: the later body overwrites the earlier file and its Map entry, so one
  // fixture can disappear while the caller still reports the input array's length. The combined
  // verdict + exemption corpus is checked here, at the one function every runner must cross,
  // before a directory or file is touched.
  const checkedFixtureNames = new Set();
  const duplicateFixtureNames = new Set();
  for (const fixture of fixtures) {
    if (checkedFixtureNames.has(fixture.name)) duplicateFixtureNames.add(fixture.name);
    checkedFixtureNames.add(fixture.name);
  }
  if (duplicateFixtureNames.size > 0) {
    throw new Error('ABC-27 fixture names must be unique across the combined corpus; repeated: '
      + [...duplicateFixtureNames].sort().join(', '));
  }
  const dir = path.join(repoRoot, `.tmp-abc27-slot-surface-selftest-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    // THE REAL FACTORY IS STILL THE FACTORY inside a fixture run. It is in the program so its
    // brand and statements are read like any other file, and leaving it out of this set made the
    // guard refuse its nineteen legitimate statements as bypasses.
    const factoryFiles = new Set([path.join(repoRoot, FACTORY_REL)]);
    const files = fixtures.map((f) => {
      const file = path.join(dir, `${f.name}.ts`);
      fs.writeFileSync(file, `${FIXTURE_PRELUDE}\n${f.body}\n}\n${f.tail ? `${f.tail}\n` : ''}`);
      // FACTORY-NESS IS INJECTED, NOT INFERRED FROM A NAME. A rule that read "this file looks
      // like the factory" would be a hatch in the production path; passing the set explicitly
      // means the real scan has exactly one factory and no way to acquire a second.
      if (f.factory) factoryFiles.add(path.resolve(file));
      return file;
    });
    const whole = analyze({
      files: [path.join(repoRoot, AUTHORITY_REL), path.join(repoRoot, FACTORY_REL), ...files],
      repoRoot,
      factoryFiles,
    });
    const byName = new Map();
    for (const f of fixtures) {
      byName.set(f.name, { violations: [], writeSites: 0, exemptions: [] });
    }
    const nameOf = (rel) => path.basename(rel).replace(/\.ts$/, '');
    for (const v of whole.violations) {
      const entry = byName.get(nameOf(v.file));
      if (entry) { entry.violations.push(v); continue; }
      // A refusal against a file that is not a fixture is a refusal against the real modules the
      // fixture program pulls in. Accumulated rather than overwritten, so the assertion that
      // there are none can name all of them.
      if (!byName.has('<in-scope-module>')) {
        byName.set('<in-scope-module>', { violations: [], writeSites: 0, exemptions: [] });
      }
      byName.get('<in-scope-module>').violations.push(v);
    }
    for (const e of whole.exemptions) {
      const entry = byName.get(nameOf(e.file));
      if (entry) entry.exemptions.push(e);
    }
    for (const key of whole.writeSites) {
      const entry = byName.get(nameOf(key.split(':')[0]));
      if (entry) entry.writeSites += 1;
    }
    return { byName, checkedFixtureNames };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The lexer's boundary, asserted directly: it is a pure function, so it is stated not inferred. */
export const LEXER_CASES = () => {
  const out = [];
  // A case that THROWS where it should not is a failed assertion, not a crashed self-test.
  const add = (fn, msg) => {
    try { out.push({ ok: !!(typeof fn === 'function' ? fn() : fn), msg }); }
    catch (e) { out.push({ ok: false, msg: `${msg} (threw: ${e.message})` }); }
  };
  add(() => lexSql("SELECT '-- not a comment'").tokens.length === 2,
    'a line comment marker inside a string is not a comment');
  add(() => lexSql('/* a /* nested */ comment */ SELECT 1').tokens.length === 2,
    'block comments nest in PostgreSQL');
  add(() => lexSql('SELECT $tag$ INSERT INTO availability_slots $tag$')
    .tokens.filter((t) => t.kind === 'dollar').length === 1,
    'a dollar-quoted body is one token, typed so its SQL is analysed rather than swallowed');
  add(() => lexSql('SELECT $1, $22').tokens.filter((t) => t.kind === 'word').length === 3,
    'a positional parameter is one word token, not a dollar-quote');
  add(() => lexSql("SELECT E'a\\'b'").tokens.filter((t) => t.kind === 'string').length === 1,
    'a backslash-escaped quote does not end an E-string');
  add(() => lexSql("SELECT 'a''b'").tokens[1].value === "a'b", 'a doubled quote is one quote');
  add(() => decodeUnicodeEscapes('availability\\005Fslots') === 'availability_slots',
    'U& four-digit escapes decode');
  add(() => decodeUnicodeEscapes('a\\+000042c') === 'aBc', 'U& six-digit escapes decode');
  // ── A DOUBLED ESCAPE IS A LITERAL ONE, AND THE SCAN IS LEFT TO RIGHT ────────────────────────
  //
  // Three global replacements in sequence are NOT this function: the four-digit pass fired inside
  // `!!005F` and produced `a!_b`, an identifier the text never contained, while the doubled-escape
  // pass ran last and found nothing left. PostgreSQL reads `a!!005Fb UESCAPE '!'` as `a!005Fb`.
  add(() => decodeUnicodeEscapes('a!!005Fb', '!') === 'a!005Fb',
    'a DOUBLED escape is a literal escape, and the digits after it are ordinary characters');
  add(() => decodeUnicodeEscapes('a!!!005Fb', '!') === 'a!_b',
    '...and a doubled escape followed by a real one still decodes the real one');
  add(() => decodeUnicodeEscapes('a\\\\005Fb') === 'a\\005Fb',
    '...and the same holds for the DEFAULT escape, which is where it had gone unnoticed');
  add(() => decodeUnicodeEscapes('a\\00zz') === 'a\\00zz',
    'an escape this cannot read is kept as it stands rather than guessed past');
  add(() => lexSql('SELECT -- x\n1').comments.length === 1, 'a line comment is reported, not kept');
  add(() => lexSql('SELECT 1 -- m').comments[0].pos === 9,
    'a comment carries the position that attributes it to a statement');
  // THE TRIGGER-DEFINITION BOUNDARY, stated directly rather than only through a fixture: this is
  // what keeps the suite's planted triggers from each needing an exemption.
  add(() => countWritesToTable(lexSql(
    'CREATE TRIGGER z AFTER INSERT ON public.availability_slots FOR EACH ROW EXECUTE FUNCTION f()'
  ).tokens) === 0, 'AFTER INSERT ON is a trigger definition, not a write');
  add(() => countWritesToTable(lexSql(
    'INSERT INTO public.availability_slots(trainer_id) VALUES ($1)').tokens) === 1,
  'and INSERT INTO is');
  for (const [text, why] of [
    ["SELECT 'unterminated", 'an unterminated string throws rather than being guessed past'],
    ['/* unterminated', 'an unterminated block comment throws'],
    ['SELECT $q$ unterminated', 'an unterminated dollar-quote throws'],
    ["SELECT U&\"x\" UESCAPE 'ab'", 'a UESCAPE character that is not one character throws'],
    ['SELECT U&"x" UESCAPE', 'a UESCAPE with no escape character at all throws'],
  ]) {
    let threw = false;
    try { lexSql(text); } catch { threw = true; }
    add(threw, why);
  }
  return out;
};

/**
 * The shared oracle's own boundary, asserted directly rather than inferred from a verdict.
 *
 * THE WALK'S RUNAWAY GUARD IS THE INTERESTING ONE. It used to RETURN past its depth, which turns
 * "I did not look this far" into "there is nothing there" — and a hundred nested data-modifying
 * CTEs really do parse. The cap is far above anything the grammar produces for a text a human
 * wrote, and exceeding it throws, which every caller reports.
 */
export const ORACLE_CASES = () => {
  const out = [];
  const add = (fn, msg) => {
    try { out.push({ ok: !!(typeof fn === 'function' ? fn() : fn), msg }); }
    catch (e) { out.push({ ok: false, msg: `${msg} (threw: ${e.message})` }); }
  };
  // A hundred nested CTEs around a write: deep, legal, and the write must still be found.
  let deep = 'UPDATE public.availability_slots SET max_participants = 1 RETURNING *';
  for (let i = 0; i < 100; i += 1) deep = `WITH c${i} AS (${deep}) SELECT * FROM c${i}`;
  add(() => {
    const parsed = parseSql(deep);
    return parsed.ok && writeNodes(parsed.stmts)
      .filter((w) => namesRelation(w.node.relation, TABLE)).length === 1;
  }, 'a write a hundred CTEs deep is still found — the walk does not stop short of it');
  // ...and past the runaway guard, the walk THROWS rather than answering "nothing here".
  // ── THE CAP IS TESTED, NOT THE RUNTIME'S STACK ────────────────────────────────────────────
  //
  // These inputs sit just above the cap and far below any plausible native limit, and the
  // assertion demands `WalkTooDeep` SPECIFICALLY rather than "something incomplete". Accepting a
  // `RangeError` here would let the control pass on a machine whose stack gives out first — which
  // is exactly the state the cap was in when it was set to 20,000 and nothing noticed.
  add(() => {
    let node = { InsertStmt: {} };
    for (let i = 0; i < 1100; i += 1) node = { wrap: node };
    let threw = false;
    try { nodesOf(node, 'InsertStmt'); } catch (e) { threw = e instanceof WalkTooDeep; }
    return threw;
  }, 'a tree deeper than the CAP throws WalkTooDeep, so a caller cannot read it as an empty result');
  // ── AND A DYNAMIC STATEMENT INSIDE A NESTED BODY IS STILL REPORTED ────────────────────────
  //
  // The recursion propagates an inner body's `dynamic` findings, and nothing sensed that: the
  // nested-body control above asserts only that inner QUERIES come back, and the one-level
  // `EXECUTE` fixture never nests. Deleting the propagation left both green.
  add(() => {
    const nested = 'DO $outer$ BEGIN DO $inner$ BEGIN EXECUTE '
      + "format('SELECT public.%I()', 'zz_inner'); END $inner$; END $outer$";
    const d = plpgsqlExpressions(nested);
    return d.ok && d.dynamic.length > 0;
  }, 'a DYNAMIC statement two bodies deep is reported, not only the queries around it');
  // A body inside a body is still a body.
  add(() => {
    const nested = 'DO $outer$ BEGIN DO $inner$ BEGIN PERFORM public.zz_inner(); END $inner$; '
      + 'END $outer$';
    const d = plpgsqlExpressions(nested);
    return d.ok && d.queries.some((q) => q.query.includes('zz_inner'));
  }, 'a function body nested inside a function body is descended too');
  return out;
};

/**
 * R5's own controls. A pin nothing exercises is a pin nobody knows is connected — and this one is
 * DORMANT by design: the three runtime modules import what they always imported, so disarming the
 * rule changes nothing any other sensor can see. It is driven here in both directions instead,
 * including against the REAL modules, so the acceptance half is a claim about the tree rather
 * than about a fixture.
 */
/**
 * THE OCCURRENCE-COUNT TRIPWIRE, DRIVEN IN BOTH DIRECTIONS.
 *
 * This is the rule that stops a NEW occurrence of an already-justified name from being accepted
 * because somebody once justified a DIFFERENT occurrence of the same text. It compares totals
 * over the whole tree, so no per-file fixture reaches it; these cases drive the comparison
 * directly, and the real tree supplies the acceptance direction on every run.
 */
/**
 * THE POSITION FUNCTION, DRIVEN DIRECTLY.
 *
 * Its behaviour is not visible through the fixture corpus: every position it distinguishes is
 * currently UNPINNED, so a token refused because it stands in a template hole is refused just the
 * same when the position is dropped — only for a different reason. A review round showed the
 * consequence: reverting "every matching ancestor" to "the first match", and removing the
 * tagged-template marker, both left the whole corpus green. The function is asked here instead.
 */
export const POSITION_CASES = () => {
  const at = (src, pick) => {
    const sf = ts.createSourceFile('p.ts', src, ts.ScriptTarget.ES2020, true);
    let found = null;
    const walk = (n) => { if (!found && pick(n)) found = n; ts.forEachChild(n, walk); };
    ts.forEachChild(sf, walk);
    return found === null ? '<no such node>' : positioned(found, 'string');
  };
  const str = (n) => ts.isStringLiteral(n);
  return [
    { ok: at("const a = 'x';", str) === 'string',
      msg: 'THE CONTROL: an ordinary string carries no position, so the base category stands' },
    { ok: at('const a = `${\'x\'}`;', str) === 'string-in-template-hole',
      msg: 'a string inside a template substitution is a template hole' },
    { ok: at("const a = CALL['x'];", str) === 'string-in-subscript',
      msg: '...and one used as a subscript is a read position' },
    { ok: at('const a = `${CALL[\'x\']}`;', str) === 'string-in-subscript-in-template-hole',
      msg: '...and one that is BOTH records both, sorted - returning at the first matching '
        + 'ancestor recorded only the inner one, so the identity did not encode what it claimed' },
    { ok: at('const a = tag`x`;', (n) => ts.isNoSubstitutionTemplateLiteral(n))
        === 'string-in-tagged-template',
      msg: '...and a tagged template is its own position, because the tag receives the raw text' },
  ];
};

export const MENTION_COUNT_CASES = () => {
  const pinned = new Map([['aaaa', 2], ['bbbb', 1]]);
  const at = (seen) => miscountedMentions(new Map(seen), pinned);
  return [
    { ok: at([['aaaa', 2], ['bbbb', 1]]).length === 0,
      msg: 'THE CONTROL: the justified totals are accepted, so every refusal below is a rule' },
    { ok: at([['aaaa', 3], ['bbbb', 1]]).length === 1
        && at([['aaaa', 3], ['bbbb', 1]])[0].got === 3,
      msg: 'a SECOND occurrence of an already-justified text is refused - this is the shape that '
        + 'reached a server: a name that is inert as an inventory element, spelled again '
        + 'somewhere that is not inert, inheriting the first one\'s decision' },
    { ok: at([['aaaa', 1], ['bbbb', 1]]).length === 1,
      msg: '...and a DISAPPEARED occurrence is refused too, so the pin is an equality and not a '
        + 'ceiling - a mention that stops being produced is a rule that stopped being exercised' },
    { ok: at([['bbbb', 1]]).length === 1 && at([['bbbb', 1]])[0].got === 0,
      msg: '...and a pin nothing produces at all reports zero rather than being skipped' },
    { ok: at([['aaaa', 2], ['bbbb', 1], ['cccc', 9]]).length === 0,
      msg: '...while an identity that is not pinned is not this rule\'s business: an unpinned '
        + 'mention is refused by the mention rule itself, and reporting it here too would say '
        + 'the same thing twice' },
  ];
};

export const IMPORT_SURFACE_CASES = ({ repoRoot = REPO_ROOT } = {}) => {
  const out = [];
  // A SNIPPET IS NOT A MODULE, AND THE PIN IS NOW AN EQUALITY. Each fragment below is about the
  // UNEXPECTED direction, so it is completed with the module's pinned imports first — otherwise
  // every one of them would also report the dependencies a two-line fragment naturally lacks,
  // and the case would stop being about the thing it names. `bare` keeps the raw text for the
  // cases that are about the MISSING direction.
  const bare = (text, rel, surface = IMPORT_SURFACE) => {
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2020, true);
    const result = { violations: [], writeSites: new Set(), exemptions: [] };
    checkImportSurface(source, rel, result, surface);
    return result.violations;
  };
  const run = (text, rel, surface = IMPORT_SURFACE) => {
    const pinned = (surface[rel] ?? []).map((m, i) => `import * as _p${i} from '${m}';\n`).join('');
    return bare(pinned + text, rel, surface);
  };
  const real = (rel) => {
    const full = path.join(repoRoot, rel);
    return fs.existsSync(full) ? run(fs.readFileSync(full, 'utf8'), rel) : [{ detail: 'missing' }];
  };
  // ── THE MISSING DIRECTION, WHICH THIS RULE USED NOT TO HAVE AT ALL ─────────────────────────
  for (const rel of [AUTHORITY_REL, FACTORY_REL, CATALOGUE_REL]) {
    out.push({
      ok: bare('export const nothing = 1;\n', rel).length === 1,
      msg: `import surface: an EMPTY ${rel} is refused - the pin says what this module IS, and an `
        + 'allow-list alone called a module that imports nothing perfectly clean',
    });
  }
  out.push({
    ok: bare("import pg from 'pg';\nimport { createHash } from 'node:crypto';\n",
      CATALOGUE_REL).length === 1,
    msg: 'import surface: a catalogue that keeps `pg` and `node:crypto` but DROPS '
      + '`./abc27TrainerAuthority` is refused - that is the module the ownership check lives in, '
      + 'so losing it is the one omission that actually changes what runs',
  });
  out.push({ ok: real(AUTHORITY_REL).length === 0,
    msg: 'the REAL authority module imports only its pinned dependencies' });
  out.push({ ok: real(FACTORY_REL).length === 0,
    msg: '...and so does the REAL factory, so the acceptance half is about the tree' });
  out.push({
    ok: run("import { analyze } from '../../scripts/check-abc27-trainer-source-authority.mjs';\n",
      AUTHORITY_REL).length === 1,
    msg: 'an authority module that imports the CHECKER is refused - a reader may not be upstream '
      + 'of the registry that decides at run time',
  });
  out.push({ ok: real(CATALOGUE_REL).length === 0,
    msg: '...and so does the REAL apply catalogue, which is the third module the runtime asks' });
  out.push({
    ok: run("import { analyze } from '../../scripts/check-abc27-trainer-source-authority.mjs';\n",
      CATALOGUE_REL).length === 1,
    msg: '...and a CATALOGUE that imports the checker is refused: every writing apply invocation '
      + 'goes through it, so a reader\'s verdict must not be able to reach it either',
  });
  out.push({
    ok: run("export { helper } from './somewhere-else';\n", FACTORY_REL).length === 1,
    msg: '...and a re-export is an import: `export … from` obtains the module just as `import` does',
  });
  out.push({
    ok: run('const m = await import(anything);\n', FACTORY_REL).length === 1,
    msg: '...and a COMPUTED specifier is refused, because nothing here can show it is not the '
      + 'checker',
  });
  out.push({
    ok: run("const fs = require('node:fs');\n", AUTHORITY_REL).length === 1,
    msg: '...and `require` obtains a module too, in a file this repository writes as ESM',
  });
  out.push({
    ok: run("type C = import('./somewhere-else').Thing;\nexport type X = C;\n",
      FACTORY_REL).length === 1,
    msg: '...and the TYPE position `import(\'…\').T` is an import, which a rule that visited only '
      + 'declarations and calls never saw',
  });
  out.push({
    ok: run("const reader = process.getBuiltinModule('node:module')\n"
      + "  .createRequire(import.meta.url)('../../scripts/abc27ParseOracle.mjs');\n",
    FACTORY_REL).length >= 1,
    msg: '...and a Node LOADER obtained without any import spelling at all - '
      + '`process.getBuiltinModule(\'node:module\').createRequire(…)(…)` really does load the '
      + 'module, and reading only import syntax reported nothing',
  });
  // ── EVERY ACCESSOR NAME IS ITS OWN SENSOR, BECAUSE THE COMBINED CASE SENSED NEITHER ────────
  //
  // The case above spells `getBuiltinModule` AND `createRequire` and asks for `>= 1`. Deleting
  // either name from the set left it passing on the other, and three of the five names had no
  // case at all - so a review round was right that the enumeration was not sensed by anything.
  // Each name is now driven ALONE and counted EXACTLY, which is what makes deleting one red.
  for (const [accessor, body] of [
    ['createRequire', "const r = mod.createRequire(import.meta.url);\n"],
    ['getBuiltinModule', "const m = process.getBuiltinModule('node:module');\n"],
    ['register', "hooks.register('./loader.mjs', import.meta.url);\n"],
    ['syncBuiltinESMExports', "mod.syncBuiltinESMExports();\n"],
    ['_load', "const m = Mod._load('node:fs', null, false);\n"],
  ]) {
    out.push({
      ok: run(body, FACTORY_REL).length === 1,
      msg: `...and the loader accessor \`${accessor}\` is reported ON ITS OWN, so removing that `
        + 'one name from the enumeration cannot hide behind another name\'s case',
    });
  }
  out.push({
    ok: run("import type pg from 'pg';\nimport { expect } from 'vitest';\n"
      + "import { createHash } from 'node:crypto';\n", AUTHORITY_REL).length === 0,
    msg: 'THE CONTROL: the pinned dependencies themselves are accepted, so the rule is a surface '
      + 'and not a ban on importing',
  });
  out.push({
    ok: run("import { anything } from 'anywhere-at-all';\n", SUITE_REL).length === 0,
    msg: '...and a file OUTSIDE the pinned set is not governed by it - the claim is about the three '
      + 'modules the runtime asks, not about the suite',
  });
  return out;
};

/**
 * G1-e's own controls, driven over MUTATED COPIES OF THE REAL FACTORY — the same technique
 * `CATALOGUE_CASES` uses for G3, for the same reason: an export-surface rule is a claim about a
 * whole MODULE, which a one-function fixture cannot be.
 *
 * THE FIRST CASE IS THE CONTROL. If the real factory is ever refused here, every "refused"
 * verdict below means nothing.
 */
export const FACTORY_EXPORT_SURFACE_CASES = ({ repoRoot = REPO_ROOT } = {}) => {
  const out = [];
  const full = path.join(repoRoot, FACTORY_REL);
  if (!fs.existsSync(full)) return [{ ok: false, msg: `${FACTORY_REL} does not exist` }];
  const real = fs.readFileSync(full, 'utf8');
  const run = (text) => {
    const result = { violations: [], writeSites: new Set(), exemptions: [] };
    checkFactoryExportSurface(
      ts.createSourceFile(FACTORY_REL, text, ts.ScriptTarget.ES2020, true), FACTORY_REL, result);
    return result.violations;
  };
  out.push({ ok: run(real).length === 0,
    msg: 'THE CONTROL: the real factory is clean under G1-e, so every refusal below is a rule' });
  const mutate = (name, from, to, why) => {
    if (!real.includes(from)) {
      out.push({ ok: false, msg: `${name}: the anchor is stale — \`${from.slice(0, 60)}…\`` });
      return;
    }
    const text = real.replace(from, () => to);
    out.push({ ok: text !== real && run(text).length > 0, msg: `${name} — ${why}` });
  };
  // THE DIRECT RAW-STATEMENT BYPASS MUTANT. `SLOT_STATEMENTS` re-exported is exactly the leak
  // `SLOT_STATEMENT_DIGESTS` replaced it to close: a caller outside the factory could import the
  // raw texts and send one on a connection of its own, with no ownership check in between.
  mutate('G1-e: the raw SLOT_STATEMENTS map re-exported',
    'const SLOT_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({',
    'export const SLOT_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({',
    'the pinned surface publishes digests, never the raw statements — a digest cannot be '
    + 'invoked and a text can');
  // THE PIN IS AN EQUALITY, NOT A DENY-LIST OF SQL-SHAPED NAMES. An export of ANYTHING new is a
  // place where a reader is asked whether it needs the ownership check, whether or not what it
  // carries looks like SQL.
  mutate('G1-e: an extra export that is not a statement at all',
    'export const writingIdentity = (): string => currentIdentity();',
    'export const writingIdentity = (): string => currentIdentity();\n'
      + 'export const somethingElse = 1;',
    'the export surface is an equality: a new export of any kind moves it, not only one that '
    + 'carries recoverable SQL');
  // AND THE MISSING DIRECTION. Losing an entrypoint from the export list is exactly as red as
  // gaining one — the pin says what the module IS, not merely what it must not exceed.
  mutate('G1-e: a pinned entrypoint that stops being exported',
    'export const shiftSlotTimes = async (client: pg.Client, id: unknown,',
    'const shiftSlotTimes = async (client: pg.Client, id: unknown,',
    'a function that quietly stops being exported has quietly stopped being an entrypoint '
    + 'anything outside this file can reach — the equality catches that direction too');
  return out;
};

/**
 * G3's own controls, driven over MUTATED COPIES OF THE REAL CATALOGUE.
 *
 * WHY COPIES AND NOT FIXTURES. G2's rules run against any file the analysis is TOLD is the
 * factory, so a fixture can be one; G3's rules are about a whole MODULE — its export surface, its
 * seven entrypoints, its private renderers — which a one-function fixture cannot be. Splicing the
 * real source is the same technique the retired census battery used and it is strictly better
 * evidence: each case proves the rule notices a defect in the file the guard actually reads,
 * rather than in a synthetic module that could drift away from it.
 *
 * THE FIRST CASE IS THE CONTROL. If the real catalogue is ever refused here, every "refused"
 * verdict below means nothing.
 */
export const CATALOGUE_CASES = ({ repoRoot = REPO_ROOT } = {}) => {
  const out = [];
  const full = path.join(repoRoot, CATALOGUE_REL);
  if (!fs.existsSync(full)) return [{ ok: false, msg: `${CATALOGUE_REL} does not exist` }];
  const real = fs.readFileSync(full, 'utf8');
  const run = (text) => {
    const result = { violations: [], writeSites: new Set(), exemptions: [], mentions: new Map(), mentionCategories: new Map() };
    checkCatalogue(
      ts.createSourceFile(CATALOGUE_REL, text, ts.ScriptTarget.ES2020, true), CATALOGUE_REL, result);
    return result.violations;
  };
  out.push({ ok: run(real).length === 0,
    msg: 'THE CONTROL: the real catalogue is clean under G3, so every refusal below is a rule' });
  // A SPLICE THAT DOES NOT APPLY IS A CASE THAT PROVES NOTHING, so each one asserts that its
  // anchor was really found and really changed before asking whether the rule noticed.
  const mutate = (name, from, to, why) => {
    // A CASE MAY NEED SEVERAL COORDINATED SPLICES. Some rules can only be isolated by a mutation
    // that keeps every OTHER rule satisfied — the export-surface equality, say, stays exactly
    // right only if a name is freed at the same moment it is taken. `from` may therefore be a
    // list of `[from, to]` pairs applied in order, and `to` is then the rationale's `why`.
    const pairs = Array.isArray(from) ? from : [[from, to]];
    const rationale = Array.isArray(from) ? to : why;
    let text = real;
    for (const [f, t] of pairs) {
      if (!text.includes(f)) {
        out.push({ ok: false, msg: `${name}: the anchor is stale — \`${f.slice(0, 60)}…\`` });
        return;
      }
      text = text.replace(f, () => t);
    }
    out.push({ ok: text !== real && run(text).length > 0, msg: `${name} — ${rationale}` });
  };
  /**
   * A CASE THAT NAMES THE RULE IT DRIVES, because "some rule refused it" is not a sensor.
   *
   * `mutate` asks only that SOMETHING was reported, which is enough for a splice that could not
   * plausibly trip anything else. It is not enough for a rule that sits beside near-identical
   * ones: a review round showed that deleting the guard-callee comparison left all 28 cases
   * green, because every splice that reached it also broke a neighbour. This variant requires the
   * reported detail to be the one under test, so deleting that rule turns its case red instead of
   * letting a neighbour answer for it.
   */
  const isolates = (name, from, to, needle, why) => {
    if (!real.includes(from)) {
      out.push({ ok: false, msg: `${name}: the anchor is stale — \`${from.slice(0, 60)}…\`` });
      return;
    }
    const text = real.replace(from, () => to);
    const found = run(text);
    out.push({
      ok: text !== real && found.some((v) => String(v.detail).includes(needle)),
      msg: `${name} — ${why} (reported: ${found.map((v) => String(v.detail).slice(0, 70))
        .join(' | ') || '<nothing>'})`,
    });
  };
  // THE FAIL-CLOSED BRANCH ITSELF, reached through the routine-map seam. The completeness test
  // beside it proves today's map is whole, which is a different claim: it says the branch cannot
  // FIRE, not that it exists. Handing the audit a map with one row missing is the only way to
  // drive the branch without breaking every other rule at the same time.
  out.push((() => {
    const result = { violations: [], writeSites: new Set(), exemptions: [], mentions: new Map(),
      mentionCategories: new Map() };
    const partial = { ...CATALOGUE_ENTRYPOINT_ROUTINE };
    delete partial.applyCommandAsActorReachability;
    checkCatalogue(ts.createSourceFile(CATALOGUE_REL, real, ts.ScriptTarget.ES2020, true),
      CATALOGUE_REL, result, partial);
    return {
      ok: result.violations.some((v) => v.detail.includes('has no pinned routine')),
      msg: 'a statement whose entrypoint has NO pinned routine is refused - the comparison used '
        + 'to be skipped entirely when the mapping was absent, so deleting a row removed the rule '
        + `for that entrypoint silently (reported: ${result.violations.length} violation(s))`,
    };
  })());
  isolates('g3-a-statement-invokes-the-OTHER-writing-routine',
    'const APPLY_NORMALIZED_CORE = `SELECT * FROM public.rebook_round_apply_normalized_core(',
    'const APPLY_NORMALIZED_CORE = `SELECT * FROM public.rebook_round_apply_command_as_actor(',
    'entitled to',
    'THE TWO WRITING ROUTINES ARE NOT INTERCHANGEABLE. A statement can keep every structural '
      + 'property this audit checks - one plain `FROM` call, closed arguments, its own routine '
      + 'exactly once - and invoke the OTHER one. G3 recorded each statement\'s entrypoint and '
      + 'then never read it, so the swap was clean; the only refusal case was a swap to a routine '
      + 'outside the pair, which is a different rule');
  isolates('g3-guard-sequence-is-the-wrong-callee',
    "assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    "assertSlotsProbablyFine(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    'as its first two statements',
    'THE GUARD SEQUENCE IS AN IDENTITY, NOT A SHAPE. An entrypoint that opens with two ordinary '
      + 'calls satisfies every structural rule around this one, so only the comparison against '
      + 'the two guard NAMES can refuse it - and nothing used to drive that comparison alone');
  mutate('G3-c: an entrypoint whose ownership check is deleted',
    "  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');\n",
    '',
    'an entrypoint is exactly four statements, so removing the guard is a shape this refuses '
    + 'rather than a line nobody counted');
  mutate('G3-c: an entrypoint that queries BEFORE it guards',
    "  assertSlotsNotForeign(a.slots ?? [], "
      + "'the source slots handed to applyCommandAsActorReachability');\n"
      + '  noteSlotsOwned(a.targets ?? []);\n'
      + '  const result = await client.query(APPLY_AS_ACTOR_REACHABILITY,',
    '  const pending = client.query(APPLY_AS_ACTOR_REACHABILITY, []);\n'
      + "  assertSlotsNotForeign(a.slots ?? [], 'moved');\n"
      + '  const result = pending || await client.query(APPLY_AS_ACTOR_REACHABILITY,',
    'the guard sequence must OPEN the body, so a send hoisted above it is refused by shape');
  mutate('G3-c: the stored-result verification is skipped entirely',
    "  if (!wasRefused(result)) {\n"
      + '    await verifyStoredSlots(client, a.targets ?? [],\n'
      + "      'the target slots applyCommandAsActorReachability created');\n  }\n  return result;",
    '  return result;',
    'a slot-creating entrypoint is six statements now, and one skipped is a shape this refuses '
    + 'exactly as a skipped guard is');
  mutate('G3-c: the stored-result verification reads the wrong field',
    "    await verifyStoredSlots(client, a.targets ?? [],\n"
      + "      'the target slots applyCommandAsActorReachability created');",
    "    await verifyStoredSlots(client, a.slots ?? [],\n"
      + "      'the target slots applyCommandAsActorReachability created');",
    'the verification must read the sealed local\'s OWN `targets` - reading `slots` instead '
    + 'judges the wrong rows and is refused by shape, not merely by convention');
  mutate('G3-c: a combined-shape entrypoint\'s verification drops `targetArray`, checking only `targets`',
    "    await verifyStoredSlots(client, [...(s.targets ?? []), ...uuidsOf(s.targetArray)],\n"
      + "      'the target slots applyNormalizedCoreShaped created');",
    "    await verifyStoredSlots(client, s.targets ?? [],\n"
      + "      'the target slots applyNormalizedCoreShaped created');",
    'THE EXACT DRIFT A REVIEW FOUND: `noteSlotsOwned` claims both `targets` and `targetArray`\'s '
    + 'own ids for the three entrypoints with a second target-bearing field, but the stored-row '
    + 'verifier checking `targets` alone leaves a slot named only in `targetArray` claimed and '
    + 'never judged - refused by shape, not left to be reasoned about again');
  mutate('G3-c: a combined-shape entrypoint\'s CLAIM drops `targetArray`, narrower than its verify',
    '  noteSlotsOwned([...(s.targets ?? []), ...uuidsOf(s.targetArray)]);',
    '  noteSlotsOwned(s.targets ?? []);',
    'the claim and the verification must name the SAME set - a claim narrower than what the '
    + 'stored-row check goes on to read is not itself a containment gap, but it is a shape this '
    + 'audit no longer recognizes as agreeing with its own verify call, and is refused the same way');
  mutate('G3-c: the verification runs unconditionally, with no refusal guard at all',
    '  if (!wasRefused(result)) {\n    await verifyStoredSlots(client, a.targets ?? [],\n'
      + "      'the target slots applyCommandAsActorReachability created');\n  }",
    "  await verifyStoredSlots(client, a.targets ?? [],\n"
      + "    'the target slots applyCommandAsActorReachability created');",
    'the read-back is an ordinary SELECT, not the SECURITY DEFINER routine it follows, so it is '
    + 'subject to row-level security a malformed caller\'s own session can trip - running it '
    + 'unconditionally is exactly the new oracle this guard exists to refuse by shape');
  mutate('G3-c: the refusal check reads the wrong local',
    '  if (!wasRefused(result)) {',
    '  if (!wasRefused(a)) {',
    'the refusal check must read the SEND\'S OWN result, never the sealed argument record - a '
    + 'caller cannot supply a `status` field that skips its own verification');
  mutate('G3-c: the verification guard carries an `else` branch',
    "  if (!wasRefused(result)) {\n    await verifyStoredSlots(client, a.targets ?? [],\n"
      + "      'the target slots applyCommandAsActorReachability created');\n  }",
    "  if (!wasRefused(result)) {\n    await verifyStoredSlots(client, a.targets ?? [],\n"
      + "      'the target slots applyCommandAsActorReachability created');\n  } else { void 0; }",
    'a second branch is a second path this audit did not read - the one condition this may '
    + 'skip verification under has no alternative arm');
  mutate('G3-c: the return value is recomputed instead of the send\'s own result',
    '  return result;\n}\n\nexport async function applyCommandAsActorReceiptPrivacy',
    '  return undefined as never;\n}\n\nexport async function applyCommandAsActorReceiptPrivacy',
    'the value handed back must be the send\'s own result, read once - a return that recomputes '
    + 'or replaces it is refused, because that is exactly where a verified result could be '
    + 'swapped for an unverified one');
  mutate('G3-c: the send\'s own local collides with a module binding',
    '  const result = await client.query(APPLY_AS_ACTOR_REACHABILITY,',
    '  const APPLY_AS_ACTOR_REACHABILITY = await client.query(APPLY_AS_ACTOR_REACHABILITY,',
    'a local named after a module constant is a name this audit would resolve to the wrong '
    + 'binding, exactly the reasoning the seal\'s own local is already held to');
  mutate('G3-c: an entrypoint that never seals its argument record',
    '  const a = sealed(args);\n'
      + "  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    "  const a = args;\n"
      + "  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    'the ONE read of the caller\'s record is what makes the check and the send agree; without it '
    + 'an accessor answers them differently');
  mutate('G3-c: an entrypoint that reads its argument record AGAIN after sealing it',
    '    a.hFrom, a.hTo, a.hLabel, a.slots, a.children, a.targets,',
    '    a.hFrom, a.hTo, a.hLabel, args.slots, a.children, a.targets,',
    'THE ROUND-1 P1: the value that was checked and the value that is sent must be the same '
    + 'read. A second read of the parameter is the accessor shape, and it is refused '
    + 'syntactically rather than reasoned about');
  mutate('G3-c: the no-slot entrypoint CLAIMS something while guarding nothing',
    "  assertSlotsNotForeign([], 'the source slots handed to applyCommandAsActorRefusalProbe');\n"
      + '  noteSlotsOwned([]);',
    "  assertSlotsNotForeign([], 'the source slots handed to applyCommandAsActorRefusalProbe');\n"
      + '  noteSlotsOwned([a.academy]);',
    'the one no-slot entitlement covers BOTH halves of the sequence - an entrypoint that checks '
    + 'nothing may not claim something either');
  mutate('G3-c: a branch around the guard',
    "  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    "  if (a.slots) assertSlotsNotForeign(a.slots, 'branched');",
    'a guard on a branch is a guard that can be skipped, and a conditional is not the '
    + 'unconditional statement this demands');
  mutate('G3-c: a SECOND query in an entrypoint',
    '  const result = await client.query(APPLY_AS_ACTOR_REACHABILITY,\n'
      + '    [a.academy, a.command, a.round, a.slots, a.children, a.targets,',
    '  await client.query(APPLY_AS_ACTOR_REACHABILITY, []);\n'
      + '  const result = await client.query(APPLY_AS_ACTOR_REACHABILITY,\n'
      + '    [a.academy, a.command, a.round, a.slots, a.children, a.targets,',
    'a second send is a statement no rule above read');
  mutate('G3-c: the no-slot entitlement widened to a second entrypoint',
    '  assertSlotsNotForeign(a.slots ?? [],\n'
      + "    'the source slots handed to applyCommandAsActorReceiptPrivacy');",
    "  assertSlotsNotForeign([], 'widened');",
    'exactly one entrypoint may guard an empty slot list, and it is pinned by name');
  mutate('G3-c: an entrypoint that DECLARES the statement name as a parameter',
    'export async function applyNormalizedCore(\n  client: pg.Client, args: NormalizedCoreArgs,\n)',
    'export async function applyNormalizedCore(\n  client: pg.Client, args: NormalizedCoreArgs,\n'
      + '  APPLY_NORMALIZED_CORE: string = String(args.label),\n)',
    'the send is recorded by identifier TEXT and looked up among the module constants, so a '
    + 'parameter of that name would let the audit read one statement while the runtime sent '
    + 'another - two plain parameters and one local make that unconstructible');
  mutate('G3-a: a rendered statement that DECLARES a renderer name as a parameter',
    'const APPLY_NORMALIZED_CORE_SHAPED = (s: ShapedApplySpec): string =>',
    'const APPLY_NORMALIZED_CORE_SHAPED = (s: ShapedApplySpec,\n'
      + '  renderArray: (a: RenderedArray) => string = () => String(s.actor)): string =>',
    'the same shadowing question one level in: the checker substitutes the MODULE renderer for '
    + 'the hole while the runtime would call the parameter');
  mutate('G3-c: an entrypoint whose SEALED LOCAL is named after a module constant',
    '  const a = sealed(args);\n'
      + "  assertSlotsNotForeign(a.slots ?? [], 'the source slots handed to applyNormalizedCore');",
    '  const APPLY_NORMALIZED_CORE = sealed(args);\n'
      + "  assertSlotsNotForeign(APPLY_NORMALIZED_CORE.slots ?? [], 'shadowed');",
    'arity plus one local is NOT the property — the local may not be named after a module '
    + 'binding, or the send resolves to the record while this audit reads the statement');
  mutate('G3-c: an entrypoint with an OPTIONAL second parameter',
    'export async function applyCommandAsActorReachability(\n  client: pg.Client, args: ReachabilityArgs,\n)',
    'export async function applyCommandAsActorReachability(\n  client: pg.Client, args?: ReachabilityArgs,\n)',
    'a parameter that may be absent is a parameter whose value this audit cannot speak for, and '
    + 'arity alone does not see it');
  mutate('G3-a: a rendered arrow whose SOLE PARAMETER is named after a renderer',
    'const APPLY_AS_ACTOR_REFUSAL_PROBE = (a: RefusalProbeArgs): string =>',
    'const APPLY_AS_ACTOR_REFUSAL_PROBE = (uuidLiteral: RefusalProbeArgs): string =>',
    'the same shadowing question with the right arity: the checker substitutes the MODULE '
    + 'renderer for the hole while the runtime would call the parameter');
  mutate('G3-e: a STATEMENT exported under a pinned export NAME', [
    // Free the pinned name...
    ['export const APPLY_STATEMENT_DIGESTS: Readonly<Record<string, string>> = Object.freeze(',
      'const APPLY_DIGESTS_PRIVATE: Readonly<Record<string, string>> = Object.freeze('],
    // ...give it to a STATEMENT, exported...
    ['const APPLY_NORMALIZED_CORE = `SELECT', 'export const APPLY_STATEMENT_DIGESTS = `SELECT'],
    // ...and keep an entrypoint sending it, so it is a statement this audit reads.
    ['const result = await client.query(APPLY_NORMALIZED_CORE, [',
      'const result = await client.query(APPLY_STATEMENT_DIGESTS, ['],
  ],
  'the export-surface EQUALITY pins NAMES, not what they hold: the exported set is still exactly '
  + 'the pinned one while a raw text has left the module. Nothing else sees it — the initializer '
  + 'is a template literal, so the exported-value-references-a-statement rule finds no identifier '
  + '— which is why deleting this branch as "redundant" was wrong.');
  mutate('G3-d: a renderer EXPORTED under a pinned export name',
    "const uuidLiteral = (value: string): string => `'${scalar(value, 'uuid')}'`;",
    "export const uuidLiteral = (value: string): string => `'${scalar(value, 'uuid')}'`;\n"
      + 'const APPLY_ENTRYPOINTS_SHADOW = 1;\nvoid APPLY_ENTRYPOINTS_SHADOW;',
    'a renderer is private, and its privacy is a rule of its own rather than a consequence of '
    + 'the export list happening to be the length it is');
  mutate('G3-e: an exported value that CARRIES a statement constant',
    'export const APPLY_ENTRYPOINTS: readonly string[] = Object.freeze(\n  Object.keys(APPLY_CANONICAL_EXAMPLES));',
    'export const APPLY_ENTRYPOINTS: readonly string[] = Object.freeze(\n'
      + '  [APPLY_NORMALIZED_CORE, ...Object.keys(APPLY_CANONICAL_EXAMPLES)]);',
    'the raw texts stay inside the module even when the NAME on the export surface is a pinned '
    + 'one — a statement reached through a legitimate export is still a statement that left');
  mutate('G3-e: a raw statement constant exported',
    'const APPLY_NORMALIZED_CORE = `SELECT',
    'export const APPLY_NORMALIZED_CORE = `SELECT',
    'the export surface is pinned precisely so a TEXT cannot leave this module — a digest '
    + 'cannot be invoked and a statement can');
  mutate('G3-b: a constant whose routine is swapped for the lifecycle wrapper',
    'const APPLY_AS_ACTOR_REACHABILITY = `SELECT * FROM public.rebook_round_apply_command_as_actor(',
    'const APPLY_AS_ACTOR_REACHABILITY = '
      + '`SELECT * FROM public.rebook_round_apply_lifecycle_command_as_actor(',
    'the invoked routine is read from the parse tree and must be one of the two this catalogue '
    + 'exists to contain — the near-name is a different routine');
  mutate('G3-b: a constant that is not a SELECT at all',
    '`SELECT * FROM public.rebook_round_apply_command_as_actor(\n'
      + "      $1::uuid,$2::uuid,'abc27.wire.v1','create',",
    '`CALL public.rebook_round_apply_command_as_actor(\n'
      + "      $1::uuid,$2::uuid,'abc27.wire.v1','create',",
    'the ONE closed shape is `SELECT … FROM public.<routine>(…)` — a `CALL` reaches the same '
    + 'routine through a node every clause rule above would then skip');
  mutate('G3-e: an extra export that is not a statement at all',
    'const uuidsOf = (a: RenderedArray): string[] =>',
    'export const uuidsOf = (a: RenderedArray): string[] =>',
    'the export surface is an EQUALITY, not a deny-list of texts: a new export of any kind is a '
    + 'place where a reader is asked whether it needs the ownership check');
  mutate('G3-b: a constant that invokes its OWN routine twice',
    'const APPLY_AS_ACTOR_REACHABILITY = `SELECT * FROM public.rebook_round_apply_command_as_actor(',
    'const APPLY_AS_ACTOR_REACHABILITY = `SELECT public.rebook_round_apply_command_as_actor($1::uuid,$2::uuid)\n      FROM public.rebook_round_apply_command_as_actor(',
    'the "no other routine" rule SKIPPED every call matching the FROM routine, so a second '
    + 'invocation of the SAME writing routine was accepted - two applies under one ownership '
    + 'check, in a statement the record calls exactly one');
  mutate('G3-b: a constant that reaches a RELATION as well as its routine',
    "      $4::uuid[],$5::uuid[],$6::uuid[],pg_catalog.decode($7::text,'hex'))`;",
    "      $4::uuid[],$5::uuid[],$6::uuid[],pg_catalog.decode($7::text,'hex')), public.availability_slots`;",
    'a catalogue statement invokes the apply routine and reads no relation of its own');
  mutate('G3-a: a template hole that is not a renderer call',
    '           ${renderArray(s.holidayFrom)},',
    '           ${String(s.holidayFrom)},',
    'a hole is a DIRECT call of a named private renderer, one syntactic level — anything else '
    + 'would need resolution, which is the whole class of question this design removed');
  mutate('G3-a: a template hole that calls an UNLISTED function',
    '          ${byteaHexLiteral(s.fingerprintHex)})`;',
    '          ${uuidsOf(s.sources)}::bytea)`;',
    'a private helper is not a renderer: the list is closed, and it is closed by name');
  mutate('G3-d: a renderer that returns something other than a literal text',
    "const uuidLiteral = (value: string): string => `'${scalar(value, 'uuid')}'`;",
    'const uuidLiteral = (value: string): string => String(value);',
    'every return of a renderer is a template over validated locals, so a renderer that hands '
    + 'back an arbitrary value is refused structurally');
  mutate('G3-d: a renderer that calls the ownership guard',
    "const uuidLiteral = (value: string): string => `'${scalar(value, 'uuid')}'`;",
    'const uuidLiteral = (value: string): string => {\n'
      + '  noteSlotsOwned([value]);\n'
      + "  return `'${scalar(value, 'uuid')}'`;\n"
      + '};',
    'a renderer produces text and decides nothing — a renderer that claims a slot is a second '
    + 'decision in a place no entrypoint audit looks');
  mutate('G3: the catalogue obtains `query` outside an entrypoint',
    'const uuidsOf = (a: RenderedArray): string[] =>',
    'const leak = (c: pg.Client) => c.query;\nconst uuidsOf = (a: RenderedArray): string[] =>',
    'obtaining the send is what matters, not calling it — the same question the scope tripwire '
    + 'asks of a sibling file, asked here of the one module that may legitimately send');
  return out;
};

/**
 * The scope tripwire's own controls, over a throwaway tree: a sibling that writes the guarded
 * relation is refused, the SAME file inside the program is not, and a sibling that merely names
 * the relation without a write verb is left alone.
 */
export const SCOPE_DRIFT_CASES = ({ repoRoot = REPO_ROOT } = {}) => {
  const out = [];
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-abc27-scope-'));
  try {
    const testDir = path.join(dir, 'src', 'test');
    fs.mkdirSync(testDir, { recursive: true });
    const writer = path.join(testDir, 'abc27ScopeProbe.ts');
    const reader = path.join(testDir, 'abc27ScopeReader.ts');
    fs.writeFileSync(writer,
      'export const q = `INSERT INTO public.availability_slots(trainer_id) VALUES ($1)`;\n');
    fs.writeFileSync(reader,
      'export const q = `SELECT id FROM public.availability_slots WHERE id = $1`;\n');
    // THE COMPOSED SPELLING, which contains no contiguous table name at all.
    const splitWriter = path.join(testDir, 'abc27ScopeSplit.ts');
    fs.writeFileSync(splitWriter,
      "export const q = ['INSERT INTO public.avail',\n"
      + "  'ability_slots(trainer_id) VALUES ($1)'].join('');\n");
    // ...AND THE OTHER HALF OF THE SEAM: the VERB split rather than the relation, which a check
    // that squashed only for the name would still miss.
    const splitVerb = path.join(testDir, 'abc27ScopeVerb.ts');
    fs.writeFileSync(splitVerb,
      "export const q = ['IN',\n"
      + "  'SERT INTO public.availability_slots(trainer_id) VALUES ($1)'].join('');\n");
    // ...AND THE ONE NO SQUASH REACHES: the pieces in separate declarations. Only the structural
    // question — does this file SEND SQL — answers it.
    const declSplit = path.join(testDir, 'abc27ScopeDecl.ts');
    fs.writeFileSync(declSplit,
      "declare const client: { query: (t: string, v?: unknown[]) => Promise<unknown> };\n"
      + "const head = 'IN';\n"
      + "const tail = 'SERT INTO public.availability_slots(id, trainer_id) VALUES ($1, $2)';\n"
      + "export const go = () => client.query(`${head}${tail}`, []);\n");
    // A CONTROL FOR THE STRUCTURAL RULE ITSELF: a sibling that only MENTIONS the call in a
    // comment sends nothing, and must not be reported for that.
    const mentions = path.join(testDir, 'abc27ScopeComment.ts');
    fs.writeFileSync(mentions,
      "// a note about client.query( and nothing else\nexport const n = 1;\n");
    // ...AND THE SUBSCRIPT SPELLING OF THE SAME CALL, which a round-5 review used: reading only
    // member access missed `client['query'](…)` entirely.
    const bracketSend = path.join(testDir, 'abc27ScopeBracket.ts');
    fs.writeFileSync(bracketSend,
      "declare const client: Record<string, (t: string, v?: unknown[]) => Promise<unknown>>;\n"
      + "const head = 'IN';\n"
      + "const tail = 'SERT INTO public.availability_slots(id, trainer_id) VALUES ($1, $2)';\n"
      + "export const go = () => client['query'](`${head}${tail}`, []);\n");
    // ...AND THE SEND TAKEN ONE HOP AWAY FROM THE CALL, which a round-6 review used: the callee
    // of `client.query.bind(client)` is `bind`, and the callee of `send(…)` is a bare identifier,
    // so a rule that read only CALLEES saw neither. The verb is split across declarations, so no
    // text match reaches it either — this file is reported only because it OBTAINS `query`.
    const aliasSend = path.join(testDir, 'abc27ScopeAlias.ts');
    fs.writeFileSync(aliasSend,
      "declare const client: { query: (t: string, v?: unknown[]) => Promise<unknown> };\n"
      + "const head = 'IN';\n"
      + "const tail = 'SERT INTO public.availability_slots(id, trainer_id) VALUES ($1, $2)';\n"
      + 'const send = client.query.bind(client);\n'
      + 'export const go = () => send(`${head}${tail}`, []);\n');
    // ...AND THE DESTRUCTURED SPELLINGS, quoted and computed, which reading only an identifier
    // property name missed: `const { 'query': send } = client` is the same obtaining.
    const quotedDestructure = path.join(testDir, 'abc27ScopeQuoted.ts');
    fs.writeFileSync(quotedDestructure,
      "declare const client: { query: (t: string, v?: unknown[]) => Promise<unknown> };\n"
      + "const head = 'IN';\n"
      + "const tail = 'SERT INTO public.availability_slots(id, trainer_id) VALUES ($1, $2)';\n"
      + "const { 'query': send } = client;\n"
      + 'export const go = () => send(`${head}${tail}`, []);\n');
    const computedDestructure = path.join(testDir, 'abc27ScopeComputedBind.ts');
    fs.writeFileSync(computedDestructure,
      "declare const client: Record<string, (t: string, v?: unknown[]) => Promise<unknown>>;\n"
      + 'declare const member: string;\n'
      + 'const { [member]: send } = client;\n'
      + "export const go = () => send('SELECT 1', []);\n");
    // A CONTROL FOR THAT BROADENING: a sibling that DEFINES a `query` member and subscripts by
    // number obtains nothing and sends nothing, so reading member ACCESS rather than member calls
    // must leave it alone. Otherwise the rule would be a ban on the word.
    const shapeOnly = path.join(testDir, 'abc27ScopeShape.ts');
    fs.writeFileSync(shapeOnly,
      'export const recorder = { query: async (t: string) => [t] };\n'
      + 'declare const rows: string[];\n'
      + 'export const first = rows[0];\n'
      + 'export const second = rows[1];\n');
    // ...AND A COMPUTED ONE, which cannot be shown NOT to be `query` and is therefore reported.
    const computedSend = path.join(testDir, 'abc27ScopeComputed.ts');
    fs.writeFileSync(computedSend,
      "declare const client: Record<string, (t: string) => Promise<unknown>>;\n"
      + "declare const member: string;\n"
      + "export const go = () => client[member]('SELECT 1');\n");
    // ── AND G4 REACHES THIS SET, WHICH IS DORMANT ON THE REAL TREE ────────────────────────
    //
    // No `src/test/abc27*` file outside the guard's program spells a writing apply routine today,
    // so disarming the mention scan over the scope-drift set changes nothing any other sensor can
    // see — a battery mutant proved exactly that by surviving. A tripwire nothing exercises is a
    // tripwire nobody knows is connected, so it is driven here against the throwaway tree. The
    // sibling below neither writes the guarded relation nor sends SQL: the ONLY thing wrong with
    // it is that it spells the name.
    const mentionsRoutine = path.join(testDir, 'abc27ScopeMention.ts');
    fs.writeFileSync(mentionsRoutine,
      'export const inert = [\n'
      + `  'public.${WRITING_APPLY_ROUTINES[1]}()',\n`
      + '];\n');
    // ...AND ITS CONTROL: a sibling that spells the shipped LIFECYCLE wrapper is untouched, so
    // what fires above is the name and not the family.
    const nearName = path.join(testDir, 'abc27ScopeNearName.ts');
    fs.writeFileSync(nearName,
      "export const fine = ['public.rebook_round_apply_lifecycle_command_as_actor()'];\n");
    // ── AND A `.tsx` CARRIER, WHICH IS THE ONE TOKEN FORM A `.ts` FIXTURE CANNOT EXPRESS ────
    //
    // JSX TEXT is a string the runtime can read — a component renders the name and a sibling
    // reads `props.children` into SQL — and this walk did not visit `JsxText` at all. A fixture
    // body is parsed as `.ts`, where JSX is not grammar, so the only way to drive the branch is
    // a real `.tsx` sibling. This one neither writes the guarded relation nor sends SQL: the
    // only thing wrong with it is that it spells the name as element text.
    const jsxCarrier = path.join(testDir, 'abc27ScopeCarrier.tsx');
    fs.writeFileSync(jsxCarrier,
      'export const Carrier = () => (\n'
      + `  <span>${WRITING_APPLY_ROUTINES[0]}</span>\n`
      + ');\n');
    // ...AND THE SAME CARRIER WITH ITS UNDERSCORES AS JSX ENTITIES. `&#95;` IS an underscore at
    // runtime; the walk read six literal characters and found nothing. An attribute value carries
    // the same encoding, and was not visited at all.
    // ...AND A `.mts` SIBLING, the extension the sweep used to skip while claiming to cover
    // every `src/test/abc27*` file. It is ordinary executable TypeScript that an in-program file
    // can import, and nothing looked at it.
    const mtsWriter = path.join(testDir, 'abc27ScopeModule.mts');
    fs.writeFileSync(mtsWriter,
      'declare const client: { query: (t: string, v?: unknown[]) => Promise<unknown> };\n'
      + "export const go = () => client.query('INSERT INTO public.availability_slots(id, "
      + "trainer_id) VALUES ($1, $2)', []);\n");
    const jsxEntities = path.join(testDir, 'abc27ScopeEntities.tsx');
    fs.writeFileSync(jsxEntities,
      'export const Carrier = () => (\n'
      + `  <span title="${WRITING_APPLY_ROUTINES[0].replace(/_/g, '&#95;')}">x</span>\n`
      + ');\n');
    // ...AND THE HEX FORM OF THE SAME ENTITY, which is a separate branch of the decoder and had
    // no case: `&#x5f;` and `&#95;` are the same underscore by two spellings.
    // ...AND THE FOUR JAVASCRIPT EXTENSIONS, which the sweep read as nothing at all while the
    // claim beside it said every `abc27*` file. Each is importable by an in-program file.
    const jsWriters = ['abc27ScopePlain.js', 'abc27ScopeJsx.jsx', 'abc27ScopeEsm.mjs',
      'abc27ScopeCjs.cjs'].map((name) => {
      const at = path.join(testDir, name);
      fs.writeFileSync(at,
        'export const go = (client) => client.query('
        + "'UPDATE public.availability_slots SET trainer_id = $1');\n");
      return at;
    });
    // ...AND AN EXTENSION THE SWEEP HAS NO OPINION ABOUT, which must be REPORTED rather than
    // skipped — the set was guessed wrong twice, so an unknown one is now a decision to make.
    // A COMPOUND NAME, which is the ORDINARY shape here — two files in the real tree carry one,
    // and a single-dot pattern stopped sweeping both while they sat outside the program too.
    const compoundName = path.join(testDir, 'abc27ScopeCompound.runtime.test.ts');
    fs.writeFileSync(compoundName,
      'declare const client: Record<string, (t: string) => Promise<unknown>>;\n'
      + 'declare const member: string;\n'
      + "export const go = () => client[member]('SELECT 1');\n");
    // ...AND A NESTED ONE, under an `abc27*` DIRECTORY rather than beside its siblings.
    const nestedDir = path.join(testDir, 'abc27ScopeCases');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, 'bypass.ts');
    fs.writeFileSync(nestedFile,
      'declare const client: Record<string, (t: string) => Promise<unknown>>;\n'
      + 'declare const member: string;\n'
      + "export const go = () => client[member]('SELECT 1');\n");
    const undecidedSibling = path.join(testDir, 'abc27ScopeMystery.coffee');
    fs.writeFileSync(undecidedSibling, 'x = 1\n');
    // ...and one the sweep knows to be inert, so the rule is a CONTRACT and not a ban on files.
    const inertSibling = path.join(testDir, 'abc27ScopeFixture.json');
    fs.writeFileSync(inertSibling, '{"ok":true}\n');
    const jsxHexEntities = path.join(testDir, 'abc27ScopeHexEntities.tsx');
    fs.writeFileSync(jsxHexEntities,
      'export const Carrier = () => (\n'
      + `  <span>${WRITING_APPLY_ROUTINES[1].replace(/_/g, '&#x5f;')}</span>\n`
      + ');\n');
    // ...AND A `.cts` SIBLING, the other extension the sweep used to skip.
    const ctsWriter = path.join(testDir, 'abc27ScopeCommon.cts');
    fs.writeFileSync(ctsWriter,
      'declare const client: { query: (t: string, v?: unknown[]) => Promise<unknown> };\n'
      + "export const go = () => client.query('DELETE FROM public.availability_slots WHERE "
      + "id = $1', []);\n");

    const run = (inProgram) => {
      const result = { violations: [], writeSites: new Set(), exemptions: [] };
      checkScopeDrift(inProgram, dir, result);
      return result.violations;
    };
    const outside = run([]);
    const named = outside.map((v) => path.basename(v.file));
    out.push({
      ok: named.includes('abc27ScopeProbe.ts'),
      msg: 'a sibling ABC-27 file that writes the relation and is OUTSIDE the program is refused',
    });
    out.push({
      ok: named.includes('abc27ScopeSplit.ts'),
      msg: '...including one whose table name exists only across a string-literal seam, which the '
        + 'raw match could not see and the folding reader never reaches — the file is not in the program',
    });
    out.push({
      ok: named.includes('abc27ScopeVerb.ts'),
      msg: '...and one whose WRITE VERB is what the seam splits, which a check that squashed only '
        + 'for the relation name would still not report',
    });
    out.push({
      ok: named.includes('abc27ScopeDecl.ts'),
      msg: '...and one whose verb and relation are in SEPARATE DECLARATIONS, which no squash '
        + 'reaches — it is reported because it SENDS SQL, which is decidable from the syntax tree',
    });
    out.push({
      ok: !named.includes('abc27ScopeComment.ts'),
      msg: '...while a sibling that only MENTIONS the call in a comment sends nothing and is left '
        + 'alone, so the structural rule is a parser rather than a substring match',
    });
    out.push({
      ok: named.includes('abc27ScopeBracket.ts'),
      msg: '...and one that sends with the SUBSCRIPT spelling `client[\'query\'](…)`, which reading '
        + 'only member access missed',
    });
    out.push({
      ok: named.includes('abc27ScopeComputed.ts'),
      msg: '...and one whose member call is COMPUTED, which cannot be shown not to be `query` and '
        + 'is therefore reported rather than certified',
    });
    out.push({
      ok: named.includes('abc27ScopeAlias.ts'),
      msg: '...and one that BINDS the send away from its call site, where the callee is `bind` and '
        + 'then a bare identifier — obtaining `query` is what is read, not calling it',
    });
    out.push({
      ok: named.includes('abc27ScopeQuoted.ts'),
      msg: '...and one that destructures the member under a QUOTED name, which reading only an '
        + 'identifier property name missed',
    });
    out.push({
      ok: named.includes('abc27ScopeComputedBind.ts'),
      msg: '...and one whose destructured member name is COMPUTED, which cannot be shown not to '
        + 'be `query`',
    });
    out.push({
      ok: !named.includes('abc27ScopeShape.ts'),
      msg: '...while a sibling that DEFINES a `query` member and subscripts by number obtains '
        + 'nothing, so reading member access is not a ban on the word',
    });
    const inProgramLeft = run([writer, splitWriter, splitVerb, declSplit, bracketSend,
      computedSend, aliasSend, quotedDestructure, computedDestructure, mentionsRoutine,
      jsxCarrier, jsxEntities, mtsWriter, jsxHexEntities, ctsWriter, ...jsWriters,
      compoundName, nestedFile]);
    out.push({
      ok: inProgramLeft.every((v) => v.file.endsWith('abc27ScopeMystery.coffee')),
      msg: '...and the same files listed in the program are not — the demand is "put it in", not '
        + '"delete it", for the mention rule exactly as for the write one (a program file is read '
        + 'by G4 in the analysis proper, which is where the pin inventory applies). The ONE thing '
        + 'that survives is the undecided extension, and deliberately: a file the sweep cannot '
        + 'read as code cannot be put into the program either, so listing it settles nothing',
    });
    out.push({
      ok: inProgramLeft.length === 1,
      msg: '...and it is the only one left, so the clause above is not hiding a second finding',
    });
    out.push({
      ok: !outside.some((v) => v.file.endsWith('abc27ScopeReader.ts')),
      msg: 'a sibling that only READS the relation is left alone, so the tripwire is not a blanket ban',
    });
    out.push({
      ok: named.includes('abc27ScopeMention.ts'),
      msg: '...and G4 reaches this set too: a sibling that SPELLS a writing apply routine is '
        + 'refused even though it writes nothing and sends nothing — otherwise containment would '
        + 'stop at the program\'s edge, which is exactly where a new file starts',
    });
    // EACH ONE MUST BE REFUSED FOR THE RIGHT REASON. Asking only whether the file was REPORTED
    // passes for the wrong reason the moment an extension is dropped from the executable set:
    // it falls into the undecided arm and is reported by THAT rule instead. The detail is read.
    for (const name of ['abc27ScopePlain.js', 'abc27ScopeJsx.jsx', 'abc27ScopeEsm.mjs',
      'abc27ScopeCjs.cjs']) {
      const found = outside.find((v) => path.basename(v.file) === name);
      out.push({
        ok: !!found && found.detail.includes('sends SQL'),
        msg: `...and \`${name}\` is refused AS CODE THAT SENDS SQL - the sweep read it as nothing `
          + 'while claiming every `abc27*` file, and a JavaScript sibling is as importable as a '
          + `TypeScript one (reported: ${found ? found.detail.slice(0, 60) : '<not at all>'})`,
      });
    }
    out.push({
      ok: named.includes('abc27ScopeMystery.coffee'),
      msg: '...and an extension the sweep has NO OPINION about is reported rather than skipped, '
        + 'because the set was guessed wrong twice and a silent omission is how it happened',
    });
    out.push({
      ok: !named.includes('abc27ScopeFixture.json'),
      msg: '...while one it knows to be inert is left alone, so this is a contract about code '
        + 'and not a ban on files',
    });
    out.push({
      ok: named.includes('abc27ScopeHexEntities.tsx'),
      msg: '...and one using the HEX entity spelling `&#x5f;`, which is a different branch of the '
        + 'decoder from the decimal `&#95;` and had no case of its own',
    });
    const refusedAsCode = (name) => {
      const found = outside.find((v) => path.basename(v.file) === name);
      return !!found && found.detail.includes('sends SQL');
    };
    out.push({
      ok: refusedAsCode('abc27ScopeCompound.runtime.test.ts'),
      msg: '...and a COMPOUND name is swept - `abc27Foo.runtime.test.ts` is the ordinary shape in '
        + 'this tree, and a pattern permitting one dot stopped sweeping the two real files that '
        + 'carry it, which are not in the program either and were therefore checked by nothing',
    });
    out.push({
      ok: refusedAsCode('bypass.ts'),
      msg: '...and a file under an `abc27*` DIRECTORY is in the family too - matching only the '
        + 'basename skipped the directory form entirely',
    });
    out.push({
      ok: refusedAsCode('abc27ScopeCommon.cts'),
      msg: '...and a `.cts` sibling is refused AS CODE THAT SENDS SQL - asking only whether it '
        + 'was REPORTED passes for the wrong reason, because dropping the extension moves it into '
        + 'the undecided arm and it is reported by that rule instead',
    });
    out.push({
      ok: refusedAsCode('abc27ScopeModule.mts'),
      msg: '...and a `.mts` sibling is refused AS CODE THAT SENDS SQL, for the same reason - the '
        + 'sweep took only `.ts` and `.tsx` while the claim beside it said every `abc27*` file',
    });
    out.push({
      ok: named.includes('abc27ScopeEntities.tsx'),
      msg: '...and one that hides the underscores as JSX ENTITIES in an ATTRIBUTE - `&#95;` is an '
        + 'underscore at runtime, the walk saw six literal characters, and an attribute value was '
        + 'not visited at all',
    });
    out.push({
      ok: named.includes('abc27ScopeCarrier.tsx'),
      msg: '...and a `.tsx` sibling whose only fault is spelling the routine as JSX ELEMENT TEXT '
        + '- a token form the walk did not visit at all, and the one a `.ts` fixture body cannot '
        + 'express because JSX is not grammar there',
    });
    out.push({
      ok: !named.includes('abc27ScopeNearName.ts'),
      msg: '...while a sibling that spells the shipped LIFECYCLE wrapper is left alone, so what '
        + 'fires is the name and not the family',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
};

/**
 * THE FIGURES ARE RUNTIME OUTPUT, AND NOTHING ELSE.
 *
 * The CLI's contract (`process.exit(selfTest())`) is a bare exit code, and the two figures this
 * produces — the assertion total and the synthetic-fixture count — are printed in the ONE summary
 * line below and read from THERE, by a unit test that runs this CLI as a child process, requires
 * exactly one summary line, and holds both figures to exact expectations computed from the
 * exported corpus and case lists. An `onCount` callback used to hand the assertion total back to a
 * test that matched it against the runbook's prose; that test and the callback are both retired,
 * because a prose document is not an authority a test should be reading, and the callback had no
 * other caller. A caller that wants a number reads the line the CLI prints.
 */
export function selfTest({ log = console.log, err = console.error, repoRoot = REPO_ROOT } = {}) {
  let n = 0;
  const problems = [];
  const assert = (cond, msg) => { n += 1; if (!cond) problems.push(msg); };

  const { byName: results, checkedFixtureNames } =
    analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES], { repoRoot });
  for (const f of FIXTURES) {
    const r = results.get(f.name);
    if (f.verdict === 'refuse') {
      assert(r.violations.length > 0, `${f.name}: expected a refusal (${f.why}) — got none`);
    } else {
      assert(r.violations.length === 0, `${f.name}: expected acceptance (${f.why}) — refused: `
        + r.violations.map((v) => v.detail).join(' | '));
    }
  }
  for (const f of EXEMPTION_FIXTURES) {
    const r = results.get(f.name);
    assert(r.exemptions.length === f.exemptions,
      `${f.name}: expected ${f.exemptions} exemption(s), got ${r.exemptions.length}`);
    assert(r.violations.length === f.violations,
      `${f.name}: expected ${f.violations} refusal(s), got ${r.violations.length}`);
  }
  assert(results.get('exemption-in-comment').writeSites === 1,
    'an exempt site is still counted in the inventory');
  assert(!results.has('<in-scope-module>'),
    'the authority module and the factory must be clean under the guard, inside a fixture run too');

  for (const { ok, msg } of LEXER_CASES()) assert(ok, `lexer: ${msg}`);

  for (const { ok, msg } of ORACLE_CASES()) assert(ok, `oracle: ${msg}`);
  for (const { ok, msg } of IMPORT_SURFACE_CASES({ repoRoot })) assert(ok, `import surface: ${msg}`);
  // ── G1-e, OVER MUTATED COPIES OF THE REAL FACTORY ────────────────────────────────────────
  for (const { ok, msg } of FACTORY_EXPORT_SURFACE_CASES({ repoRoot })) {
    assert(ok, `factory export surface: ${msg}`);
  }
  // ── G3, OVER MUTATED COPIES OF THE REAL CATALOGUE ────────────────────────────────────────
  for (const { ok, msg } of CATALOGUE_CASES({ repoRoot })) assert(ok, `catalogue: ${msg}`);
  for (const { ok, msg } of MENTION_COUNT_CASES()) assert(ok, `mention count: ${msg}`);
  for (const { ok, msg } of POSITION_CASES()) assert(ok, `position: ${msg}`);

  // ── THE SCOPE TRIPWIRE, EXERCISED DIRECTLY ────────────────────────────────────────────────
  //
  // IT IS DORMANT BY DESIGN, and that made it invisible: no `src/test/abc27*` file outside the
  // program names the guarded relation beside a write verb today, so disarming the check changed
  // nothing any sensor could see — a mutant proved it by surviving. A tripwire nothing exercises
  // is a tripwire nobody knows is connected, so it is driven here against a temporary tree.
  for (const { ok, msg } of SCOPE_DRIFT_CASES({ repoRoot })) assert(ok, `scope drift: ${msg}`);

  // The real repository is the last fixture: the guard must agree with the tree it guards.
  const real = analyze({ repoRoot });
  assert(real.violations.length === 0,
    `the repository itself is refused: ${real.violations.slice(0, 4)
      .map((v) => `${v.file}:${v.line} ${v.detail}`).join(' | ')}`);
  const factorySites = [...real.writeSites].filter((s) => s.startsWith(FACTORY_REL + ':')).length;
  assert(factorySites === EXPECTED_FACTORY_STATEMENTS,
    `the factory has ${factorySites} statements, expected ${EXPECTED_FACTORY_STATEMENTS}`);
  assert(real.exemptions.length === EXPECTED_EXEMPTIONS,
    `the repository has ${real.exemptions.length} exemptions, expected ${EXPECTED_EXEMPTIONS}`);
  // AND NOTHING OUTSIDE THE FACTORY IS COUNTED AT ALL, which is the inventory's other half: a
  // site counted somewhere else would mean G1 had admitted one.
  // THE EXEMPT CLASS IS RECOGNISED BY ITS SEGMENT, not by a suffix: the key now carries the
  // marker's own byte offset so two exemptions on one line stay two records.
  const strays = [...real.writeSites]
    .filter((s) => !s.startsWith(FACTORY_REL + ':') && !s.includes(':exempt:'));
  assert(strays.length === 0, `slot writes counted outside the factory: ${strays.join(', ')}`);

  if (problems.length > 0) {
    err(`\n❌ ABC-27 slot write surface self-test — ${problems.length} of ${n} assertion(s) failed:\n`);
    for (const p of problems) err(`  ${p}`);
    return 1;
  }
  // "OVER N FIXTURES, INCL. THE REAL REPOSITORY" WAS TWO CLAIMS WEARING ONE SENTENCE. The
  // fixtures are SYNTHETIC — generated bodies this file writes to put a rule a question — and the
  // real tree is not one of them: it is checked by its own assertions, alongside them. Reading
  // the repository as the 107th fixture made the corpus sound one larger than it is and made the
  // repository sound like one case among many rather than the thing all of them are about.
  log(`✅ ABC-27 slot write surface self-test — ${n} assertions over `
    + `${checkedFixtureNames.size} synthetic fixtures, plus the real `
    + 'repository checked on its own.');
  return 0;
}

if (process.argv[1] && SELF === path.resolve(process.argv[1])) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : main());
}
