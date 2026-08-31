#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ABC-27 FIXTURE TRAINER SOURCE AUTHORITY, PROVED FROM THE TYPESCRIPT PROGRAM.
//
// `check_trainer_slot_overlap` is one of the 44 shipped triggers, it is live on the ABC-27
// predecessor, Stage-0 pins every one of them `tgenabled='O'`, and it is scoped to `trainer_id`
// ALONE. Nothing truncates between tests. Two fixtures that share a trainer therefore share ONE
// overlap namespace and collide whenever the calendar walks one onto the other — measured, on
// 2026-08-29.
//
// `src/test/abc27TrainerAuthority.ts` makes that unconstructible at the source: a trainer id that
// may reach `availability_slots` is a value of the branded type `IsolatedTrainerId`, the brand can
// be minted only inside that module, and minting registers the id against the current test in an
// exclusive process-wide registry that throws at ACQUISITION. This script is the other half: it
// proves, from the compiler's own program, that every write to `availability_slots` in the suite
// binds `trainer_id` to a value of that type — and refuses, by default, anything it cannot
// classify.
//
// ── WHY THIS IS A PROGRAM AND NOT A REGEX ─────────────────────────────────────────────────────
//
// The guard this replaces matched spellings in source text, and the site that defeated it read
// `SELECT t.id … FROM public.trainer_profiles t … LIMIT 1` — it named no trainer at all, so a
// deny-list of spellings had nothing to match, and it passed while the property it named was
// false. Its terminal review then produced a list of escapes it could not see: `INSERT/**/INTO`,
// a lowercase or oddly spaced verb, `U&"availability_slots"`, a statement assembled from two
// literals, `COPY`, `MERGE`.
//
// None of those are patched here, because they are one defect: SQL IS A LANGUAGE AND A REGEX IS
// NOT A READER OF IT. So this reads the TypeScript program (types, not spellings) and lexes the
// SQL (tokens, not substrings), and everything it cannot resolve is REFUSED rather than skipped.
// That inverts the failure mode of the thing it replaces: the reviewer's escapes now fail the
// gate instead of passing it, and each of them is a named self-test fixture in
// `src/test/abc27TrainerSourceAuthority.test.ts`.
//
// ── WHAT IT ENFORCES ──────────────────────────────────────────────────────────────────────────
//
//   R1  BRAND MINT CONTAINMENT. Outside the authority module nothing may assert, `satisfies`,
//       re-declare or augment `IsolatedTrainerId` or its brand symbol. `as` is the only forge the
//       type system leaves open under this repository's `strict: false`, so `as` is closed here.
//
//   R2  WRITE-SITE RESOLUTION BY TYPE. Every SQL statement in the scanned files that writes to
//       `availability_slots` — INSERT, UPDATE, MERGE or COPY, in any PostgreSQL spelling, after
//       comment stripping, whitespace folding and `U&'…'`/`U&"…"` decoding — must bind
//       `trainer_id` to (a) an interpolation whose CHECKER-RESOLVED type is the brand, (b) a `$k`
//       parameter whose argument expression's type is the brand, or (c) `alias.col` from an
//       `unnest($k…)` whose argument is a branded array. `MERGE` and `COPY` are refused outright:
//       no site uses them, and admitting a form nothing exercises is admitting an unread rule.
//
//   R3  DENY THE UNRESOLVABLE. A template hole is resolved to text only when it is branded, a
//       literal, a `const` bound to one, a `for … of` binding over an array of them, or numeric.
//       Anything else becomes an opaque atom — and an opaque atom is refused wherever it could
//       change WHAT the statement is or WHICH value lands in `trainer_id`: in the table reference,
//       in the column list, in an UPDATE's assignment structure, or in the trainer expression
//       itself. It is permitted only inside a non-trainer VALUE, where the separating commas are
//       static text: an atom cannot remove an item, so it can only ADD one, and an INSERT whose
//       expression count exceeds its column count is refused by PostgreSQL rather than silently
//       shifted. A statement the parser cannot decompose at all is refused with its site named.
//
//   R4  BOUNDED EXEMPTIONS. Exactly one `SHARED_NAMESPACE_CONTROL` site — the census control,
//       which writes a shared-namespace slot ON PURPOSE and rolls it back — pinned by marker AND
//       by count. Zero other exemptions, and no database object is exempted from anything.
//
//   R5  AN INVENTORY TRIPWIRE. The exact number of slot-write statements is restated here. It is
//       a tripwire, not the proof: R2 is the proof, and this is what makes adding or removing a
//       site a deliberate edit rather than a silent one.
//
// ── SCOPE, STATED RATHER THAN IMPLIED ─────────────────────────────────────────────────────────
//
// This reads TWO files: the authority module and the ABC-27 realpg suite. It says nothing about
// `d7RuntimeContract.realpg.test.ts` (73 write sites) or `d7Performance.realpg.test.ts`, which run
// in their own clusters with their own trainer handling. Adopting the authority there is an
// explicit follow-up, and it is named here rather than left to be discovered — a guard whose
// coverage a reader has to infer is a guard whose coverage will be over-read.
//
// THE HONEST CLAIM. Reuse is impossible for every construction this can type-check and classify;
// unclassifiable constructions are refused at CI; the runtime registry refuses reuse at
// acquisition in every run; the suite's census proves the committed residue clean. Nothing is
// claimed about mid-statement transient states — with no obtainable foreign trainer id, that path
// has no source to draw from.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SELF = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

/** The authority module — the ONE place the brand may be minted. */
export const AUTHORITY_REL = 'src/test/abc27TrainerAuthority.ts';
/** The suite whose write sites are proved. */
export const SUITE_REL = 'src/test/abc27RecipientSnapshot.realpg.test.ts';
/** The authority's own unit suite. In the program so the scope tripwire below has nothing to
 *  refuse about it, and so a SQL literal that ever appears there is proved like any other. */
export const SELFTEST_REL = 'src/test/abc27TrainerSourceAuthority.test.ts';

/**
 * The exact number of SOURCE SITES that write `availability_slots` across the scanned files:
 * 32 INSERTs, 12 UPDATEs, and the one declared exemption. Measured, and the split is stated
 * because it is twice a correction. The retired source scan counted INSERTs only, so every UPDATE
 * of this table (three of which assign `trainer_id`) was outside its inventory entirely. And the
 * twelfth UPDATE lives inside a DOLLAR-QUOTED PL/pgSQL body that a first version of this reader
 * reduced to one opaque string token — which is why bodies are now lexed recursively.
 *
 * A SITE is one `file:line:verb`, deduplicated — not one statement instance. A literal that
 * expands into several texts (a `for … of` mutation matrix, say) is still ONE place a human wrote
 * a write, and counting instances would move this number whenever an unrelated array grew an
 * element, which is how a tripwire stops being read.
 */
export const EXPECTED_WRITE_SITES = 45;
/** The exact number of deliberate shared-namespace exemptions. One: the census control. */
export const EXPECTED_EXEMPTIONS = 1;
/** The marker that names that one site, read from a SQL comment BEFORE comments are stripped. */
export const EXEMPTION_MARKER = 'SHARED_NAMESPACE_CONTROL';

/** The relation this is all about, normalised: lower case, unquoted, unqualified. */
const TABLE = 'availability_slots';
/** The trainer column. */
const TRAINER_COL = 'trainer_id';

/**
 * THE TWO HOLE ATOMS. A template interpolation is replaced by ONE control character before the SQL
 * is lexed, so a hole is always exactly one token and can never silently become a comma, a keyword
 * or a paren. `T` is a hole the checker proved is an authority-issued trainer; `U` is a hole this
 * could not resolve at all. Neither is valid SQL, which is the point: nothing else in a statement
 * can be mistaken for one.
 *
 * A `T` ATOM CARRIES AN INDEX (`T` followed by decimal digits, which the lexer keeps as one word
 * token) back to the EXPRESSION that produced it. Type alone says the value came from the
 * authority; it does not say WHICH test holds it, and a branded value hoisted to module scope
 * would be one namespace shared by every test that reads it. The index is what lets that be
 * refused — see `checkTrainerExpression`.
 */
const T = '\u0011';
const U = '\u0012';
/**
 * A hole whose type is the authority's `SqlFragment` — a text that went through `sqlFragment()`
 * and is therefore ONE SQL expression: balanced, comma-free at top level, with no statement
 * separator, comment marker or unterminated string. That is the property that makes it unable to
 * close a VALUES row and open another, which is exactly how the arity argument for admitting an
 * OPAQUE atom in a non-trainer value turned out to be wrong. It carries an index like `T` does.
 */
const F = '\u0013';
/**
 * A hole whose type is the authority's `SqlQuotedLiteral` — a canonical UUID, containing only hex
 * digits and hyphens. `F` promises ONE EXPRESSION, which is the right promise for an unquoted
 * position and the wrong one inside static quotes: `sqlFragment("x', 'y")` is one expression, and
 * `'x', 'y'` is two. So `F` is refused inside a string literal and this is what may go there.
 */
const Q = '\u0014';

/** Bound on how many texts one literal may expand into before the literal is simply refused. */
const MAX_EXPANSIONS = 64;

// ── THE SQL LEXER ─────────────────────────────────────────────────────────────────────────────
//
// Not a tokenizer of convenience: deciding what is a comment, what is a string, what is a
// dollar-quoted body and what is an identifier IS lexing, and every defect the regex guard had
// was a consequence of guessing at it. `--` inside `'…'` is not a comment; `INSERT` inside `'…'`
// is not a verb; `/* /* */ */` nests in PostgreSQL; `U&"availability\005Fslots"` names the table;
// `E'\''` escapes with a backslash and `'…''…'` escapes by doubling.

export class SqlLexError extends Error {}

/** Word characters, plus the two hole atoms so each stays exactly one token. */
const WORD_RE = new RegExp(`[A-Za-z0-9_$${T}${U}${F}${Q}]`);

/**
 * Lex `sql` into tokens. Comments are dropped but REPORTED, because the exemption marker lives in
 * one. Strings and quoted identifiers keep their decoded content and are TYPED, so a verb or a
 * table name inside a string can never be mistaken for the statement's own.
 *
 * Throws `SqlLexError` when a construct does not terminate — an unterminated string or block
 * comment means the text is not the statement it appears to be, and guessing past it is exactly
 * the class of mistake this exists to remove.
 */
export function lexSql(sql) {
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
      if (depth > 0) throw new SqlLexError('unterminated block comment');
      comments.push({ text: sql.slice(i + 2, j - 2), pos: i });
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new SqlLexError(`unterminated dollar-quoted string ${tag}`);
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
      const { text, next } = readQuoted(sql, i + 2, quote);
      // The UESCAPE clause may name another escape character; only the default is accepted,
      // because a custom one this does not implement must not be silently mis-decoded.
      let j = next;
      while (j < n && /\s/.test(sql[j])) j += 1;
      if (/^uescape\b/i.test(sql.slice(j, j + 8))) {
        throw new SqlLexError('UESCAPE is not decoded by this lexer');
      }
      push(quote === "'" ? 'string' : 'ident', decodeUnicodeEscapes(text));
      i = next;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      const { text, next } = readEscapeString(sql, i + 1);
      push('string', text);
      i = next;
      continue;
    }
    if (ch === "'") { const r = readQuoted(sql, i, "'"); push('string', r.text); i = r.next; continue; }
    if (ch === '"') { const r = readQuoted(sql, i, '"'); push('ident', r.text); i = r.next; continue; }
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
function readQuoted(sql, start, quote) {
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) {
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

/** `E'…'`: backslash escapes, plus the doubling rule. */
function readEscapeString(sql, start) {
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) throw new SqlLexError('unterminated escape string');
    if (sql[i] === '\\') { out += sql[i + 1] ?? ''; i += 2; continue; }
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }
      return { text: out, next: i + 1 };
    }
    out += sql[i];
    i += 1;
  }
}

/** `U&"…"` escapes: `\XXXX` and `\+XXXXXX`, plus `\\` for a literal backslash. */
export function decodeUnicodeEscapes(text) {
  return text
    .replace(/\\\+([0-9A-Fa-f]{6})/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
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

/** Split `toks[from..to)` on commas at paren depth zero. */
function topLevelSplit(toks, from, to) {
  const items = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const tok = toks[i];
    if (isPunct(tok, '(')) depth += 1;
    else if (isPunct(tok, ')')) depth -= 1;
    else if (depth === 0 && isPunct(tok, ',')) { items.push(toks.slice(start, i)); start = i + 1; }
  }
  items.push(toks.slice(start, to));
  return items;
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

/** Render tokens for a legible refusal, with the two atoms spelled out. */
const render = (toks) => toks.map((t) => {
  const v = String(t.value).split(T).join('<authority-trainer>').split(U).join('<unresolved>')
    .split(F).join('<validated-fragment>').split(Q).join('<validated-uuid>');
  return isStringy(t) ? `'${v}'` : t.kind === 'ident' ? `"${v}"` : v;
}).join(' ').slice(0, 160);

/** Does a token sequence carry an unresolved atom, in any token kind? */
const hasUnresolved = (toks) => toks.some((t) => String(t.value).includes(U));

/**
 * A validated FRAGMENT sitting inside a SQL string literal. Its guarantee is "one SQL expression",
 * which says nothing about what happens when the text is wrapped in quotes it did not write:
 * `x', 'y` is one expression, and `'x', 'y'` is two. A UUID (`Q`) may go there; a fragment may not.
 */
const hasQuotedFragment = (toks) => toks.some((t) => isStringy(t) && String(t.value).includes(F));

/**
 * Drop trailing `:: type` casts, which say nothing about a value's origin. `[]` array suffixes go
 * first, so `$2::uuid[]` reads as parameter 2 rather than as something this cannot classify — an
 * empty bracket pair is unambiguous here because a SUBSCRIPT always has an index between the
 * brackets and therefore never matches.
 */
function stripCasts(toks) {
  let out = toks.slice();
  for (;;) {
    let k = out.length;
    while (k >= 2 && isPunct(out[k - 2], '[') && isPunct(out[k - 1], ']')) {
      out = out.slice(0, k - 2);
      k = out.length;
    }
    if (k >= 3 && isPunct(out[k - 3], ':') && isPunct(out[k - 2], ':')
      && (out[k - 1].kind === 'word' || out[k - 1].kind === 'ident')) {
      out = out.slice(0, k - 3);
      continue;
    }
    return out;
  }
}

/**
 * The index of the branded hole this expression IS, or -1. Exactly two shapes under an optional
 * cast: the atom bare, and the atom as a SQL string literal (which is how `'${trainer}'` arrives).
 */
function authorityTrainerHole(toks) {
  const t = stripCasts(toks);
  if (t.length !== 1) return -1;
  const only = t[0];
  if (only.kind !== 'word' && !isStringy(only)) return -1;
  const m = new RegExp(`^${T}(\\d+)$`).exec(String(only.value));
  return m ? Number(m[1]) : -1;
}

/** The Vitest calls whose callback body runs ONCE, at collection, for a whole group of tests. */
const COLLECTION_SCOPES = new Set(['describe', 'suite']);

/**
 * Does this identifier's binding OUTLIVE a single test?
 *
 * "Module scope" was the first proxy for this and it is the wrong one, in both directions. A
 * `const` written directly in a `describe` callback body is not module scope, but that callback
 * runs ONCE at collection, so every test in the group reads the same value — which is precisely
 * the shared namespace this refuses. Conversely a binding inside an `it` callback, or inside any
 * ordinary helper function, is created per invocation and belongs to whichever test invoked it.
 *
 * So the question asked here is: is the nearest enclosing function this binding lives in either
 * absent (module scope) or a collection callback? A parameter is never either, and neither is a
 * local of a helper.
 *
 * DELIBERATELY CONSERVATIVE IN ONE DIRECTION: a module-level `let` reassigned in `beforeEach` is
 * genuinely per-test and is refused anyway. No site does that, and a refusal there is a message to
 * bind the value where the test can see it rather than a false statement about the code.
 */
function declaredOutsideATest(ident, checker) {
  const sym = checker.getSymbolAtLocation(ident);
  for (const decl of (sym && sym.declarations) || []) {
    if (!ts.isVariableDeclaration(decl) && !ts.isBindingElement(decl)) continue;
    let p = decl.parent;
    let fn = null;
    while (p && !ts.isSourceFile(p)) {
      if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)
        || ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)
        || ts.isGetAccessor(p) || ts.isSetAccessor(p)) { fn = p; break; }
      p = p.parent;
    }
    // WALK PAST AN IIFE. An immediately-invoked function runs WHERE IT IS WRITTEN, so a binding
    // inside one declared in a `describe` body is created at collection exactly as a bare `const`
    // there would be. Stopping at the nearest function called it test-local and was wrong.
    for (;;) {
      if (!fn) return true;                                   // module scope
      // THE PARENTHESES ARE PART OF THE IDIOM. `(async () => { … })()` puts a
      // ParenthesizedExpression between the arrow and the call, so looking only at `fn.parent`
      // never saw an IIFE at all — which is how this rule came to pass its own fixture.
      let wrapper = fn.parent;
      while (wrapper && ts.isParenthesizedExpression(wrapper)) wrapper = wrapper.parent;
      const iife = wrapper && ts.isCallExpression(wrapper)
        && stripParens(wrapper.expression) === fn;
      if (!iife) break;
      let up = wrapper.parent;
      let outer = null;
      while (up && !ts.isSourceFile(up)) {
        if (ts.isFunctionDeclaration(up) || ts.isFunctionExpression(up) || ts.isArrowFunction(up)
          || ts.isMethodDeclaration(up) || ts.isConstructorDeclaration(up)
          || ts.isGetAccessor(up) || ts.isSetAccessor(up)) { outer = up; break; }
        up = up.parent;
      }
      fn = outer;
    }
    const call = fn.parent;
    if (call && ts.isCallExpression(call) && call.arguments.includes(fn)) {
      let callee = call.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
        callee = callee.expression;
      }
      if (ts.isIdentifier(callee) && COLLECTION_SCOPES.has(callee.text)) return true;
    }
  }
  return false;
}

/** Peel `(…)` wrappers, which an IIFE is usually written with. */
function stripParens(node) {
  let n = node;
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/**
 * Does any identifier in this expression read a binding that OUTLIVES one test?
 *
 * A branded value is proof of ORIGIN, not of ownership: the authority issued it to whichever test
 * asked, and the type carries no trace of which. A module-scope binding is the one place a value
 * can outlive the test that acquired it — either acquired during collection (owned by the
 * bootstrap identity, so every test that reads it shares one namespace) or assigned inside one
 * test and read by another. Both are the collision this exists to prevent, so a trainer expression
 * that reads a module-scope binding is refused. Locals, parameters and inline authority calls are
 * unaffected, which is every current site.
 */
function readsModuleScopeBinding(expr, checker, brandProp) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    // ONLY THE VALUE THAT CARRIES THE TRAINER. Every site reads the file-level client `c` to send
    // its statement, and that is not a namespace — the identifier that matters is the one whose
    // TYPE is the brand (or an array of it).
    const brandedHere = isBrandedType(checker.getTypeAtLocation(node), brandProp)
      || isBrandedArrayType(checker, checker.getTypeAtLocation(node), brandProp);
    // A BRANDED PROPERTY IS AS MUCH A BINDING AS A BRANDED VARIABLE. `state.trainer` reads
    // whatever `state` holds, so the scope that matters is the ROOT of the access chain.
    if (brandedHere && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)
        || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root)) {
        root = root.expression;
      }
      if (ts.isIdentifier(root) && declaredOutsideATest(root, checker)) {
        found = root.text;
        return;
      }
    }
    if (brandedHere && ts.isIdentifier(node) && declaredOutsideATest(node, checker)) {
      found = node.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * A `$k` reference, or null. `$` is a word character in PostgreSQL identifiers, so the lexer
 * emits `$2` as ONE word token — which is also why the dollar-quote scanner runs before the word
 * scanner and only claims a `$tag$` pair.
 */
function paramIndex(toks) {
  const t = stripCasts(toks);
  if (t.length !== 1) return null;
  if (t[0].kind !== 'word' || !/^\$\d+$/.test(String(t[0].value))) return null;
  return Number(String(t[0].value).slice(1));
}

/** `alias.column`, or null — the shape a set-returning `unnest` binding takes. */
function qualifiedRef(toks) {
  const t = stripCasts(toks);
  if (t.length !== 3) return null;
  if (t[0].kind !== 'word' && t[0].kind !== 'ident') return null;
  if (!isPunct(t[1], '.')) return null;
  if (t[2].kind !== 'word' && t[2].kind !== 'ident') return null;
  return { alias: String(t[0].value), column: String(t[2].value) };
}

/**
 * Every `unnest ( <expr> ) [WITH ORDINALITY] [AS] alias [( col [, col…] )]` in a statement, with
 * the parameter that feeds it and its FIRST alias column. Only that first column is the unnested
 * value; a second one is the ordinality, and binding a trainer to it would be a different thing.
 */
function unnestBindings(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (!isWord(toks[i], 'unnest') || !isPunct(toks[i + 1], '(')) continue;
    const close = matchParen(toks, i + 1);
    if (close === -1) continue;
    const param = paramIndex(toks.slice(i + 2, close));
    let j = close + 1;
    if (isWord(toks[j], 'with') && isWord(toks[j + 1], 'ordinality')) j += 2;
    if (isWord(toks[j], 'as')) j += 1;
    const alias = toks[j];
    if (!alias || (alias.kind !== 'word' && alias.kind !== 'ident')) continue;
    let firstColumn = null;
    if (isPunct(toks[j + 1], '(')) {
      const cclose = matchParen(toks, j + 1);
      if (cclose !== -1) {
        const cols = topLevelSplit(toks, j + 2, cclose);
        firstColumn = cols[0] && cols[0].length === 1 ? String(cols[0][0].value) : null;
      }
    }
    out.push({ alias: String(alias.value), firstColumn, param });
  }
  return out;
}

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

const NUMERICISH = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;

/**
 * Resolve one expression to the set of SQL texts it can contribute, or `null` when it cannot be
 * resolved. THE ORDER MATTERS: the brand is asked FIRST, so a branded value never degrades into
 * whatever literal a `const` happens to hold.
 */
function resolveExpression(expr, ctx, depth = 0) {
  if (depth > 8) return null;
  const { checker, brandProp } = ctx;

  if (isBrandedType(checker.getTypeAtLocation(expr), brandProp)) {
    ctx.holes.push(expr);
    return [T + String(ctx.holes.length - 1)];
  }
  if (ctx.fragmentProp && isBrandedType(checker.getTypeAtLocation(expr), ctx.fragmentProp)) {
    ctx.holes.push(expr);
    return [F + String(ctx.holes.length - 1)];
  }
  if (ctx.quotedProp && isBrandedType(checker.getTypeAtLocation(expr), ctx.quotedProp)) {
    ctx.holes.push(expr);
    return [Q + String(ctx.holes.length - 1)];
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isTemplateExpression(expr)) return expandTemplate(expr, ctx, depth + 1);
  if (ts.isParenthesizedExpression(expr)) return resolveExpression(expr.expression, ctx, depth + 1);

  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return cartesian(resolveExpression(expr.left, ctx, depth + 1),
      resolveExpression(expr.right, ctx, depth + 1));
  }

  if (ts.isIdentifier(expr)) {
    const declared = resolveIdentifier(expr, ctx, depth);
    if (declared !== null) return declared;
  }

  // Numbers and booleans cannot contribute a keyword, an identifier or a comma, so they are inert
  // and `0` stands in for all of them. This is what keeps `make_interval(hours => ${lane})` from
  // being an unresolvable hole in an otherwise fully classified statement.
  const parts = constituents(checker.getTypeAtLocation(expr));
  if (parts.length > 0 && parts.every((t) => (t.flags & NUMERICISH) !== 0)) return ['0'];
  return null;
}

/**
 * An identifier resolves only through a CLOSED set of bindings — a `const` with an initializer, or
 * a `for … of` over an array literal. Anything else (a `let`, a parameter, an import, a
 * destructuring, more than one declaration) is deliberately not followed: a partial dataflow
 * analysis that guesses is worse than one that refuses, and refusing is the safe direction.
 */
function resolveIdentifier(ident, ctx, depth) {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decls = (sym && sym.declarations) || [];
  if (decls.length !== 1) return null;

  // A DESTRUCTURED binding declares the identifier at a `BindingElement`, not at the
  // `VariableDeclaration` — `for (const [name, mutation] of cases)` is exactly that shape, and
  // reading only `VariableDeclaration` left every such hole unresolvable.
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

  // `const x = <expr>`
  if (tupleIndex === null && ts.isIdentifier(decl.name) && decl.initializer) {
    return resolveExpression(decl.initializer, ctx, depth + 1);
  }
  // `for (const x of <array>)` and `for (const [a, x] of <array of tuples>)`
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
    if (r === null) return null;
    out.push(...r);
    if (out.length > MAX_EXPANSIONS) return null;
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

const cartesian = (a, b) => {
  if (a === null || b === null) return null;
  const out = [];
  for (const x of a) {
    for (const y of b) {
      out.push(x + y);
      if (out.length > MAX_EXPANSIONS) return null;
    }
  }
  return out;
};

/** Expand a template literal into every SQL text it can be, unresolved holes becoming atoms. */
function expandTemplate(node, ctx, depth = 0) {
  let acc = [node.head.text];
  for (const span of node.templateSpans) {
    const resolved = resolveExpression(span.expression, ctx, depth + 1) || [U];
    acc = cartesian(acc, resolved);
    if (acc === null) return null;
    acc = acc.map((s) => s + span.literal.text);
  }
  return acc;
}

/** Every SQL text a literal node can be. `null` means "too many expansions", which is refused. */
function expansionsOf(node, ctx) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return expandTemplate(node, ctx);
  // A CONCATENATION IS ONE STATEMENT. `'INSERT INTO public.avail' + 'ability_slots …'` is a
  // literal in every sense that matters, and reading only the pieces is exactly how a statement
  // gets assembled out of fragments none of which names the table.
  if (isConcatenation(node)) return resolveExpression(node, ctx);
  return null;
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

/**
 * The `[params]` array for a literal used as `client.query(<literal>, [ … ])`, or null when there
 * is no such array to read — in which case a `$k` binding is refused rather than assumed.
 */
function paramExpressions(literal) {
  const call = literal.parent;
  if (!call || !ts.isCallExpression(call)) return { params: null, isQueryCall: false };
  if (call.arguments[0] !== literal) return { params: null, isQueryCall: false };
  // IT MUST BE THE DRIVER'S OWN ENTRY POINT. Reading "the second argument of whatever call this
  // literal sits in" would let a wrapper present a branded array here while forwarding a different
  // one to `client.query`. `<expr>.query(sql, params)` is the only shape `pg` binds parameters
  // through, so it is the only shape a `$k` may be resolved against.
  const isQueryCall = ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === 'query';
  const second = call.arguments[1];
  if (!second || !ts.isArrayLiteralExpression(second)) return { params: null, isQueryCall };
  return { params: second.elements, isQueryCall };
}

// ── THE ANALYSIS ──────────────────────────────────────────────────────────────────────────────

/** How many INSERT/UPDATE/MERGE/COPY statements in these tokens target the guarded relation. */
function countWritesToTable(stmt) {
  let n = 0;
  for (let i = 0; i < stmt.length; i += 1) {
    const tok = stmt[i];
    if (tok.kind !== 'word') continue;
    if ((tok.value === 'merge' || tok.value === 'copy') && stmt.some(namesTable)) { n += 1; continue; }
    let at = -1;
    if (tok.value === 'insert' && isWord(stmt[i + 1], 'into')) at = i + 2;
    else if (tok.value === 'update') at = i + 1;
    if (at === -1) continue;
    const { table, next } = readTableRef(stmt, at);
    if (table && namesTable(table)) { n += 1; i = next - 1; }
  }
  return n;
}

/** Classify one statement of one expansion of one literal. */
function analyseStatement(stmt, site, ctx, result) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });

  for (let i = 0; i < stmt.length; i += 1) {
    const tok = stmt[i];
    if (tok.kind !== 'word') continue;

    if (tok.value === 'merge' || tok.value === 'copy') {
      if (stmt.some(namesTable)) {
        fail(`${tok.value.toUpperCase()} against ${TABLE} is refused outright — no site uses it, `
          + 'and a form nothing exercises is a rule nobody has read');
        return;
      }
      continue;
    }

    if (tok.value === 'insert' && isWord(stmt[i + 1], 'into')) {
      const { table, next } = readTableRef(stmt, i + 2);
      // AN INTERPOLATED RELATION IS REFUSED, not skipped. `INSERT INTO ${x}` reads as a perfectly
      // ordinary name and would otherwise "not be this table" — which is exactly the assumption a
      // write must not be allowed to make about itself. A reference that is not readable at all
      // (the word INSERT in a prose string, say) is not a statement and is simply passed over.
      if (table === null) {
        if (hasUnresolved(stmt.slice(i, i + 4))) {
          fail('an INSERT whose target relation is not statically resolvable');
          return;
        }
        continue;
      }
      if (hasUnresolved(stmt.slice(i + 2, Math.max(next, i + 3)))) {
        fail('an INSERT whose target relation is an interpolation, so it cannot be shown not to '
          + `be ${TABLE}`);
        return;
      }
      if (!namesTable(table)) continue;
      result.writeSites.add(`${site.file}:${site.line}:insert`);
      analyseInsert(stmt, next, site, ctx, result);
      // AND KEEP SCANNING. A data-modifying CTE can carry two INSERTs into this table in ONE
      // statement; stopping at the first would leave the second unexamined.
      i = next - 1;
      continue;
    }

    if (tok.value === 'update') {
      const { table, next } = readTableRef(stmt, i + 1);
      if (table === null) {
        if (hasUnresolved(stmt.slice(i, i + 3))) {
          fail('an UPDATE whose target relation is not statically resolvable');
          return;
        }
        continue;
      }
      if (hasUnresolved(stmt.slice(i + 1, Math.max(next, i + 2)))) {
        fail('an UPDATE whose target relation is an interpolation, so it cannot be shown not to '
          + `be ${TABLE}`);
        return;
      }
      if (!namesTable(table)) continue;
      result.writeSites.add(`${site.file}:${site.line}:update`);
      analyseUpdate(stmt, next, site, ctx, result);
      i = next - 1;
      continue;
    }
  }
}

/** `INSERT INTO <table> ( cols ) VALUES ( … ) | SELECT …` */
function analyseInsert(stmt, afterTable, site, ctx, result) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });
  if (!isPunct(stmt[afterTable], '(')) {
    fail(`an INSERT into ${TABLE} with no column list — the position of ${TRAINER_COL} cannot be `
      + 'decided, so it is refused');
    return;
  }
  const close = matchParen(stmt, afterTable);
  if (close === -1) { fail('an INSERT whose column list does not close'); return; }
  // NO OPAQUE ATOM ANYWHERE IN THIS STATEMENT.
  //
  // The first version of this reader admitted one inside a non-trainer VALUE, arguing that the
  // separating commas are static so an atom can only ADD an expression and PostgreSQL refuses a
  // row with more expressions than columns. A review round showed that argument is wrong: a
  // fragment can close its own row and open another of exactly the right arity —
  // `x), (foreign_trainer, …` — and the trainer of that second row is invisible here. There is no
  // positional narrowing that survives it, so the atom is refused outright and the three fixture
  // helpers route their override fragments through the authority's `sqlFragment`, which VALIDATES
  // that the text is one SQL expression and brands it.
  if (hasQuotedFragment(stmt)) {
    fail(`an INSERT into ${TABLE} interpolating a validated FRAGMENT inside SQL quotes - a `
      + "fragment is proved to be one EXPRESSION, which says nothing about what happens when it is "
      + "wrapped in quotes it did not write (`x', 'y` is one expression; `'x', 'y'` is two). Use "
      + '`sqlUuid()` for a value that belongs inside quotes');
    return;
  }
  if (hasUnresolved(stmt)) {
    fail(`an INSERT into ${TABLE} carrying an unresolvable interpolation - such a fragment can `
      + 'close its VALUES row and open another with a trainer this cannot see, so it is refused '
      + 'wherever it appears. Route it through `sqlFragment()`, which proves it is one expression');
    return;
  }
  const cols = topLevelSplit(stmt, afterTable + 1, close);
  const names = cols.map((c) => (c.length === 1 ? String(c[0].value).toLowerCase() : null));
  const idx = names.indexOf(TRAINER_COL);
  const i = close + 1;
  // THE UPSERT ARM IS READ FIRST, AND UNCONDITIONALLY. `ON CONFLICT … DO UPDATE SET trainer_id`
  // assigns a trainer whether or not the INSERT's own column list names one, and returning early
  // on a trainer-less column list left exactly that arm unexamined.
  checkOnConflict(stmt, i, site, ctx, result);
  // A column list that does not name the trainer leaves it to the column default, which is not a
  // namespace any fixture can claim.
  if (idx === -1) return;

  let classified = false;
  if (isWord(stmt[i], 'values')) {
    let j = i + 1;
    for (;;) {
      if (!isPunct(stmt[j], '(')) break;
      const rclose = matchParen(stmt, j);
      if (rclose === -1) { fail('an INSERT whose VALUES row does not close'); return; }
      const items = topLevelSplit(stmt, j + 1, rclose);
      if (items.length !== cols.length) {
        fail(`an INSERT into ${TABLE} binding ${items.length} expression(s) to ${cols.length} `
          + 'column(s) — the trainer position cannot be decided');
        return;
      }
      checkTrainerExpression(items[idx], stmt, site, ctx, result);
      classified = true;
      j = rclose + 1;
      if (isPunct(stmt[j], ',')) { j += 1; continue; }
      break;
    }
  } else if (isWord(stmt[i], 'select') || isPunct(stmt[i], '(')) {
    // EVERY ARM, NOT THE FIRST. `SELECT … UNION ALL SELECT …` projects onto the same column list
    // from each arm, so stopping at the first one leaves the rest unexamined.
    //
    // AND EVERY ARM MUST BE A SELECT. `UNION VALUES (…)` and `UNION TABLE relation` are legal arms
    // this reader has no projection for, so they are refused rather than skipped — which is what
    // "skipped" would have amounted to, since an arm it does not see contributes a trainer it does
    // not check.
    const arms = selectArms(stmt, i);
    if (countSetOperators(stmt, i) !== arms.length - 1) {
      fail(`an INSERT … SELECT into ${TABLE} whose set-operation arms are not all SELECTs `
        + '(a `VALUES` or `TABLE` arm, say) - refused, because an arm with no projection this '
        + 'reader can locate still contributes rows');
      return;
    }
    for (const arm of arms) {
      const items = topLevelSplit(stmt, arm.from, arm.to);
      if (items.length !== cols.length) {
        fail(`an INSERT … SELECT into ${TABLE} projecting ${items.length} expression(s) onto `
          + `${cols.length} column(s) — the trainer position cannot be decided`);
        return;
      }
      checkTrainerExpression(items[idx], stmt, site, ctx, result);
      classified = true;
    }
  }
  if (!classified) {
    fail(`an INSERT into ${TABLE} that is neither VALUES nor SELECT — refused as unclassifiable`);
    return;
  }

}

/**
 * The select LIST of every arm of a (possibly set-operation) SELECT starting at `i`.
 *
 * Each arm runs from just past its `SELECT` to the first top-level `FROM`, or to the top-level
 * `UNION`/`INTERSECT`/`EXCEPT` that ends it, or to the end of the statement. Parenthesised arms are
 * entered. Nothing here needs to understand precedence: every arm projects onto the SAME column
 * list, so every arm's trainer position is checked and the order between them does not matter.
 */
function selectArms(stmt, i) {
  const arms = [];
  let depth = 0;
  let armStart = -1;
  for (let k = i; k < stmt.length; k += 1) {
    if (isPunct(stmt[k], '(')) { depth += 1; continue; }
    if (isPunct(stmt[k], ')')) {
      depth -= 1;
      // OUT OF THE ENCLOSING PARENTHESIS ENDS THE SEARCH. A data-modifying CTE puts this INSERT
      // inside `WITH s AS ( … )`, and walking past its closing paren would collect the OUTER
      // statement's SELECT as another arm of this one — which is how a 20-column INSERT came to
      // be compared against a 3-column projection belonging to a different table.
      if (depth < 0) { if (armStart !== -1) { arms.push({ from: armStart, to: k }); armStart = -1; } break; }
      continue;
    }
    if (stmt[k].kind !== 'word') continue;
    if (stmt[k].value === 'select' && armStart === -1) { armStart = k + 1; continue; }
    if (armStart === -1) continue;
    const boundary = stmt[k].value === 'from'
      || ((stmt[k].value === 'union' || stmt[k].value === 'intersect' || stmt[k].value === 'except')
        && depth === 0);
    if (boundary) { arms.push({ from: armStart, to: k }); armStart = -1; }
  }
  if (armStart !== -1) arms.push({ from: armStart, to: stmt.length });
  return arms;
}

/** Top-level `UNION`/`INTERSECT`/`EXCEPT` keywords from `i` to the end of the enclosing paren. */
function countSetOperators(stmt, i) {
  let depth = 0;
  let n = 0;
  for (let k = i; k < stmt.length; k += 1) {
    if (isPunct(stmt[k], '(')) { depth += 1; continue; }
    if (isPunct(stmt[k], ')')) { depth -= 1; if (depth < 0) break; continue; }
    if (depth === 0 && stmt[k].kind === 'word'
      && ['union', 'intersect', 'except'].includes(stmt[k].value)) n += 1;
  }
  return n;
}

/** `UPDATE <table> [alias] SET col = expr [, …]` */
function analyseUpdate(stmt, afterTable, site, ctx, result) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });
  let i = afterTable;
  if (isWord(stmt[i], 'as')) i += 2;
  else if (stmt[i] && (stmt[i].kind === 'word' || stmt[i].kind === 'ident')
    && !isWord(stmt[i], 'set')) i += 1;
  if (!isWord(stmt[i], 'set')) {
    fail(`an UPDATE of ${TABLE} whose SET clause could not be found — refused as unclassifiable`);
    return;
  }
  // NO OPAQUE ATOM ANYWHERE, for the same reason as the INSERT arm and one more: a SET list has no
  // expression count at all for PostgreSQL to refuse, so an atom inside ANY assignment's value
  // could carry `, trainer_id = …` and the statement would still be valid.
  if (hasQuotedFragment(stmt)) {
    fail(`an UPDATE of ${TABLE} interpolating a validated FRAGMENT inside SQL quotes - use `
      + '`sqlUuid()` for a value that belongs inside quotes');
    return;
  }
  if (hasUnresolved(stmt)) {
    fail(`an UPDATE of ${TABLE} carrying an unresolvable interpolation - a SET list has no `
      + `expression count for PostgreSQL to refuse, so an atom anywhere in it could add a `
      + `${TRAINER_COL} assignment this cannot see. Route it through \`sqlFragment()\``);
    return;
  }
  checkSetAssignments(stmt, i, site, ctx, result, `an UPDATE of ${TABLE}`);
}

/**
 * The `SET col = expr [, …]` list starting just past `setKeywordAt`, shared by `UPDATE` and by
 * `INSERT … ON CONFLICT DO UPDATE`.
 */
function checkSetAssignments(stmt, setKeywordAt, site, ctx, result, what) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });
  let depth = 0;
  let end = stmt.length;
  for (let k = setKeywordAt + 1; k < stmt.length; k += 1) {
    if (isPunct(stmt[k], '(')) depth += 1;
    else if (isPunct(stmt[k], ')')) { depth -= 1; if (depth < 0) { end = k; break; } }
    else if (depth === 0 && stmt[k].kind === 'word'
      && ['from', 'where', 'returning'].includes(stmt[k].value)) { end = k; break; }
  }
  for (const a of topLevelSplit(stmt, setKeywordAt + 1, end)) {
    // Every assignment must be `<column> = <expression>`. A multi-column `( a, b ) = ( … )` form,
    // or an interpolation standing in for the assignment itself, means the SET structure is not
    // statically known — and a trainer assignment could hide inside it.
    const target = a[0];
    if (!target || (target.kind !== 'word' && target.kind !== 'ident') || !isPunct(a[1], '=')) {
      fail(`${what} whose SET clause is not a resolvable list of \`column = expression\` `
        + `assignments (${render(a)}) — refused, because a ${TRAINER_COL} assignment could hide `
        + 'inside it');
      return;
    }
    if (String(target.value).toLowerCase() !== TRAINER_COL) continue;
    checkTrainerExpression(a.slice(2), stmt, site, ctx, result);
  }
}

/** `ON CONFLICT … DO UPDATE SET …` — a trainer assignment living entirely past the VALUES list. */
function checkOnConflict(stmt, from, site, ctx, result) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });
  for (let k = from; k < stmt.length; k += 1) {
    if (!isWord(stmt[k], 'on') || !isWord(stmt[k + 1], 'conflict')) continue;
    let m = k + 2;
    while (m < stmt.length && !isWord(stmt[m], 'do')) m += 1;
    if (isWord(stmt[m + 1], 'nothing')) return;
    if (!isWord(stmt[m + 1], 'update') || !isWord(stmt[m + 2], 'set')) {
      fail(`an INSERT into ${TABLE} whose ON CONFLICT action could not be read - refused`);
      return;
    }
    checkSetAssignments(stmt, m + 2, site, ctx, result,
      'the ON CONFLICT DO UPDATE clause of an INSERT');
    return;
  }
}

/** The heart of R2: what may be bound to `trainer_id`, and nothing else. */
function checkTrainerExpression(expr, stmt, site, ctx, result) {
  const fail = (detail) => result.violations.push({ file: site.file, line: site.line, detail });

  // (a) an interpolation whose checker-resolved type is the brand — AND which reads no module-
  //     scope binding, so the value cannot be one every test shares.
  const hole = authorityTrainerHole(expr);
  if (hole >= 0) {
    const node = ctx.holes[hole];
    const shared = node && readsModuleScopeBinding(node, ctx.checker, ctx.brandProp);
    if (shared) {
      fail(`${TRAINER_COL} is bound to a branded value that reads \`${shared}\`, a binding that `
        + 'OUTLIVES one test (module scope, or a `describe` callback body, whose value every test '
        + 'in the group reads) - the brand proves the authority issued the id, not which test '
        + 'holds it');
      return;
    }
    return;
  }

  // (b) a `$k` parameter whose argument expression's type is the brand
  const k = paramIndex(expr);
  if (k !== null) {
    if (!site.params) {
      fail(`${TRAINER_COL} is bound to $${k}, but this statement has no readable parameter array `
        + '- the value cannot be typed, so it is refused');
      return;
    }
    const arg = site.params[k - 1];
    if (!arg) { fail(`${TRAINER_COL} is bound to $${k}, which has no argument`); return; }
    if (!site.isQueryCall) {
      fail(`${TRAINER_COL} is bound to $${k} in a call that is not \`<client>.query(sql, params)\` `
        + '- the array this reads is not provably the array the driver sends');
      return;
    }
    const scoped = readsModuleScopeBinding(arg, ctx.checker, ctx.brandProp);
    if (scoped) {
      fail(`${TRAINER_COL} is bound to $${k}, whose argument reads \`${scoped}\`, a binding that `
        + 'outlives one test - a value every test in the group can read is a namespace they share');
      return;
    }
    if (isBrandedType(ctx.checker.getTypeAtLocation(arg), ctx.brandProp)) return;
    fail(`${TRAINER_COL} is bound to $${k}, whose argument \`${arg.getText().slice(0, 80)}\` is `
      + 'not an IsolatedTrainerId');
    return;
  }

  // (c) `alias.column` from an `unnest($k…)` whose argument is a branded array
  const ref = qualifiedRef(expr);
  if (ref) {
    // AMBIGUITY IS A REFUSAL. Bindings are collected across the whole statement and matched by
    // alias, which is not real scoping — so two `unnest`s sharing an alias would let one bless the
    // other. Two is refused rather than resolved by guesswork.
    const matches = unnestBindings(stmt).filter((b) => b.alias === ref.alias
      && (b.firstColumn === null || b.firstColumn === ref.column));
    if (matches.length > 1) {
      fail(`${TRAINER_COL} comes from \`${ref.alias}.${ref.column}\`, and this statement has `
        + `${matches.length} \`unnest\` bindings with that alias - which one supplies it cannot be `
        + 'decided by alias alone, so it is refused');
      return;
    }
    for (const b of matches) {
      if (b.param === null) break;
      if (!site.isQueryCall) {
        fail(`${TRAINER_COL} comes from unnest($${b.param}) in a call that is not `
          + '`<client>.query(sql, params)` - the array this reads is not provably the array the '
          + 'driver sends');
        return;
      }
      const arg = site.params ? site.params[b.param - 1] : null;
      if (!arg) break;
      const scoped = readsModuleScopeBinding(arg, ctx.checker, ctx.brandProp);
      if (scoped) {
        fail(`${TRAINER_COL} comes from unnest($${b.param}), whose argument reads \`${scoped}\`, a `
          + 'binding that outlives one test - a value every test in the group can read is a '
          + 'namespace they share');
        return;
      }
      if (isBrandedArrayType(ctx.checker, ctx.checker.getTypeAtLocation(arg), ctx.brandProp)) return;
      fail(`${TRAINER_COL} comes from unnest($${b.param}), whose argument `
        + `\`${arg.getText().slice(0, 80)}\` is not an IsolatedTrainerId[]`);
      return;
    }
  }

  fail(`${TRAINER_COL} is bound to \`${render(expr)}\`, which this cannot prove is an `
    + 'authority-issued trainer - every binding must be a branded interpolation, a branded '
    + 'parameter, or a branded unnest');
}

/**
 * R6: THE INDIRECT PATH'S PREMISE, GATED RATHER THAN ONLY MEASURED.
 *
 * `availability_slots` has two server-side creators in the frozen migration, and both write a
 * trainer aggregated from the SOURCE SLOTS the caller supplied. So the target slots inherit the
 * namespace of whatever slot ids a fixture hands the driver — and a fixture handing over ANOTHER
 * test's slot id would write into that test's namespace without ever acquiring its trainer.
 *
 * A slot id is a value exactly as a trainer id is, so the same question decides it: could this
 * value have come from another test? It could only do so by living in a binding that OUTLIVES one
 * test, which is what this refuses. What it does NOT cover — and what the runbook states rather
 * than claims away — is a slot id a fixture obtains some other way inside its own test, by asking
 * the server for one, say. Every such argument in the suite was inventoried and none does that.
 */
const APPLY_DRIVERS = new Set([
  'previewNormalized', 'applyNormalized', 'previewThenApply', 'preview', 'apply',
]);

function checkApplySourceSlots(source, rel, ctx, result) {
  const { checker } = ctx;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee)) callee = callee.name;
      const name = ts.isIdentifier(callee) ? callee.text : null;
      if (name && APPLY_DRIVERS.has(name)) {
        // THE OPTIONS ARGUMENT IS FOLLOWED, NOT MATCHED SYNTACTICALLY. Reading only an object
        // literal written inside the call left `const args = { slots: SHARED }; preview(args)`
        // unexamined — and a spread of a `const` base is the ordinary shape here besides.
        for (const arg of node.arguments) {
          for (const slots of slotsPropertiesOf(arg, checker, 0)) {
            const shared = readsAnyBindingOutsideATest(slots, checker);
            if (!shared) continue;
            const line = source.getLineAndCharacterOfPosition(slots.getStart()).line + 1;
            result.violations.push({ file: rel, line,
              detail: `the source slots handed to \`${name}\` read \`${shared}\`, a binding that `
                + 'outlives one test - the apply core derives the TARGET trainer from these slots, '
                + "so a slot another test created would write into that test's namespace" });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/**
 * Every `slots:` value an options argument can carry: written inline, reached through a `const`
 * this can follow to one object literal, or contributed by a spread of either.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is refuse an options argument it cannot follow. The drivers
 * forward each other's options (`previewNormalized(client, { ...o, targets })` inside
 * `previewThenApply`), where `o` is a parameter and the CALLER's own options were already
 * examined; refusing there would refuse the ordinary shape while proving nothing extra. The
 * residual — an options object assembled somewhere this cannot follow — is stated in the runbook
 * beside the measurement that no site does it.
 */
function slotsPropertiesOf(expr, checker, depth) {
  if (depth > 4 || !expr) return [];
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    return slotsPropertiesOf(expr.expression, checker, depth + 1);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out = [];
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'slots') {
        out.push(prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'slots') {
        out.push(prop.name);
      } else if (ts.isSpreadAssignment(prop)) {
        out.push(...slotsPropertiesOf(prop.expression, checker, depth + 1));
      }
    }
    return out;
  }
  if (ts.isIdentifier(expr)) {
    const sym = checker.getSymbolAtLocation(expr);
    const decls = (sym && sym.declarations) || [];
    if (decls.length !== 1) return [];
    const decl = decls[0];
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return [];
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return [];
    return slotsPropertiesOf(decl.initializer, checker, depth + 1);
  }
  return [];
}

/** Like `readsModuleScopeBinding`, but for values of any type — a slot id is not branded. */
function readsAnyBindingOutsideATest(expr, checker) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)
        || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root)) root = root.expression;
      if (ts.isIdentifier(root) && declaredOutsideATest(root, checker)) { found = root.text; return; }
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isIdentifier(node) && declaredOutsideATest(node, checker)) { found = node.text; return; }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * R1: outside the authority module nothing may forge the brand — IN EITHER DIRECTION.
 *
 * RESOLVED BY THE CHECKER, NOT BY SPELLING. A rule that looked for the text `IsolatedTrainerId`
 * missed an aliased import (`import { type IsolatedTrainerId as Id }` then `raw as Id`), and it
 * also missed the reverse move: casting a branded value DOWN to `string[]` and mutating the array
 * in place leaves the declared type branded while the contents are not. So both the target type
 * and the operand type are resolved and tested.
 *
 * WIDENING IS A CAST TOO. `const x: IsolatedTrainerId = somethingAny` needs no `as` at all under
 * this repository's `strict: false` — `any` is assignable to everything. A declaration whose
 * declared type is the brand must therefore be initialised by something the checker already
 * considers branded.
 */
function checkBrandContainment(source, rel, ctx, result) {
  if (rel === AUTHORITY_REL) return;
  const { checker, brandProp, fragmentProp } = ctx;
  // BOTH BRANDS. `SqlFragment` carries a runtime guarantee — the text is one SQL expression — and a
  // forged one would put that guarantee back where it was before it existed.
  const branded = (type) => isBrandedType(type, brandProp)
    || isBrandedArrayType(checker, type, brandProp)
    || isBrandedType(type, fragmentProp) || isBrandedArrayType(checker, type, fragmentProp)
    || isBrandedType(type, ctx.quotedProp) || isBrandedArrayType(checker, type, ctx.quotedProp);
  const brandedNode = (node) => !!node && branded(checker.getTypeAtLocation(node));
  const brandedTypeNode = (node) => !!node && branded(checker.getTypeFromTypeNode(node));
  const visit = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const fail = (detail) => result.violations.push({ file: rel, line, detail });
    const assertion = ts.isAsExpression(node)
      || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
      || ts.isTypeAssertionExpression(node);
    if (assertion) {
      if (brandedTypeNode(node.type)) {
        fail('a type assertion PRODUCING IsolatedTrainerId outside the authority module - the '
          + 'brand may only be minted by the authority');
      } else if (brandedNode(node.expression)) {
        fail('a type assertion that WIDENS an IsolatedTrainerId outside the authority module - '
          + 'casting the brand away leaves a value the checker still calls branded');
      }
    }
    if (ts.isVariableDeclaration(node) && node.type && brandedTypeNode(node.type)
      && node.initializer && !brandedNode(node.initializer)) {
      fail('a declaration typed as a brand whose initializer is not branded - under '
        + '`strict: false` an `any` widens into a brand with no cast at all');
    }
    // ...AND EVERY LATER WRITE TO THAT BINDING. Checking only the initializer left
    // `trainer = anyValue` and `brandedArray.push(anyValue)` retaining the branded static type.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && brandedNode(node.left) && !brandedNode(node.right)) {
      fail('an assignment of a non-branded value into a branded binding - the declared type still '
        + 'reads as branded afterwards, so the write site would accept it');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['push', 'unshift', 'splice', 'fill', 'copyWithin'].includes(node.expression.name.text)
      && isBrandedArrayType(checker, checker.getTypeAtLocation(node.expression.expression), brandProp)) {
      const args = node.arguments.filter((arg, k) =>
        !(node.expression.name.text === 'splice' && k < 2)
        && !(node.expression.name.text === 'fill' && k > 0)
        && !(node.expression.name.text === 'copyWithin'));
      if (args.some((arg) => !brandedNode(arg))) {
        fail('an in-place mutation putting a non-branded value into a branded array - the array\'s '
          + 'declared type is unchanged, so an unnest over it would still be accepted');
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
  const { params, isQueryCall } = paramExpressions(node);
  const site = { file: rel, line, params, isQueryCall };
  ctx.holes = [];

  const texts = expansionsOf(node, ctx);
  if (texts === null) {
    if (node.getText().toLowerCase().includes(TABLE)) {
      result.violations.push({ file: rel, line,
        detail: `a literal naming ${TABLE} expands into more than ${MAX_EXPANSIONS} texts - `
          + 'refused rather than sampled' });
    }
    return;
  }

  for (const text of texts) analyseSqlText(text, site, rel, line, ctx, result, 0);
}

/**
 * One SQL text: lex it, split it, classify every statement — and then do the same to every
 * DOLLAR-QUOTED BODY it contains, because such a body is SQL that really executes.
 *
 * A NESTED BODY HAS NO CLIENT PARAMETERS. `$1` inside a PL/pgSQL body is that routine's argument,
 * not something `pg` binds, so `site.params` is dropped on the way down and a `$k` trainer binding
 * inside a body is refused rather than resolved against the wrong array.
 */
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
    if (text.toLowerCase().includes(TABLE)) {
      result.violations.push({ file: rel, line,
        detail: `a literal naming ${TABLE} could not be lexed as SQL (${e.message}) - refused` });
    }
    return;
  }
  const inner = depth === 0 ? site : { ...site, params: null };
  // A DOLLAR-QUOTED BODY IS ALWAYS READ. A PLAIN string is read only where SQL puts one in an
  // EXECUTABLE position — `EXECUTE '…'` and `CREATE … FUNCTION … AS '…'` — because reading every
  // string constant as SQL would refuse ordinary data that merely reads like a statement.
  for (let k = 0; k < lexed.tokens.length; k += 1) {
    const tok = lexed.tokens[k];
    if (tok.kind === 'dollar') {
      analyseSqlText(String(tok.value), inner, rel, line, ctx, result, depth + 1);
      continue;
    }
    if (tok.kind !== 'string') continue;
    const prev = lexed.tokens[k - 1];
    const executable = isWord(prev, 'execute')
      || (isWord(prev, 'as') && lexed.tokens.slice(0, k).some((t) => isWord(t, 'function')
        || isWord(t, 'procedure')));
    if (executable) analyseSqlText(String(tok.value), inner, rel, line, ctx, result, depth + 1);
  }
  {
    for (const { toks, from, to } of splitStatements(lexed.tokens, text.length)) {
      // THE MARKER EXEMPTS THE STATEMENT IT IS WRITTEN IN, and only that one. A literal-wide flag
      // would let a marker on the census control exempt a second statement beside it, which is
      // exactly the over-reach the retired scan's 2,200-character window had.
      const exempt = lexed.comments.some(
        (cm) => cm.text.includes(EXEMPTION_MARKER) && cm.pos >= from && cm.pos < to);
      if (exempt) {
        // ONE EXEMPTION IS ONE WRITE. The marker suppresses the binding rule for the statement it
        // is written in, so a data-modifying CTE carrying several writes would spend one exemption
        // and one inventory slot on all of them. Counted, and more than one is refused.
        const writes = countWritesToTable(toks);
        if (writes > 1) {
          result.violations.push({ file: rel, line,
            detail: `an exempt statement carries ${writes} writes to ${TABLE} - an exemption `
              + 'covers ONE deliberate write, not a statement that can hold any number' });
          continue;
        }
        if (writes === 1) {
          result.exemptions.push({ file: rel, line });
          result.writeSites.add(`${rel}:${line}:exempt`);
        }
        continue;
      }
      analyseStatement(toks, inner, ctx, result);
    }
  }
}

/**
 * THE SCOPE CANNOT DRIFT SILENTLY. This guard reads two named files, and that is a bounded claim
 * only while no OTHER file of the same suite family writes the guarded table behind its back. So
 * every `src/test/abc27*` file outside the program is checked — coarsely and deliberately: this is
 * a tripwire that says "put this file in the program", not a classification. A new ABC-27 file
 * that writes `availability_slots` is a deliberate edit to `analyze`'s file list, or it is a
 * refusal.
 */
function checkScopeDrift(fileNames, repoRoot, result) {
  const root = path.join(repoRoot, 'src', 'test');
  if (!fs.existsSync(root)) return;
  const inProgram = new Set(fileNames.map((f) => path.resolve(f)));
  // THE VERB ALONE. This is a tripwire whose only demand is "put this file in the program", so
  // anything cleverer than the four verbs is a way for it to miss — `INSERT--x\nINTO` and
  // `MERGE/**/INTO` both defeated a pattern that insisted on seeing the `INTO`.
  const WRITE_VERB = /\b(insert|update|merge|copy)\b/i;
  // RECURSIVE AND CASE-INSENSITIVE. A file in a subdirectory is as much part of the suite family
  // as one beside it, and SQL keywords and identifiers fold case.
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out.push(...walk(full)); continue; }
      if (/^abc27.*\.tsx?$/i.test(entry.name)) out.push(full);
    }
    return out;
  };
  for (const full of walk(root)) {
    if (inProgram.has(path.resolve(full))) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.toLowerCase().includes(TABLE) || !WRITE_VERB.test(text)) continue;
    result.violations.push({ file: path.relative(repoRoot, full).replace(/\\/g, '/'), line: 0,
      detail: `this ABC-27 file names ${TABLE} beside a write verb but is OUTSIDE the guard's `
        + 'program, so none of its write sites are proved — add it to the analysed file list '
        + 'deliberately, or the scope of this guard is narrower than it reads' });
  }
}

/** The whole analysis. Files are injected so the self-test can point it at fixtures. */
export function analyze({ files, repoRoot = REPO_ROOT } = {}) {
  const fileNames = files || [AUTHORITY_REL, SUITE_REL, SELFTEST_REL]
    .map((rel) => path.join(repoRoot, rel));
  const result = { violations: [], writeSites: new Set(), exemptions: [] };
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
  const fragmentProp = brandPropertyName(checker, authoritySource, 'SqlFragment', 'sqlFragmentBrand');
  const quotedProp = brandPropertyName(checker, authoritySource, 'SqlQuotedLiteral', 'sqlQuotedBrand');
  if (!brandProp || !fragmentProp || !quotedProp) {
    result.violations.push({ file: AUTHORITY_REL, line: 0,
      detail: `a brand could not be read from the authority module (IsolatedTrainerId: `
        + `${brandProp ? 'ok' : 'MISSING'}, SqlFragment: ${fragmentProp ? 'ok' : 'MISSING'}, `
        + `SqlQuotedLiteral: ${quotedProp ? 'ok' : 'MISSING'}) - `
        + 'without it every binding would resolve as unbranded, so this refuses outright rather '
        + 'than reporting a flood of violations or, worse, a pass' });
    return result;
  }
  const ctx = { checker, brandProp, fragmentProp, quotedProp, repoRoot };

  for (const f of fileNames) {
    const source = program.getSourceFile(f);
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    if (!source) {
      result.violations.push({ file: rel, line: 0, detail: 'the file is not part of the program' });
      continue;
    }
    checkBrandContainment(source, rel, ctx, result);
    checkApplySourceSlots(source, rel, ctx, result);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateExpression(node) || isOutermostConcatenation(node)) {
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
  const seenEx = new Set();
  result.exemptions = result.exemptions.filter((e) => {
    const key = `${e.file}:${e.line}`;
    if (seenEx.has(key)) return false;
    seenEx.add(key);
    return true;
  });
  return result;
}

// ── THE CLI ───────────────────────────────────────────────────────────────────────────────────

export function main({ log = console.log, err = console.error, repoRoot = REPO_ROOT } = {}) {
  const { violations, writeSites, exemptions } = analyze({ repoRoot });
  const siteCount = writeSites.size;

  if (violations.length > 0) {
    err(`\n❌ ABC-27 trainer source authority — ${violations.length} refusal(s):\n`);
    for (const v of violations) err(`  ${v.file}:${v.line}  ${v.detail}`);
    err('\nEvery write to public.availability_slots in this suite must bind trainer_id to an');
    err('IsolatedTrainerId issued by src/test/abc27TrainerAuthority.ts. A construction this cannot');
    err('classify is refused rather than skipped — that is the whole difference between this and');
    err('the source scan it replaced.');
    return 1;
  }
  if (exemptions.length !== EXPECTED_EXEMPTIONS) {
    err(`\n❌ ABC-27 trainer source authority — ${exemptions.length} ${EXEMPTION_MARKER} `
      + `exemption(s), expected exactly ${EXPECTED_EXEMPTIONS}.`);
    for (const e of exemptions) err(`  ${e.file}:${e.line}`);
    err('\nThe one permitted exemption is the census control, which writes a shared-namespace slot');
    err('on purpose and rolls it back. A second one is not an exemption, it is a hatch.');
    return 1;
  }
  if (siteCount !== EXPECTED_WRITE_SITES) {
    err(`\n❌ ABC-27 trainer source authority — ${siteCount} slot-write site(s), expected `
      + `exactly ${EXPECTED_WRITE_SITES}:`);
    for (const s of [...writeSites].sort()) err(`  ${s}`);
    err('\nThis is a TRIPWIRE, not the proof: rule R2 is what proves the bindings. Adding or');
    err('removing a write site is a deliberate edit that must restate this number.');
    return 1;
  }
  log(`✅ ABC-27 trainer source authority — ${siteCount} slot-write site(s), every `
    + `trainer_id bound to an authority-issued IsolatedTrainerId (${exemptions.length} declared `
    + 'exemption: the census control).');
  return 0;
}

// ── THE SELF-TEST ─────────────────────────────────────────────────────────────────────────────
//
// The mutation evidence for the guard itself. Every ADVERSARIAL fixture must be REFUSED and every
// CLEAN one ACCEPTED; weaken the lexer, the resolver or a binding rule and a named fixture below
// stops discriminating. The reviewer's own escapes from the retired source scan are fixtures by
// name, so "the approach was replaced" is a claim with evidence attached rather than an assertion.
//
// ONE PROGRAM FOR ALL OF THEM. Each fixture is its own file in one `ts.createProgram`, and the
// verdicts are partitioned by file afterwards — a program per fixture re-parsed the authority
// module forty times for no additional discrimination.

/** The fixture prelude. `c` is `any` so the fixtures depend on no database typings at all. */
const FIXTURE_PRELUDE = [
  "import { declareTrainers, mintTrainerRange, newTrainerId, sqlFragment, sqlUuid, testTrainer,",
  "  type IsolatedTrainerId } from '../src/test/abc27TrainerAuthority';",
  'declare const c: any;',
  "const ACADEMY = '11111111-1111-4111-8111-111111111111';",
  "const RAW = '55555555-5555-4555-8555-555555555555';",
  'export async function fixture() {',
].join('\n');

const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);

/**
 * The corpus. `verdict` is what the guard must say; `why` is what the fixture is evidence FOR.
 * Exported so the vitest unit selftest drives exactly these, rather than a second copy that could
 * drift away from the one CI runs.
 */
export const FIXTURES = [
  // ── The clean control. If this ever refuses, every "refused" verdict below means nothing.
  { name: 'clean', verdict: 'accept',
    why: 'a branded interpolation is the sanctioned form',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots
    (id,trainer_id,academy_profile_id,start_time,end_time,max_participants)
    VALUES (gen_random_uuid(),'\${await testTrainer(c)}','\${ACADEMY}',
            now(),now()+interval '1 hour',4)${BT});` },

  // ── The three sanctioned bindings, each accepted on its own.
  { name: 'param-branded', verdict: 'accept', why: 'a $k bound to a branded argument',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    VALUES ($1,$2)${BT}, [await newTrainerId(c), ACADEMY]);` },
  { name: 'unnest-branded', verdict: 'accept', why: 'unnest of a branded array',
    body: `  const range = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 3);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    SELECT t.id, $2 FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT}, [range, ACADEMY]);` },
  { name: 'update-branded', verdict: 'accept', why: 'an UPDATE binding a branded interpolation',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET trainer_id = '\${await newTrainerId(c)}'
    WHERE id = $1${BT}, ['x']);` },
  { name: 'declared-array-branded', verdict: 'accept',
    why: 'a list of ids adopted through declareTrainers is branded',
    body: `  const many = await declareTrainers(c, ['a', 'b']);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT u.id FROM unnest($1::uuid[]) AS u(id)${BT}, [many]);` },

  // ── M3: a literal UUID at a write site. THIS IS ALSO THE REGRESSION CONTROL FOR THE BRAND
  //    LOOKUP: `string` carries `__@iterator@N`, so a brand test that took the first `__@…`
  //    property found `Symbol.iterator` and called EVERY string branded — under that bug this
  //    fixture is accepted and the guard proves nothing at all.
  { name: 'm3-literal-uuid', verdict: 'refuse', why: 'a const-bound literal UUID is not branded',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots
    (id,trainer_id,academy_profile_id) VALUES (gen_random_uuid(),'\${RAW}','\${ACADEMY}')${BT});` },

  // ── M2 / M11: laundering through `as` and through `any`.
  { name: 'm2-as-cast', verdict: 'refuse',
    why: 'an `as` producing the brand outside the authority module',
    body: `  const forged = RAW as unknown as IsolatedTrainerId;
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${forged}')${BT});` },
  { name: 'm11-any', verdict: 'refuse', why: '`any` carries no brand, so it is refused by default',
    body: `  const anything: any = c.pick();
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${anything}')${BT});` },

  // ── M8: the server-picked trainer — the exact shape that survived the retired source scan.
  { name: 'm8-server-pick', verdict: 'refuse',
    why: 'a server-chosen row is not an authority-issued trainer',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    SELECT t.id, $1 FROM public.trainer_profiles t LIMIT 1${BT}, [ACADEMY]);` },

  // ── M9: the SQL-side mint this batch removed.
  { name: 'm9-sql-mint', verdict: 'refuse',
    why: 'an id minted inside SQL is a trainer source no type can reach',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    SELECT ('9e0f9e0f-0000-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid, $1
      FROM generate_series(1,3) AS g(i)${BT}, [ACADEMY]);` },
  { name: 'm9-unnest-unbranded', verdict: 'refuse',
    why: 'an unnest whose array is a plain string[] is not a branded source',
    body: `  const plain: string[] = ['a', 'b'];
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT t.id FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT}, [plain]);` },
  { name: 'm9-unnest-ordinality-column', verdict: 'refuse',
    why: 'binding the ORDINALITY column rather than the value is not the branded source',
    body: `  const range = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 3);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT t.i FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, i)${BT}, [range]);` },

  // ── M13: a trainer-moving UPDATE, and its unbranded parameter twin.
  { name: 'm13-update-random', verdict: 'refuse',
    why: 'an UPDATE moving a slot onto a server-minted trainer',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET trainer_id = gen_random_uuid()${BT});` },
  { name: 'm13-update-param', verdict: 'refuse',
    why: 'an UPDATE binding trainer_id to an unbranded parameter',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET trainer_id=$1 WHERE id=$2${BT},
    [RAW, 'x']);` },

  // ── M4: the obfuscated spellings the reviewer named, each its own fixture.
  { name: 'm4-comment-split', verdict: 'refuse',
    why: 'a comment between the verb and the table does not hide the statement',
    body: `  await c.query(${BT}INSERT/**/INTO/**/public.availability_slots(trainer_id) VALUES ('\${RAW}')${BT});` },
  { name: 'm4-nested-comment', verdict: 'refuse',
    why: 'PostgreSQL block comments NEST, so a naive stripper resumes inside one',
    body: `  await c.query(${BT}/* outer /* inner */ still a comment */ INSERT INTO public.availability_slots(trainer_id)
    VALUES ('\${RAW}')${BT});` },
  { name: 'm4-lowercase-spacing', verdict: 'refuse',
    why: 'case, spacing, ONLY and quoting are all the same statement',
    body: `  await c.query(${BT}insert   into   ONLY   "public" . "availability_slots" (trainer_id)
    values ('\${RAW}')${BT});` },
  { name: 'm4-unicode-escape', verdict: 'refuse',
    why: 'a U&"..." escape names the same relation',
    body: `  await c.query("INSERT INTO U&${BS}"availability${BS}${BS}005Fslots${BS}"(trainer_id) VALUES ('" + RAW + "')");` },
  { name: 'm4-merge', verdict: 'refuse', why: 'MERGE is refused outright',
    body: `  await c.query(${BT}MERGE INTO public.availability_slots t USING src ON true
    WHEN NOT MATCHED THEN INSERT (trainer_id) VALUES ('\${RAW}')${BT});` },
  { name: 'm4-copy', verdict: 'refuse', why: 'COPY is refused outright',
    body: `  await c.query(${BT}COPY public.availability_slots (trainer_id) FROM STDIN${BT});` },
  { name: 'm4-split-literal', verdict: 'refuse',
    why: 'a statement assembled from two literals is still one statement',
    body: `  await c.query("INSERT INTO public.avail" + "ability_slots(trainer_id) VALUES ('" + RAW + "')");` },
  { name: 'm4-second-statement', verdict: 'refuse',
    why: 'a write hiding behind a leading transaction command',
    body: `  await c.query(${BT}BEGIN; INSERT INTO public.availability_slots(trainer_id) VALUES ('\${RAW}')${BT});` },

  // ── R3: an unresolvable interpolation may not hide the structure.
  { name: 'update-set-multi-column-form', verdict: 'refuse',
    why: 'a multi-column `(a, b) = (…)` SET form is a structure this cannot position, with no '
      + 'interpolation involved at all',
    body: `  await c.query(${BT}UPDATE public.availability_slots
    SET (court_type, training_level) = ('outdoor', 'C') WHERE id = $1${BT}, ['x']);` },
  { name: 'r3-hole-set-clause', verdict: 'refuse',
    why: 'a SET clause that is entirely an unresolvable hole could carry a trainer assignment',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}UPDATE public.availability_slots SET \${bag.m} WHERE id=$1${BT}, ['x']);` },
  { name: 'r3-hole-column-list', verdict: 'refuse',
    why: 'an unresolvable column list cannot be positioned',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots (\${bag.cols})
    VALUES ('\${await testTrainer(c)}')${BT});` },
  { name: 'r3-hole-table-name', verdict: 'refuse',
    why: 'a relation assembled from a hole cannot be shown not to be this one',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO \${bag.rel}(trainer_id) VALUES ('\${await testTrainer(c)}')
    -- availability_slots${BT});` },
  { name: 'r3-hole-trainer-value', verdict: 'refuse', why: 'an unresolvable trainer value',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,academy_profile_id)
    VALUES ('\${bag.t}','\${ACADEMY}')${BT});` },
  { name: 'r3-arity-mismatch', verdict: 'refuse',
    why: 'fewer expressions than columns means the trainer position is not decidable',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id,trainer_id,academy_profile_id)
    VALUES (gen_random_uuid(),'\${await testTrainer(c)}')${BT});` },
  { name: 'r3-no-column-list', verdict: 'refuse', why: 'no column list, so no position',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots VALUES (gen_random_uuid(),'\${RAW}')${BT});` },
  { name: 'r3-unterminated', verdict: 'refuse',
    why: 'a literal naming the table that will not lex is refused, not skipped',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${RAW}${BT});` },
  { name: 'r3-param-without-array', verdict: 'refuse',
    why: 'a $k whose argument array cannot be read is not a typed value',
    body: `  const sql = ${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ($1)${BT};
  await c.query(sql, [await testTrainer(c)]);` },
  // AN OPAQUE ATOM IN A NON-TRAINER VALUE IS REFUSED TOO. The first version of this reader
  // admitted one, arguing that PostgreSQL refuses a row with more expressions than columns. That
  // argument is wrong: a fragment can close its row and open another of exactly the right arity.
  { name: 'r3-hole-in-a-non-trainer-value', verdict: 'refuse',
    why: 'an opaque fragment can close the VALUES row and open another with a trainer of its own',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,court_type,academy_profile_id)
    VALUES ('\${await testTrainer(c)}',\${bag.court ?? "'indoor'"},'\${ACADEMY}')${BT});` },
  { name: 'validated-fragment-in-a-non-trainer-value', verdict: 'accept',
    why: 'the same fragment is accepted once sqlFragment() has proved it is ONE expression',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,court_type,academy_profile_id)
    VALUES ('\${await testTrainer(c)}',\${sqlFragment(bag.court ?? "'indoor'")},'\${ACADEMY}')${BT});` },
  { name: 'validated-fragment-may-not-be-the-trainer', verdict: 'refuse',
    why: 'a validated fragment is inert, not owned - it may not stand in for the trainer itself',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    VALUES (\${sqlFragment(bag.t ?? "'x'")})${BT});` },

  // ── The upsert arm and every arm of a set operation.
  { name: 'on-conflict-do-update-trainer', verdict: 'refuse',
    why: 'ON CONFLICT DO UPDATE SET trainer_id lives entirely past the VALUES list',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id,trainer_id)
    VALUES ($1,'\${await testTrainer(c)}')
    ON CONFLICT (id) DO UPDATE SET trainer_id = '\${RAW}'${BT}, ['x']);` },
  { name: 'on-conflict-do-nothing-is-fine', verdict: 'accept',
    why: 'and DO NOTHING assigns nothing, so it is not a trainer binding',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id,trainer_id)
    VALUES ($1,'\${await testTrainer(c)}') ON CONFLICT (id) DO NOTHING${BT}, ['x']);` },
  { name: 'second-union-arm', verdict: 'refuse',
    why: 'every arm of a set operation projects onto the same column list, so every arm is checked',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT '\${await testTrainer(c)}'
    UNION ALL SELECT '\${RAW}'${BT});` },

  // ── The for-of resolution, which is what keeps the mutation matrices classifiable.
  { name: 'forof-resolved', verdict: 'accept',
    why: 'a for-of over an array of resolvable literals expands to real statements',
    body: `  const t = await newTrainerId(c);
  for (const mutation of [${BT}trainer_id = '\${t}'${BT}, ${BT}court_type = 'outdoor'${BT}]) {
    await c.query(${BT}UPDATE public.availability_slots SET \${mutation} WHERE id=$1${BT}, ['x']);
  }` },
  { name: 'forof-unbranded', verdict: 'refuse',
    why: 'the expansion is checked, so an unbranded arm inside it is refused',
    body: `  for (const mutation of [${BT}trainer_id = '\${RAW}'${BT}, ${BT}court_type = 'outdoor'${BT}]) {
    await c.query(${BT}UPDATE public.availability_slots SET \${mutation} WHERE id=$1${BT}, ['x']);
  }` },
  { name: 'forof-destructured-unbranded', verdict: 'refuse',
    why: 'a destructured for-of binding is followed too, so it cannot launder an arm',
    body: `  const cases: Array<[string, string]> = [['t', ${BT}trainer_id = '\${RAW}'${BT}]];
  for (const [name, mutation] of cases) {
    await c.query(${BT}UPDATE public.availability_slots SET \${mutation} WHERE id=$1${BT}, [name]);
  }` },

  // ── The exemption is per STATEMENT, and a data-modifying CTE can hold two writes.
  { name: 'exempt-marker-does-not-cover-a-second-statement', verdict: 'refuse',
    why: 'a marker exempts the statement it is written in, not everything beside it',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots -- SHARED_NAMESPACE_CONTROL
    (trainer_id) VALUES ($1);
    INSERT INTO public.availability_slots(trainer_id) VALUES ('\${RAW}')${BT}, [RAW]);` },
  { name: 'two-writes-in-one-statement', verdict: 'refuse',
    why: 'a data-modifying CTE carrying two writes has BOTH examined, not just the first',
    body: `  await c.query(${BT}WITH s AS (
      INSERT INTO public.availability_slots(trainer_id) VALUES ('\${await testTrainer(c)}')
      RETURNING id)
    INSERT INTO public.availability_slots(trainer_id) SELECT '\${RAW}' FROM s${BT});` },

  // ── A literal that is not a `.query()` argument at all — the shape a `mustRaise` helper takes.
  { name: 'non-query-literal', verdict: 'refuse',
    why: 'literals are classified wherever they are written, not only as query arguments',
    body: `  const sql = ${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${RAW}')${BT};
  await Promise.resolve(sql);` },

  // ── SOUNDNESS. Over-refusing is a defect too: a guard nobody can satisfy gets deleted.
  { name: 'string-not-statement', verdict: 'accept',
    why: 'a table name inside a SQL string literal names nothing',
    body: `  await c.query(${BT}SELECT to_regclass('public.availability_slots') IS NOT NULL AS armed${BT});
  await c.query(${BT}SELECT 'INSERT INTO availability_slots' AS harmless${BT});` },
  { name: 'dollar-body-is-sql', verdict: 'refuse',
    why: 'a dollar-quoted body is SQL that executes, so it is read rather than swallowed',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz() RETURNS trigger LANGUAGE plpgsql AS $zz$
    BEGIN
      UPDATE public.availability_slots SET trainer_id = '\${RAW}' WHERE id = NEW.id;
      RETURN NEW;
    END $zz$${BT});` },
  { name: 'execute-string-is-sql', verdict: 'refuse',
    why: 'a string in an EXECUTABLE position is SQL that runs, even without dollar quotes',
    body: `  await c.query(${BT}DO $do$ BEGIN
      EXECUTE 'UPDATE public.availability_slots SET trainer_id = ''\${RAW}''';
    END $do$${BT});` },
  { name: 'create-function-as-string-body', verdict: 'refuse',
    why: "and a function body written as an ordinary string is a body, not data",
    body: `  await c.query(${BT}CREATE FUNCTION public.zz() RETURNS void LANGUAGE sql
    AS 'UPDATE public.availability_slots SET trainer_id = ''\${RAW}'''${BT});` },
  { name: 'dollar-body-branded-is-fine', verdict: 'accept',
    why: 'and a body binding a branded trainer is accepted, so the rule is about the value',
    body: `  await c.query(${BT}CREATE FUNCTION public.zz() RETURNS trigger LANGUAGE plpgsql AS $zz$
    BEGIN
      UPDATE public.availability_slots SET trainer_id = '\${await testTrainer(c)}' WHERE id = NEW.id;
      RETURN NEW;
    END $zz$${BT});` },
  { name: 'reads-are-not-writes', verdict: 'accept',
    why: 'reads, deletes and non-trainer updates are not trainer bindings',
    body: `  await c.query(${BT}SELECT trainer_id FROM public.availability_slots WHERE id=$1${BT}, ['x']);
  await c.query(${BT}DELETE FROM public.availability_slots WHERE id=$1${BT}, ['x']);
  await c.query(${BT}UPDATE public.availability_slots SET start_time=now() WHERE id=$1${BT}, ['x']);
  await c.query(${BT}INSERT INTO public.bookings(slot_id) VALUES ($1)${BT}, ['x']);` },
  { name: 'other-table-is-not-ours', verdict: 'accept',
    why: 'an unresolvable hole in another table is none of this guard business',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}UPDATE public.bookings SET \${bag.m} WHERE id=$1${BT}, ['x']);` },
  { name: 'numeric-hole-is-inert', verdict: 'accept',
    why: 'a number cannot contribute a keyword, an identifier or a comma',
    body: `  const lane = 3;
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,start_time)
    VALUES ('\${await testTrainer(c)}', now() + make_interval(hours => \${lane}))${BT});` },
  { name: 'no-trainer-column', verdict: 'accept',
    why: 'an INSERT that never names trainer_id claims no namespace',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id,academy_profile_id)
    VALUES (gen_random_uuid(),'\${ACADEMY}')${BT});` },

  // ── The module-scope rule: the brand proves ORIGIN, not ownership.
  { name: 'module-scope-branded-const', verdict: 'refuse',
    why: 'a branded value acquired at module scope is one namespace every test in the file shares',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    VALUES ('\${SHARED_TRAINER}')${BT});`,
    tail: 'export const SHARED_TRAINER = await newTrainerId(c);' },
  { name: 'module-scope-branded-property', verdict: 'refuse',
    why: 'a branded value held in a module-scope object is the same shared namespace',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    VALUES ('\${SHARED_STATE.trainer}')${BT});`,
    tail: 'export const SHARED_STATE = { trainer: await newTrainerId(c) };' },
  { name: 'module-scope-branded-param', verdict: 'refuse',
    why: 'and the same value reaching a $k argument is refused there too',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ($1)${BT},
    [SHARED_TRAINER2]);`,
    tail: 'export const SHARED_TRAINER2 = await newTrainerId(c);' },

  // ── The `$k` array must be the one the driver binds.
  { name: 'params-not-a-query-call', verdict: 'refuse',
    why: 'a wrapper can present one array here and forward another to client.query',
    body: `  const send = async (sql: string, params: unknown[]) => c.query(sql, params.slice(1));
  await send(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ($1)${BT},
    [await newTrainerId(c)]);` },

  // ── Ambiguity in `unnest` provenance is a refusal, not a guess.
  { name: 'unnest-alias-ambiguous', verdict: 'refuse',
    why: 'two unnest bindings sharing an alias cannot be told apart by alias',
    // THE BRANDED ONE IS FIRST ON PURPOSE. With the ambiguity rule removed the reader takes the
    // first alias match and accepts, so this fixture is only discriminating in this order — the
    // other way round it is refused by the argument-type rule and proves nothing about ambiguity.
    body: `  const good = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 2);
  const bad: string[] = ['x'];
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT t.id FROM unnest($1::uuid[]) AS t(id)
    UNION ALL SELECT t.id FROM unnest($2::uuid[]) AS t(id)${BT}, [good, bad]);` },

  // ── An exemption covers ONE deliberate write.
  { name: 'exempt-statement-with-two-writes', verdict: 'refuse',
    why: 'a marked data-modifying CTE would otherwise spend one exemption on any number of writes',
    body: `  await c.query(${BT}WITH s AS ( -- SHARED_NAMESPACE_CONTROL
      INSERT INTO public.availability_slots(trainer_id) VALUES ('\${RAW}') RETURNING id)
    INSERT INTO public.availability_slots(trainer_id) SELECT '\${RAW}' FROM s${BT});` },

  // ── An UPDATE's SET clause admits no opaque atom at all.
  { name: 'update-set-atom-in-a-non-trainer-value', verdict: 'refuse',
    why: 'a SET list has no expression count for PostgreSQL to refuse, so an atom could add an assignment',
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}UPDATE public.availability_slots SET court_type = \${bag.court}
    WHERE id = $1${BT}, ['x']);` },

  // ── R6: the apply path's source slots decide the TARGET trainer.
  { name: 'apply-slots-from-a-shared-binding', verdict: 'refuse',
    why: "a slot another test created would make the apply core write into that test's namespace",
    body: `  await previewThenApply(c, { slots: SHARED_SLOTS, children: [] });`,
    tail: "export const SHARED_SLOTS: string[] = [];\n"
      + 'declare function previewThenApply(cl: unknown, o: Record<string, unknown>): Promise<void>;' },
  { name: 'apply-slots-from-a-local', verdict: 'accept',
    why: 'and a locally created series is the ordinary, permitted case',
    body: `  const mine: string[] = [];
  await previewThenApply(c, { slots: mine, children: [] });`,
    tail: 'declare function previewThenApply(cl: unknown, o: Record<string, unknown>): Promise<void>;' },

  // ── The lifetime rule is about OUTLIVING A TEST, not about module scope.
  { name: 'describe-scope-branded-const', verdict: 'refuse',
    why: 'a describe callback body runs ONCE at collection, so every test in it reads one value',
    body: `  await Promise.resolve(0);`,
    // RUNNABLE VITEST CODE, not merely parseable: the callback is `async` because it awaits, which
    // a review round caught it not being. A fixture that could never run is a fixture whose
    // verdict is about a shape the suite cannot contain.
    tail: `describe('group', async () => {
  const groupTrainer = await newTrainerId(c);
  it('one', async () => {
    await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
      VALUES ('\${groupTrainer}')${BT});
  });
});
declare function describe(name: string, fn: () => unknown): void;
declare function it(name: string, fn: () => Promise<void>): void;` },
  { name: 'describe-scope-iife-branded-const', verdict: 'refuse',
    why: 'an IIFE runs where it is written, so a binding INSIDE one in a describe body is shared too',
    body: `  await Promise.resolve(0);`,
    // THE BINDING IS INSIDE THE IIFE, not beside it — otherwise the plain describe-body rule
    // catches it and the fixture says nothing about walking past an immediately-invoked function.
    tail: `describe('group2', async () => {
  const write = await (async () => {
    const groupTrainer = await newTrainerId(c);
    return async () => {
      await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
        VALUES ('\${groupTrainer}')${BT});
    };
  })();
  it('one', async () => { await write(); });
});
declare function describe(name: string, fn: () => unknown): void;
declare function it(name: string, fn: () => Promise<void>): void;` },
  { name: 'helper-local-branded-const', verdict: 'accept',
    why: 'and a local of an ordinary helper is per call, so it belongs to whichever test called it',
    body: `  await Promise.resolve(0);`,
    tail: `export async function helper() {
  const mine = await newTrainerId(c);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${mine}')${BT});
}` },

  // ── A fragment is proved to be ONE EXPRESSION, which is not a promise about static quotes.
  { name: 'fragment-inside-quotes', verdict: 'refuse',
    why: "sqlFragment(\"x', 'y\") is one expression, and '\u0078', 'y' is two",
    body: `  const bag: Record<string, string> = {};
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,court_type)
    VALUES ('\${await testTrainer(c)}','\${sqlFragment(bag.court ?? 'indoor')}')${BT});` },
  { name: 'uuid-inside-quotes', verdict: 'accept',
    why: 'a canonical UUID contains only hex and hyphens, so it is safe quoted or unquoted',
    body: `  await c.query(${BT}UPDATE public.availability_slots SET court_type = 'x'
    WHERE id = '\${sqlUuid(RAW)}'${BT});` },

  // ── The upsert arm is read even when the INSERT itself never names the trainer.
  { name: 'on-conflict-without-a-trainer-column', verdict: 'refuse',
    why: 'the upsert arm assigns a trainer whether or not the INSERT column list names one',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(id) VALUES ($1)
    ON CONFLICT (id) DO UPDATE SET trainer_id = '\${RAW}'${BT}, ['x']);` },

  // ── A set-operation arm this reader has no projection for is refused, not skipped.
  { name: 'union-values-arm', verdict: 'refuse',
    why: 'a VALUES arm contributes rows with a trainer no SELECT-list scan would locate',
    body: `  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT '\${await testTrainer(c)}'
    UNION ALL VALUES ('\${RAW}')${BT});` },

  // ── The apply options object is FOLLOWED, not matched where it happens to be written.
  { name: 'apply-slots-through-a-const-options-object', verdict: 'refuse',
    why: 'an options object bound to a const is the same options object',
    body: `  const args = { slots: SHARED_SLOTS2, children: [] };
  await previewThenApply(c, args);`,
    tail: "export const SHARED_SLOTS2: string[] = [];\n"
      + 'declare function previewThenApply(cl: unknown, o: Record<string, unknown>): Promise<void>;' },
  { name: 'apply-slots-through-a-spread', verdict: 'refuse',
    why: 'and a spread of a shared base carries its slots just as plainly',
    body: `  const base = { slots: SHARED_SLOTS3 };
  await previewThenApply(c, { ...base, children: [] });`,
    tail: "export const SHARED_SLOTS3: string[] = [];\n"
      + 'declare function previewThenApply(cl: unknown, o: Record<string, unknown>): Promise<void>;' },


  // ── R1: brand containment, every forgery the type system leaves open.
  { name: 'r1-as', verdict: 'refuse', why: 'an `as` producing the brand',
    body: `  const x = RAW as IsolatedTrainerId;
  await Promise.resolve(x);` },
  { name: 'r1-satisfies', verdict: 'refuse', why: 'a `satisfies` naming the brand',
    body: `  const x = (RAW as unknown) satisfies IsolatedTrainerId;
  await Promise.resolve(x);` },
  { name: 'r1-array-cast', verdict: 'refuse', why: 'an `as` producing an array of the brand',
    body: `  const xs = ['a'] as unknown as IsolatedTrainerId[];
  await Promise.resolve(xs);` },
  { name: 'r1-aliased-import-cast', verdict: 'refuse',
    why: 'an aliased type import defeats a rule that looks for the brand by spelling',
    body: `  const forged = RAW as unknown as Aliased;
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${forged}')${BT});`,
    tail: "import type { IsolatedTrainerId as Aliased } from '../src/test/abc27TrainerAuthority';" },
  { name: 'r1-widening-cast-away', verdict: 'refuse',
    why: 'casting the brand AWAY leaves a value the checker still calls branded',
    body: `  const mine = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 2);
  (mine as unknown as string[]).push(RAW);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT t.id FROM unnest($1::uuid[]) AS t(id)${BT}, [mine]);` },
  { name: 'r1-assignment-after-declaration', verdict: 'refuse',
    why: 'checking only the initializer left a later assignment retaining the branded type',
    body: `  let mine = await newTrainerId(c);
  mine = c.pick();
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${mine}')${BT});` },
  { name: 'r1-array-mutation-after-declaration', verdict: 'refuse',
    why: 'and an in-place push leaves the array\u2019s declared type branded',
    body: `  const mine = await mintTrainerRange(c, '9e0f9e0f-0000-4000-8000-', 2);
  mine.push(RAW as never);
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id)
    SELECT t.id FROM unnest($1::uuid[]) AS t(id)${BT}, [mine]);` },
  { name: 'r1-fragment-cast', verdict: 'refuse',
    why: 'the fragment brand carries a runtime guarantee, so forging one puts that guarantee back',
    body: `  const forged = "x), ('foreign'" as unknown as SqlFragment;
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id,court_type)
    VALUES ('\${await testTrainer(c)}',\${forged})${BT});`,
    tail: "import type { SqlFragment } from '../src/test/abc27TrainerAuthority';" },
  { name: 'r1-any-widens-into-the-brand', verdict: 'refuse',
    why: 'under strict:false an `any` reaches a brand-typed declaration with no cast at all',
    body: `  const forged: IsolatedTrainerId = c.pick();
  await c.query(${BT}INSERT INTO public.availability_slots(trainer_id) VALUES ('\${forged}')${BT});` },
  { name: 'r1-brand-symbol', verdict: 'refuse',
    why: 'a re-declaration of the brand symbol outside the authority module',
    body: `  const isolatedTrainerBrand = Symbol();
  await Promise.resolve(isolatedTrainerBrand);` },
  { name: 'r1-redeclare', verdict: 'refuse',
    why: 'a re-declaration of IsolatedTrainerId outside the authority module',
    body: '  await Promise.resolve(0);',
    tail: 'type IsolatedTrainerId = string;\nexport type { IsolatedTrainerId as Shadowed };' },
];

/** The exemption fixtures, which are asserted on counts rather than on a bare verdict. */
export const EXEMPTION_FIXTURES = [
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
  const dir = path.join(repoRoot, `.tmp-abc27-trainer-authority-selftest-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const files = fixtures.map((f) => {
      const file = path.join(dir, `${f.name}.ts`);
      fs.writeFileSync(file, `${FIXTURE_PRELUDE}\n${f.body}\n}\n${f.tail ? `${f.tail}\n` : ''}`);
      return file;
    });
    const whole = analyze({ files: [path.join(repoRoot, AUTHORITY_REL), ...files], repoRoot });
    const byName = new Map();
    for (const f of fixtures) {
      byName.set(f.name, { violations: [], writeSites: 0, exemptions: [] });
    }
    const nameOf = (rel) => path.basename(rel).replace(/\.ts$/, '');
    for (const v of whole.violations) {
      const entry = byName.get(nameOf(v.file));
      if (entry) entry.violations.push(v);
      else byName.set('<authority>', { violations: [v], writeSites: 0, exemptions: [] });
    }
    for (const e of whole.exemptions) {
      const entry = byName.get(nameOf(e.file));
      if (entry) entry.exemptions.push(e);
    }
    for (const key of whole.writeSites) {
      const entry = byName.get(nameOf(key.split(':')[0]));
      if (entry) entry.writeSites += 1;
    }
    return byName;
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
  add(() => lexSql('SELECT -- x\n1').comments.length === 1, 'a line comment is reported, not kept');
  add(() => lexSql('SELECT 1 -- m').comments[0].pos === 9,
    'a comment carries the position that attributes it to a statement');
  for (const [text, why] of [
    ["SELECT 'unterminated", 'an unterminated string throws rather than being guessed past'],
    ['/* unterminated', 'an unterminated block comment throws'],
    ['SELECT $q$ unterminated', 'an unterminated dollar-quote throws'],
    ["SELECT U&\"x\" UESCAPE '!'", 'a custom UESCAPE this does not implement is refused'],
  ]) {
    let threw = false;
    try { lexSql(text); } catch { threw = true; }
    add(threw, why);
  }
  return out;
};

export function selfTest({ log = console.log, err = console.error, repoRoot = REPO_ROOT } = {}) {
  let n = 0;
  const problems = [];
  const assert = (cond, msg) => { n += 1; if (!cond) problems.push(msg); };

  const results = analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES], { repoRoot });
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
  assert(!results.has('<authority>'),
    'the authority module itself must be clean under its own guard');

  for (const { ok, msg } of LEXER_CASES()) assert(ok, `lexer: ${msg}`);

  // The real repository is the last fixture: the guard must agree with the tree it guards.
  const real = analyze({ repoRoot });
  assert(real.violations.length === 0,
    `the repository itself is refused: ${real.violations.slice(0, 4)
      .map((v) => `${v.file}:${v.line} ${v.detail}`).join(' | ')}`);
  assert(real.writeSites.size === EXPECTED_WRITE_SITES,
    `the repository has ${real.writeSites.size} write sites, expected ${EXPECTED_WRITE_SITES}`);
  assert(real.exemptions.length === EXPECTED_EXEMPTIONS,
    `the repository has ${real.exemptions.length} exemptions, expected ${EXPECTED_EXEMPTIONS}`);

  if (problems.length > 0) {
    err(`\n❌ ABC-27 trainer source authority self-test — ${problems.length} of ${n} assertion(s) failed:\n`);
    for (const p of problems) err(`  ${p}`);
    return 1;
  }
  log(`✅ ABC-27 trainer source authority self-test — ${n} assertions over `
    + `${FIXTURES.length + EXEMPTION_FIXTURES.length} fixtures, incl. the real repository.`);
  return 0;
}

if (process.argv[1] && SELF === path.resolve(process.argv[1])) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : main());
}
