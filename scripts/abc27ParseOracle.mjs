// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CANONICAL PARSE ORACLE — ONE DECODER, ASKED BY BOTH READERS.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
//
// The ABC-27 trainer-authority batch stopped four times on the same failure mode, and never in a
// write path: a READER that answered a question it could not actually decide, in the direction
// that certifies. Every instance was the same shape — an ad-hoc regex or substring rule standing
// in for PostgreSQL's grammar. `FROM (public.)?routine(` cannot see `FROM "public"."routine"(`;
// a `VERB`/`FROM_TARGET` pair over whitespace-squashed text reads `/* SELECT */ ${hole}` as
// verb-then-value; a positional column/value walk needs a new rule for every spelling the
// grammar admits (quoting, case, comments, `LATERAL`, `SET (a,b) = …`, `MERGE` without `INTO`).
//
// Each fix moved the hole one spelling further out, because PostgreSQL's grammar admits more
// spellings per construct than any hand enumeration will ever hold. So the enumeration is gone.
// `libpg-query` is the REAL PostgreSQL parser (libpg_query, compiled to WASM); its raw parse
// needs no catalog, so the same call answers in a plain-node CLI and inside vitest.
//
// THE VERSION LINE MATTERS AND IS PINNED. `libpg-query@18.1.4` is the PG18 grammar line, which is
// the server family the db suite actually boots (`embedded-postgres@18.4`). The grammar version
// the library reports is printed by the guard on every run, so a silent library bump is visible
// in the gate's own output rather than only in a lockfile.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────────────
//
// It is a PARSER, not a planner and not a type checker. It answers questions about the SHAPE of a
// statement: how many statements a text is, which relations it writes, what expression lands in a
// column, which routines it invokes, whether a substituted atom stands where a value goes. It
// says nothing about what the server does at run time with the values bound to `$k`, and nothing
// about a text a program computes by means no reader can fold. Those residuals are stated in the
// guard's own claim and are exactly what the RUNTIME registry covers.
//
// ── THE ONE INVARIANT EVERY EXPORT HERE OBEYS ─────────────────────────────────────────────────
//
// Three-valued. Every question returns decided-yes, decided-no, or UNREADABLE, and unreadable is
// returned as a value the caller must handle — never folded into the certifying answer. A parse
// failure is `{ ok: false }`, not an empty result set.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { loadModule, parsePlPgSQLSync, parseSync } from 'libpg-query';

/** The oracle's identity, restated here so a refusal can name what decided it. */
export const ORACLE_PACKAGE = 'libpg-query';
/** EXACT, not a range: a grammar that moves under the gate is a gate that changed silently. */
export const ORACLE_PACKAGE_VERSION = '18.1.4';

let grammar = null;

/**
 * Load the WASM parser. Idempotent, and REQUIRED before any question below: `parseSync` throws
 * `WASM module not initialized` otherwise, which would surface as an unreadable rather than as a
 * wrong answer — but a gate that reports "unreadable" because it forgot to boot is noise, so the
 * loading is explicit and the grammar version is captured while it happens.
 */
export async function loadOracle() {
  await loadModule();
  grammar = parseSync('SELECT 1').version;
  return grammar;
}

/** The grammar version the loaded library reports (`180004` = the PG18 line), or null. */
export const oracleGrammarVersion = () => grammar;

/** Human-readable provenance for the guard's output and the runbook. */
export const oracleIdentity = () =>
  `${ORACLE_PACKAGE}@${ORACLE_PACKAGE_VERSION} (PostgreSQL grammar ${grammar ?? 'unloaded'})`;

// ── PARSING ───────────────────────────────────────────────────────────────────────────────────

/**
 * Parse a complete SQL text. `{ ok: false, error }` is the UNREADABLE answer and callers must
 * treat it as one — this never returns an empty statement list for a text it could not read.
 */
export function parseSql(text) {
  try {
    const tree = parseSync(String(text));
    return { ok: true, version: tree.version, stmts: tree.stmts ?? [] };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e) };
  }
}

/**
 * Parse a `CREATE FUNCTION … LANGUAGE plpgsql` text as PL/pgSQL, which is what makes the statements
 * inside a dollar-quoted body readable by the SAME oracle rather than by a hand descent into a
 * string token. Every embedded statement comes back as its own text, which `parseSql` then reads.
 */
export function parsePlpgsql(text) {
  try {
    return { ok: true, tree: parsePlPgSQLSync(String(text)) };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e) };
  }
}

// ── WALKING THE TREE ──────────────────────────────────────────────────────────────────────────
//
// libpg_query's JSON is a tagged union: `{ InsertStmt: { … } }`, `{ String: { sval: 'x' } }`. The
// walk below is deliberately structure-agnostic — it descends every object and array and reports
// every `Tag → payload` pair it passes — so a node type this file has never heard of is still
// visited. A walker that knew the shapes would be one more enumeration to fall behind.

/**
 * Visit every `tag → payload` pair in the tree, depth first. `visit(tag, payload)`.
 *
 * NO MEMOISATION, DELIBERATELY. A "have I seen this object" set is the obvious way to write this
 * and is wrong here in the direction that matters: if the parser ever hands back the SAME object
 * at two places in the tree, a visited-set drops the second one — and a routine invocation this
 * walk does not visit is a routine it does not report. Under-reporting is the certifying side.
 * A parse tree is finite and acyclic, so the only thing a set would buy is speed; the depth cap
 * is what keeps a malformed input from running away.
 */
export function everyNode(root, visit) {
  const go = (node, depth) => {
    if (depth > WALK_DEPTH_CAP) throw new WalkTooDeep();
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const el of node) go(el, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      if (/^[A-Z]/.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(key, value);
      }
      go(value, depth + 1);
    }
  };
  go(root, 0);
}

/**
 * How deep either walk descends — a runaway guard, not a semantic bound.
 *
 * IT USED TO BE ONE, AND SILENTLY. Both walks simply RETURNED past the cap, so a tree deeper than
 * it produced "no writes here" and "no routines invoked here" — a decided-no manufactured out of
 * not having looked, which is the exact collapse this file exists to remove. A hundred nested
 * data-modifying CTEs parse perfectly well and reported zero writes.
 *
 * Exceeding it now THROWS, and every caller turns that into unreadable.
 *
 * MEASURED, not guessed, and measured TWICE. The whole frozen 20,633-line migration parses to a
 * tree 26 deep; a deliberately pathological hundred-deep nest of data-modifying CTEs reaches 612.
 * The first cap chosen was 20,000, and it never fired: these walks exhaust the runtime's own stack
 * at about 3,400 (`everyNode`), so the walk died with a `RangeError` while a caller watching only
 * for this class saw nothing. A cap above the native limit is a cap that does not exist.
 *
 * 1,024 sits below both native limits with room for a deeper stack above it, and above every real
 * tree measured. Anything past it is reported unreadable, which is the honest direction.
 */
const WALK_DEPTH_CAP = 1024;

/** Thrown when a walk hits its runaway guard. Callers must report it, never absorb it. */
export class WalkTooDeep extends Error {
  constructor(cause = 'the cap') { super(`the parse tree is deeper than this reader walks (${cause})`); }
}

/**
 * Did this failure mean "the walk did not finish"? The cap is the deterministic answer, and a
 * `RangeError` — the runtime's own stack giving out — is the same fact arriving by another route
 * on a machine whose stack is shallower than the one the cap was measured against. Both are
 * unreadable; neither is an empty result.
 */
export const isIncompleteWalk = (e) => e instanceof WalkTooDeep
  // ...AND ONLY THE RangeError THAT MEANS A STACK RAN OUT. Accepting every `RangeError` would
  // absorb `Invalid array length` and its relatives — different failures wearing the same class,
  // and calling one of those "an incomplete walk" is a diagnosis this file has not earned.
  || (e instanceof RangeError && /call stack|stack size/i.test(String(e.message)));

/** Every payload of one node type anywhere in the tree. */
export function nodesOf(root, tag) {
  const out = [];
  everyNode(root, (key, payload) => { if (key === tag) out.push(payload); });
  return out;
}

/**
 * ── THE SENTINEL-PROTOCOL SUPPORT IS GONE, WITH ITS ONLY CONSUMER ────────────────────────────
 *
 * `stringOccurrences` and `occurrencePosition` existed for ONE caller: the apply-write census,
 * which substituted an atom for every template hole and then asked WHERE in the parse tree each
 * atom had landed. That census is retired — every writing apply invocation is spelled in
 * `src/test/abc27ApplyCatalogue.ts` now, and the question "could this hole name a routine" has no
 * holes left to be asked about.
 *
 * `occurrencePosition` carried the one enumeration in this file that genuinely failed OPEN: a
 * routine-name FIELD nobody had listed read as inert, which the retired function's own comment
 * said plainly. It is DELETED rather than extended, which is the point of the batch that removed
 * its caller — the catalogue's statements are audited STRUCTURALLY (one closed
 * `SELECT … FROM public.<routine>(…)`, every other invoked name refused by FULL dotted name), so
 * no field enumeration carries certification weight anywhere any more.
 */

/**
 * DESCEND INTO A NESTED SOURCE WITH THE SAME ORACLE, rather than refusing at its edge.
 *
 * A raw parse stops at the outside of a `DO $$…$$` or a `CREATE FUNCTION … AS $$…$$` body: the
 * body is one string, and everything inside it is invisible. `parsePlPgSQLSync` reads exactly
 * that body — a `DO` text directly, a `CREATE FUNCTION` text directly — and hands back every
 * SQL text the body contains as its own `query`, which `parseSql` then reads like any other.
 *
 * That is what keeps a fixture like `CREATE FUNCTION … AS $zz$ … WHERE id = '<hole>'::uuid … $zz$`
 * READABLE — the hole is a value inside the body, and refusing at the body's edge would pin a
 * dozen ordinary planted triggers — while a body that IS a hole stays unreadable, because the
 * PL/pgSQL parser refuses it.
 *
 * `{ ok: false }` is the unreadable answer and never an empty list.
 */
export function plpgsqlExpressions(text, depth = 0) {
  // ── A BODY INSIDE A BODY IS STILL A BODY ──────────────────────────────────────────────────
  //
  // One level of descent reads the statements a body contains; it does not read the statements
  // THOSE contain. `DO $outer$ BEGIN DO $inner$ BEGIN PERFORM writing(); END $inner$; END $outer$`
  // handed back the inner `DO` as a text, whose raw parse shows a `DoStmt` and no call at all —
  // so the invocation was invisible and the text read as clean. The descent recurses.
  if (depth > 8) return { ok: false, error: 'function bodies nested deeper than this reads' };
  const parsed = parsePlpgsql(text);
  if (!parsed.ok) return parsed;
  const queries = [];
  const dynamic = [];
  const go = (node, depth) => {
    if (depth > WALK_DEPTH_CAP) throw new WalkTooDeep();
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const el of node) go(el, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'PLpgSQL_expr' && value && typeof value.query === 'string') {
        queries.push({ query: value.query, parseMode: value.parseMode ?? 0 });
      }
      // ── A PL/pgSQL STATEMENT KIND THIS DOES NOT KNOW IS REPORTED, NOT WALKED PAST ──────────
      //
      // The queries collected above are the body's FIXED SQL. A body can also carry SQL it
      // BUILDS: `EXECUTE format('UPDATE … SET trainer_id = %L', …)` reaches the server as a real
      // statement while every fixed text in the body says nothing about it — the expression
      // collected for it is `format(...)`, whose write-set is empty. Reading only the fixed texts
      // therefore CERTIFIES a body that writes, which is this batch's whole failure mode.
      //
      // An ALLOW-LIST, deliberately, and named rather than counted: a statement kind that is not
      // on it is reported by name, so admitting one is a deliberate edit. Every dynamic form —
      // `EXECUTE`, dynamic `FOR`, a dynamic cursor `OPEN`, `RETURN QUERY EXECUTE` — is absent
      // from the list and therefore reported without this file having to enumerate them.
      if (key.startsWith('PLpgSQL_stmt_')) {
        // A KIND OFF THE LIST, OR A LISTED KIND CARRYING A `dynquery`. `RETURN QUERY <fixed>` and
        // `OPEN c FOR <fixed>` hand their query over as an ordinary `PLpgSQL_expr`, which is
        // collected above and read like any other; the same statements written
        // `RETURN QUERY EXECUTE …` / `OPEN c FOR EXECUTE …` carry a `dynquery` instead, and that
        // text is built at run time. The field is the grammar's own answer to which one this is.
        if (!PLPGSQL_STATEMENTS_READ.has(key)) dynamic.push(key);
        else if (value && typeof value === 'object' && value.dynquery !== undefined) {
          dynamic.push(`${key} (dynquery)`);
        }
      }
      go(value, depth + 1);
    }
  };
  go(parsed.tree, 0);
  // ── AND A BODY IN A LANGUAGE THIS DESCENT DOES NOT READ IS UNREADABLE, NOT EMPTY ───────────
  //
  // `parsePlPgSQLSync` reads PL/pgSQL. Handed `CREATE FUNCTION … LANGUAGE sql AS 'UPDATE …'` it
  // succeeds and returns NO queries at all — so a caller that treats "no queries" as "nothing in
  // the body" certifies a body it never read. The language is a `DefElem` on the raw tree, so it
  // is asked there, and any body that is not PL/pgSQL is reported like a dynamic statement.
  const raw = parseSql(text);
  if (!raw.ok) return { ok: false, error: raw.error };
  for (const fn of nodesOf(raw.stmts, 'CreateFunctionStmt')) {
    const options = (fn.options || []).map((o) => o && o.DefElem).filter(Boolean);
    const lang = options.find((d) => d.defname === 'language');
    const named = lang && lang.arg && lang.arg.String ? lang.arg.String.sval : null;
    if (named === 'plpgsql') continue;
    // ── A `LANGUAGE sql` BODY IS PLAIN SQL, so it is READ rather than refused ────────────────
    //
    // `parsePlPgSQLSync` reads PL/pgSQL, and handed `CREATE FUNCTION … LANGUAGE sql AS 'UPDATE
    // …'` it succeeds while returning NO queries at all — so a caller that reads "no queries" as
    // "nothing in the body" certifies a body it never opened. The body is a string this oracle
    // can parse directly, so it joins the queries and is audited like any other statement.
    const body = options.find((d) => d.defname === 'as');
    const items = body && body.arg && body.arg.List ? body.arg.List.items || [] : [];
    const texts = items.map((i) => (i && i.String ? i.String.sval : null)).filter((t) => t !== null);
    if (named === 'sql' && texts.length > 0) {
      for (const t of texts) queries.push({ query: t, parseMode: 0 });
      continue;
    }
    // A body in a language neither descent reads — `c`, `internal`, a procedural language this
    // knows nothing about — or one whose text is not a string this could take. Reported.
    dynamic.push(`body-language:${named ?? 'unstated'}`);
  }
  // ...AND EVERY COLLECTED STATEMENT IS ASKED WHETHER IT IS ITSELF A BODY.
  for (const { query } of [...queries]) {
    const inner = parseSql(query);
    if (!inner.ok) continue;
    if (nodesOf(inner.stmts, 'DoStmt').length === 0
      && nodesOf(inner.stmts, 'CreateFunctionStmt').length === 0) continue;
    const deeper = plpgsqlExpressions(query, depth + 1);
    if (!deeper.ok) return deeper;
    queries.push(...deeper.queries);
    dynamic.push(...deeper.dynamic);
  }
  return { ok: true, queries, dynamic };
}

/**
 * The PL/pgSQL statement kinds whose SQL is entirely FIXED, so that collecting the body's
 * `PLpgSQL_expr` texts really is collecting everything the body sends. Control flow, assignment,
 * a fixed statement, `PERFORM`, `RAISE`, `RETURN`. Anything else — most importantly every
 * construct that builds a statement at run time — is reported by `plpgsqlExpressions`.
 */
const PLPGSQL_STATEMENTS_READ = new Set([
  'PLpgSQL_stmt_block', 'PLpgSQL_stmt_assign', 'PLpgSQL_stmt_if', 'PLpgSQL_stmt_case',
  'PLpgSQL_stmt_loop', 'PLpgSQL_stmt_while', 'PLpgSQL_stmt_fori', 'PLpgSQL_stmt_fors',
  'PLpgSQL_stmt_foreach_a', 'PLpgSQL_stmt_exit', 'PLpgSQL_stmt_return',
  'PLpgSQL_stmt_return_next', 'PLpgSQL_stmt_raise', 'PLpgSQL_stmt_assert',
  'PLpgSQL_stmt_execsql', 'PLpgSQL_stmt_perform', 'PLpgSQL_stmt_getdiag', 'PLpgSQL_stmt_null',
  'PLpgSQL_stmt_commit', 'PLpgSQL_stmt_rollback', 'PLpgSQL_stmt_fetch', 'PLpgSQL_stmt_close',
  'PLpgSQL_stmt_forc', 'PLpgSQL_stmt_call', 'PLpgSQL_stmt_return_query', 'PLpgSQL_stmt_open',
]);

/**
 * Parse a text that is either a STATEMENT or an EXPRESSION, which is what a PL/pgSQL body hands
 * back: `PERFORM f()` arrives as the statement `SELECT f()`, and an `IF` condition arrives as the
 * bare expression `NEW.label = current_setting('x')`, which is only legal after a `SELECT`.
 */
export function parseStatementOrExpression(text) {
  const asStatement = parseSql(text);
  if (asStatement.ok) return asStatement;
  const asExpression = parseSql(`SELECT ${text}`);
  if (asExpression.ok) return asExpression;
  return asStatement;
}

// ── THE QUESTIONS ─────────────────────────────────────────────────────────────────────────────

/** `{ schema, name }` for a `RangeVar`. `schema` is null when the reference relies on search_path. */
export function relationOf(rangeVar) {
  if (!rangeVar || typeof rangeVar !== 'object') return null;
  if (typeof rangeVar.relname !== 'string') return null;
  return { schema: typeof rangeVar.schemaname === 'string' ? rangeVar.schemaname : null,
    name: rangeVar.relname };
}

/**
 * Does this relation reference name the guarded relation?
 *
 * AN ABSENT SCHEMA IS NOT "SOME OTHER SCHEMA". `INSERT INTO availability_slots` resolves through
 * `search_path`, which this reader cannot see, so it may be the guarded one — and assuming
 * otherwise is the assumption a gate must not make about itself.
 */
export function namesRelation(rangeVar, name, schema = 'public') {
  const r = relationOf(rangeVar);
  if (!r) return false;
  if (r.name !== name) return false;
  return r.schema === null || r.schema === schema;
}

/**
 * EVERY WRITE ANYWHERE IN THE TREE, with the node that owns it.
 *
 * Structural, so the whole class of region escapes the retired token reader was defeated by is
 * closed by construction rather than by a depth counter: a data-modifying CTE, a write inside a
 * sub-select's `WITH`, a write inside a set-operation arm are all just nodes, each returned with
 * its OWN clauses attached. There is no "which tokens does this write own" question left to get
 * wrong.
 *
 * DELETE IS DELIBERATELY NOT ONE OF THEM, exactly as in the guard's stated claim: removing a row
 * cannot create the overlap namespace this exists to prevent.
 */
export function writeNodes(root) {
  const out = [];
  everyNode(root, (tag, payload) => {
    if (tag === 'InsertStmt' || tag === 'UpdateStmt' || tag === 'MergeStmt') {
      out.push({ verb: tag.replace(/Stmt$/, '').toLowerCase(), node: payload, tag });
      return;
    }
    // `COPY t TO …` reads; `COPY t FROM …` writes. The direction is a field, not a word order.
    if (tag === 'CopyStmt' && payload.is_from === true) {
      out.push({ verb: 'copy', node: payload, tag });
    }
  });
  return out;
}

/**
 * Every routine INVOKED anywhere in the tree, by bare name.
 *
 * QUOTING, CASE AND SCHEMA ARE THE PARSER'S PROBLEM, NOT A PATTERN'S. `FROM
 * "public"."rebook_round_apply_command_as_actor"(…)`, `FROM public.REBOOK_ROUND_APPLY_…(…)` and
 * `SELECT rebook_round_apply_command_as_actor(…)` all reach the same `FuncCall`, whose `funcname`
 * carries the identifier VALUES after folding — which is precisely what the regex this replaces
 * could not do.
 *
 * A NAME INSIDE A STRING IS NOT AN INVOCATION. `WHERE proname = 'rebook_round_apply_…'` is an
 * `A_Const`, so it does not appear here — the substring test this replaces could not tell the two
 * apart either way round.
 */
export function invokedRoutines(root) {
  const out = new Set();
  for (const call of nodesOf(root, 'FuncCall')) {
    const parts = Array.isArray(call.funcname) ? call.funcname : [];
    const last = parts[parts.length - 1];
    const sval = last && last.String && typeof last.String.sval === 'string'
      ? last.String.sval : null;
    if (sval) out.add(sval);
  }
  return out;
}

/**
 * Peel the wrappers that say nothing about a value's ORIGIN. A cast changes a value's type, never
 * where it came from, so `$2::uuid` is parameter two — and a `CollateClause` or a parenthesised
 * expression is the same argument with more punctuation. Anything else is returned untouched, so
 * the classifier that follows sees the real node.
 */
export function unwrapValue(expr) {
  let node = expr;
  for (let i = 0; i < 16 && node && typeof node === 'object'; i += 1) {
    const tag = Object.keys(node)[0];
    if (tag === 'TypeCast' && node.TypeCast && node.TypeCast.arg) { node = node.TypeCast.arg; continue; }
    if (tag === 'CollateClause' && node.CollateClause && node.CollateClause.arg) {
      node = node.CollateClause.arg;
      continue;
    }
    return node;
  }
  return node;
}

/** The tag of a wrapped expression after `unwrapValue`, or null. */
export const tagOf = (node) => (node && typeof node === 'object' ? Object.keys(node)[0] ?? null : null);
