#!/usr/bin/env node
/**
 * Type-check ratchet for tsconfig.app.json — the REAL type-check.
 *
 * The root `tsconfig.json` has `files: []` + project references and type-checks NOTHING, so a bare
 * `tsc --noEmit` is a useless gate (it let a runtime ReferenceError ship in cycleWrites.ts — a value
 * call to an un-imported name — because eslint/vitest/`vite build` can't catch cross-module name
 * resolution; only `tsc -p tsconfig.app.json` does). That project is perma-red with a known set of
 * pre-existing errors, so this gates on NEW errors only, exactly like the eslint-suppressions ratchet:
 *
 *   - signature each error as `file|code|message` (line/col stripped — they shift when code moves)
 *   - count occurrences per signature
 *   - FAIL unless the run reproduced the COMPLETE baseline (or is a genuinely clean, zero-error run)
 *   - FAIL if any signature exceeds the committed baseline (a genuinely-new error)
 *   - note (non-fatal) signatures that dropped below baseline — reachable only from a clean run
 *
 * Like `eslint-suppressions.json`, the baseline is SHRINK-ONLY and shrinking it is an explicit
 * act: fixing a baseline error makes this gate red until the baseline is regenerated. That is the
 * price of the completeness rule, and it is the point — a run that reports only some of the
 * baseline is indistinguishable from a run that only checked some of the project.
 *
 * Regenerate after intentionally changing the error set:  node scripts/check-tsc-baseline.mjs --update
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const BASELINE = join(dirname(SELF), 'tsc-app.baseline.json');

// ── WHY THERE IS NO LONGER A TEXT PARSER HERE ─────────────────────────────────────────────────
//
// This gate used to read the compiler's HUMAN output — first from `npx tsc`, then from the
// compiler binary directly — and decide, line by line, whether what it saw was a completed
// type-check. Four consecutive reviews found the same class of defect each time, and they were
// never the same line twice: a wrapper notice with an open tail, a `Found N errors.` summary that
// the compiler does not actually emit but which was recognised anyway, an indented stack frame
// accepted as a "continuation" of the diagnostic above it, a contradictory trailer that survived
// by being indented, `stderr.trim()` treating whitespace as silence, and an `execFileSync` return
// value that structurally cannot carry stderr on a successful child.
//
// Those are not six bugs. They are one: HUMAN-ORIENTED COMPILER TEXT IS NOT A COMPLETION
// PROTOCOL. It has no version, no framing, no end marker, and no way to distinguish "this is all
// of it" from "this is what fit down the pipe before the process died". Every patch widened or
// narrowed a grammar over an object that was never a protocol, so each fix could only move the
// hole. The parser is therefore GONE, not tightened.
//
// What replaced it is a versioned canonical envelope. An isolated child — this same file, run
// with `--emit-diagnostics` — loads the repository's own installed TypeScript through its
// COMPILER API, builds the program `tsconfig.app.json` describes, collects the diagnostics, and
// writes exactly one line:
//
//   {"protocol":"padeltrainer.tsc-diagnostics.v1","completed":true,"diagnostics":[…]}\n
//
// The parent then requires that stdout be BYTE-FOR-BYTE the canonical serialization of what it
// just validated, plus that one newline.
//
// AND "BYTE" IS LITERAL, WHICH IT WAS NOT BEFORE. The child's stdout and stderr are captured as
// raw `Buffer`s — `spawnSync` is called with NO `encoding` option — because a decoding transport
// makes that rule unenforceable at precisely the point it matters. Under `encoding: 'utf8'` an
// invalid byte becomes U+FFFD before anything gets to look at it, whitespace-vs-nothing on stderr
// becomes a question about a string, and the "byte-for-byte" comparison quietly degrades into a
// comparison between two strings the decoder has already reconciled. So: stderr is judged by BYTE
// LENGTH (zero, or refuse); stdout is decoded with FATAL UTF-8, where an invalid byte is a closed
// refusal rather than replacement text; and the validated envelope is re-encoded to UTF-8 bytes
// and compared against the buffer that actually arrived.
//
// That single rule subsumes every text-era failure at once: a prefix or suffix, an extra blank
// line, a stray space, a duplicate member, an unknown member, a missing member, a wrong type, a
// truncated write, a trailer of any shape — none of them re-serialize to the same bytes, so none
// of them can be mistaken for an answer. There is no grammar left to have a hole in.
//
// AND DIAGNOSTICS ARE DATA, NOT FAILURE. The child exits 0 whether the project has 0 errors or
// 82; "the type-check found things" and "the type-check did not finish" stop sharing a channel,
// which is what made exit codes ambiguous in the first place. A child that throws, is signalled,
// exits non-zero, cannot be spawned, or writes a single byte to stderr is refused BEFORE any
// diagnostic, baseline or `--update` logic runs.

// ── API-TO-`tsc -p` PARITY, MEASURED ──────────────────────────────────────────────────────────
//
// A compiler-API child is only a legitimate substitute for `tsc -p tsconfig.app.json` if it
// produces the SAME diagnostics, so that was measured before this replaced anything, three ways,
// on TypeScript 5.8.3 / node v26 against this repository:
//
//   1. the child's normalized signature multiset === the committed baseline, exactly:
//      62 signatures / 82 occurrences, zero extra, zero missing, zero count-different;
//   2. the child's multiset === the multiset parsed from the previous implementation's real
//      `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json --pretty false` run —
//      an exact match, so this is parity with the CLI and not merely with the baseline file; and
//   3. the envelope is byte-identical across repeated runs (no ordering or timing dependence),
//      at ~27 s versus ~29 s for the CLI child.
//
// `collectDiagnostics` reproduces tsc's own cascade rather than a convenient approximation of it
// (see the comment there), which is what makes that parity structural instead of coincidental.

/** Heap for the CHILD type-checker, in MB. Type-checking this project peaks around 1.9 GB, which
 *  is over node's default cap on a typical CI runner — that is precisely why it died mid-run and
 *  handed this script a truncated result to misread. This is the checker configuring the process
 *  it spawns; it is not a workflow, npm-script, tsconfig or baseline change, and it suppresses
 *  nothing: if the raised heap is still not enough, `classify` below fails closed exactly as it
 *  does today. An ambient heap flag always wins, so an operator can still override — in EITHER
 *  spelling, which is what `HEAP_FLAG_RE` is for. */
const CHILD_HEAP_MB = 4096;

/** EVERY SPELLING OF THE HEAP CAP NODE ACTUALLY HONOURS — both flag spellings, quoted or not —
 *  because the LAST flag wins and appending after an operator's cap REPLACES it rather than
 *  sitting alongside it. Measured on this node by reading `v8.getHeapStatistics()` from the child:
 *  a 100 MB cap shows as a 196 MiB limit, an uncapped child as 2144 MiB.
 *
 *    --max-old-space-size=100                         → 196   honoured
 *    --max_old_space_size=100                         → 196   honoured (node normalises `_` to `-`)
 *    --max_old-space_size=100                         → 196   honoured (mixed spelling)
 *    "--max-old-space-size=100"                       → 196   honoured — NODE_OPTIONS quoting
 *    "--max_old_space_size=100"                       → 196   honoured
 *    --max-old-space-size="100"                       → 196   honoured
 *    --enable-source-maps "--max-old-space-size=100"  → 196   honoured
 *    --max-old-space-size 100                         → node refuses to start ("illegal value")
 *    …=100 followed by …=4096, quoted or not          → 4192  THE LATER FLAG WINS
 *
 *  The last row is the whole problem. The previous pattern required start-or-whitespace before
 *  `--max`, so the leading `"` of the quoted form blocked the match: this script appended its own
 *  4096 after a cap node was honouring, and a deliberately LOWERED ceiling became a raised one.
 *  The boundary here therefore admits a quote on either side of the flag as well as whitespace,
 *  `=` and end-of-string, while still refusing a longer flag that merely CONTAINS the name. */
const HEAP_FLAG_RE = /(?:^|[\s"'])--max[-_]old[-_]space[-_]size(?:[=\s"']|$)/;

/** ...AND THE FAIL-SAFE FOR EVERYTHING THIS SCRIPT DOES NOT CLAIM TO LEX. NODE_OPTIONS has its own
 *  quoting rules — measured, `"` groups and `'` does NOT, so a single-quoted flag is simply never
 *  applied — and a value carrying quotes or backslashes can be split in ways a regex should not be
 *  trusted to reproduce. Appending to such a string could land this script's flag inside somebody
 *  else's quoted value, or after a cap it failed to see. So an ambiguous value is PRESERVED
 *  UNTOUCHED rather than overridden. The only cost is that the default is not supplied in that
 *  case, and if the child then exhausts its heap `classify` fails closed and says so — which is
 *  the direction to be wrong in. */
const AMBIGUOUS_NODE_OPTIONS_RE = /["'\\]/;

export function childEnv(env = process.env) {
  const existing = env.NODE_OPTIONS ?? '';
  // (a) An operator cap, either spelling, quoted or not: operator authority wins outright.
  if (HEAP_FLAG_RE.test(existing)) return { ...env };
  // (b) Quoting or escaping this script cannot confidently lex: stand down rather than override.
  if (AMBIGUOUS_NODE_OPTIONS_RE.test(existing)) return { ...env };
  // (c) Nothing in the way — supply the ceiling the child needs.
  return { ...env, NODE_OPTIONS: `${existing} --max-old-space-size=${CHILD_HEAP_MB}`.trim() };
}

// ── THE PROTOCOL ──────────────────────────────────────────────────────────────────────────────
//
// The version string is part of the wire format, not decoration: it is what lets a future change
// to the diagnostic shape be a REFUSAL in an old parent rather than a silent misread. A parent
// that does not recognise the protocol has no idea what it is looking at, and says so.

export const PROTOCOL = 'padeltrainer.tsc-diagnostics.v1';

/** The argv flag that turns this file into the diagnostics child. Deliberately checked BEFORE
 *  `main`, so `--emit-diagnostics --update` emits an envelope and cannot write a baseline. */
const CHILD_FLAG = '--emit-diagnostics';

const ENVELOPE_KEYS = ['protocol', 'completed', 'diagnostics'];
const DIAGNOSTIC_KEYS = ['file', 'code', 'message'];

/** `TS` + digits, the compiler's own code space. Not a formatting preference: it is the only part
 *  of a diagnostic whose shape is fixed, so it is the one field that can be validated by form. */
const CODE_RE = /^TS\d+$/;

const excerpt = (text) => String(text).trim().slice(0, 120);

/** FATAL UTF-8, and the `fatal` is the whole point: an invalid byte throws instead of becoming
 *  U+FFFD. A lossy decoder would let a corrupt stream turn into text that parses, validates and —
 *  for a byte the replacement character happens to be a plausible stand-in for — reads as an
 *  answer. `ignoreBOM: true` so the decode is a pure byte→text mapping that removes nothing: a
 *  leading BOM stays in the text and fails JSON parsing with a legible message, rather than being
 *  silently stripped and having to be caught later by the byte comparison. */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** ...AND ITS OPPOSITE, FOR QUOTING ONLY. A child that failed may have written anything at all to
 *  stderr, including bytes that are not UTF-8, and formatting a refusal must never itself throw.
 *  This decoder is therefore lossy — but it is used ONLY to make a message legible, never to make
 *  a decision: every stderr verdict below is taken on `Buffer.length`, before this is reached. */
const UTF8_LOSSY = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** A bounded, never-throwing rendering of whatever arrived on a channel, for refusal text. */
const quoteBytes = (value) =>
  excerpt(Buffer.isBuffer(value) ? UTF8_LOSSY.decode(value) : String(value ?? ''));

/** The first bytes of a stream that could not be decoded, as hex — the only legible thing left to
 *  say about a buffer that is not text. Bounded, like every other excerpt here. */
const hexPreview = (buf) =>
  `${buf.subarray(0, 16).toString('hex')}${buf.length > 16 ? '…' : ''}`;

/** WHAT A CHANNEL ACTUALLY WAS, when the complaint is about its shape rather than its content.
 *  `typeof` alone flattens `null`, a plain object and a `Uint8Array` all to "object", and the
 *  whole point of that refusal is to tell an operator which layer handed over the wrong thing. */
const describeShape = (value) => {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Array.isArray(value) ? 'array' : (value.constructor?.name ?? 'object');
};

/**
 * THE CANONICAL BYTES. Both sides call this — the child to produce stdout, the parent to
 * recompute what stdout must have been — so "canonical" is one function rather than an agreement
 * between two encoders that could drift.
 *
 * Key ORDER is protocol, and it is enforced here by construction: object literals serialize in
 * insertion order, so `protocol, completed, diagnostics` and `file, code, message` are the only
 * orders this can emit. Everything else about the encoding — compact separators, standard JSON
 * string escaping, well-formed handling of lone surrogates — is `JSON.stringify`'s, identically
 * on both sides, which is exactly why it is not hand-rolled.
 */
export function serializeEnvelope({ protocol, completed, diagnostics }) {
  return JSON.stringify({
    protocol,
    completed,
    diagnostics: diagnostics.map(({ file, code, message }) => ({ file, code, message })),
  });
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Own enumerable keys are EXACTLY these — no more, no fewer. `JSON.parse` gives own data
 *  properties (including a literal `__proto__` member, which therefore also fails this), so an
 *  unknown or missing member is caught here rather than being quietly ignored the way a
 *  destructuring read would ignore it. Order is NOT checked here; the byte comparison below is
 *  what makes order part of the protocol. */
const hasExactKeys = (obj, keys) => {
  const own = Object.keys(obj);
  return own.length === keys.length
    && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
};

/**
 * Validate the child's RAW STDOUT BYTES as the canonical envelope, and return the diagnostics they
 * carry. The parameter is a `Buffer` — deliberately, and anything else is refused rather than
 * coerced, because the one thing this function exists to guarantee cannot be guaranteed about a
 * value some other layer already decoded.
 *
 * THREE CHECKS, IN THIS ORDER, AND ALL THREE ARE LOAD-BEARING.
 *
 *   (a) A DECODE check: the bytes are valid UTF-8, judged by a FATAL decoder. This is first
 *       because it is the one that cannot be recovered from afterwards — a lossy decode replaces
 *       every invalid byte with U+FFFD and hands on text that may well parse, so the corruption
 *       would have to be detected by something downstream that is looking at the wrong object.
 *       An invalid byte is a closed refusal here, before JSON is parsed and long before any
 *       diagnostic, baseline comparison or `--update` is reached.
 *
 *   (b) A STRUCTURAL check: it parses as JSON, it is an object, its members are exactly the three
 *       named ones, the protocol is the one this parent speaks, `completed` is literally `true`,
 *       and every diagnostic is an object with exactly `file`/`code`/`message` of the right
 *       types. This is what produces a legible refusal — "unknown member", "code is not TSnnnn" —
 *       instead of an opaque byte mismatch.
 *
 *   (c) A BYTE check: `serializeEnvelope` of the validated value, plus one newline, ENCODED BACK
 *       TO UTF-8, must equal the arriving buffer byte for byte. This is the one that closes the
 *       open-ended cases, because it does not enumerate anything. A prefix, a suffix, a second
 *       newline, a space after a colon, a duplicate member that `JSON.parse` collapsed, a member
 *       order the child would never emit, a truncated final write — all of them re-encode to
 *       something different from what arrived, and are refused without any rule having
 *       anticipated them.
 *
 * No check is redundant: (b) without (c) accepts anything that happens to parse into the right
 * shape, and (c) without (b) cannot say WHY. (a) is the one the previous version did not have at
 * all: it received an already-decoded string, so an invalid byte had silently become U+FFFD
 * before it looked, and its "byte" comparison was between two strings node's lossy decoder had
 * reconciled with each other. Returns `{ ok: true, diagnostics }` or `{ ok: false, problem }`;
 * it never throws.
 */
export function decodeEnvelope(stdout) {
  if (!Buffer.isBuffer(stdout)) {
    return { ok: false, problem:
      `the diagnostics child's stdout did not arrive as raw bytes (${describeShape(stdout)}), so it cannot be verified` };
  }
  if (stdout.length === 0) {
    return { ok: false, problem: 'the diagnostics child produced no output at all' };
  }

  let text;
  try {
    text = UTF8_STRICT.decode(stdout);
  } catch {
    return { ok: false, problem:
      `the diagnostics child's stdout is not valid UTF-8 (${stdout.length} bytes, beginning ${hexPreview(stdout)})` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem:
      `the diagnostics child did not emit a ${PROTOCOL} envelope (${excerpt(text)})` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, problem: 'the diagnostics envelope is not a JSON object' };
  }
  if (!hasExactKeys(parsed, ENVELOPE_KEYS)) {
    return { ok: false, problem:
      `the diagnostics envelope's members are not exactly ${ENVELOPE_KEYS.join(', ')} (got ${excerpt(Object.keys(parsed).join(', ')) || 'none'})` };
  }
  if (parsed.protocol !== PROTOCOL) {
    return { ok: false, problem:
      `the diagnostics envelope declares an unknown protocol (${excerpt(String(parsed.protocol))}, expected ${PROTOCOL})` };
  }
  // INCOMPLETE IS NOT CLEAN. `completed` must be the literal `true`; anything else — `false`, a
  // truthy string, a number — means the child is not claiming to have finished, and an unfinished
  // run with an empty diagnostic list is exactly the shape that used to read as "no errors".
  if (parsed.completed !== true) {
    return { ok: false, problem:
      `the diagnostics child reported an INCOMPLETE result (completed is ${excerpt(JSON.stringify(parsed.completed) ?? 'undefined')}, not true)` };
  }
  if (!Array.isArray(parsed.diagnostics)) {
    return { ok: false, problem: 'the diagnostics envelope carries no diagnostics array' };
  }
  for (let i = 0; i < parsed.diagnostics.length; i += 1) {
    const d = parsed.diagnostics[i];
    if (!isPlainObject(d)) {
      return { ok: false, problem: `diagnostic ${i} in the envelope is not a JSON object` };
    }
    if (!hasExactKeys(d, DIAGNOSTIC_KEYS)) {
      return { ok: false, problem:
        `diagnostic ${i}'s members are not exactly ${DIAGNOSTIC_KEYS.join(', ')} (got ${excerpt(Object.keys(d).join(', ')) || 'none'})` };
    }
    if (d.file !== null && typeof d.file !== 'string') {
      return { ok: false, problem: `diagnostic ${i} has a file that is neither a string nor null` };
    }
    if (typeof d.code !== 'string' || !CODE_RE.test(d.code)) {
      return { ok: false, problem:
        `diagnostic ${i} has a code that is not TSnnnn (${excerpt(String(d.code))})` };
    }
    if (typeof d.message !== 'string') {
      return { ok: false, problem: `diagnostic ${i} has a message that is not a string` };
    }
  }

  // THE BYTE COMPARISON, AGAINST THE BUFFER THAT ARRIVED — not against the text just decoded from
  // it. Re-encoding here rather than comparing strings is what makes the claim literal: the only
  // stdout this accepts is one whose every byte the child would have written.
  if (!Buffer.from(`${serializeEnvelope(parsed)}\n`, 'utf8').equals(stdout)) {
    return { ok: false, problem:
      'the diagnostics child\'s stdout is not the canonical serialization of the envelope it carries' };
  }
  return { ok: true, diagnostics: parsed.diagnostics };
}

/**
 * The ratchet's signature model, applied to structured diagnostics.
 *
 * Signatures are `file|code|message` with line/col dropped — they shift whenever code moves, and
 * the ratchet is about which errors exist, not where. A positionless diagnostic (`file: null` —
 * TS5083 "Cannot read file …", TS2688 "Cannot find type definition file …") signs with an EMPTY
 * file field, which no baseline entry has, so a broken project configuration surfaces as a new
 * error rather than vanishing.
 *
 * The repo-root prefix is stripped from BOTH fields. tsc embeds absolute module paths inside some
 * messages (a TS2322 `Type import("/abs/path/foo").X is not assignable to import("/abs/path/bar").X`)
 * and those differ per machine (/Users/tom/… locally, /home/runner/… on CI), so stripping is what
 * keeps the committed baseline portable — and it is also what turns the child's absolute
 * `file` into the `src/…` form the baseline records.
 */
export function signatureCounts(diagnostics, cwd = process.cwd()) {
  const strip = (s) => s.split(`${cwd}/`).join('').split(cwd).join('');
  const counts = {};
  for (const d of diagnostics) {
    const sig = `${strip(d.file ?? '')}|${d.code}|${strip(d.message)}`;
    counts[sig] = (counts[sig] || 0) + 1;
  }
  return counts;
}

// ── THE CHILD ─────────────────────────────────────────────────────────────────────────────────

/** THIS REPOSITORY'S OWN INSTALLED TYPESCRIPT, resolved from THIS FILE rather than from PATH or
 *  from the working directory, so the gate always type-checks with the compiler this repository
 *  installed — including when the child is pointed at a throwaway project elsewhere on disk.
 *  `require.resolve` throws when the package is missing; that becomes a refusal below, because a
 *  gate that cannot find its compiler must say so rather than quietly fall back to another one. */
const requireFromHere = createRequire(import.meta.url);

export function resolveTypeScript() {
  try { return requireFromHere.resolve('typescript'); } catch { return null; }
}

/**
 * Build the program `tsconfig.app.json` describes and return its error diagnostics, normalized to
 * the envelope's `{ file, code, message }` shape.
 *
 * THIS MIRRORS `tsc`'s OWN CASCADE, deliberately, rather than reaching for the convenient
 * `getPreEmitDiagnostics`. The compiler CLI reports config-file diagnostics, then syntactic ones,
 * and only if there were none does it go on to options and global diagnostics, and only if THOSE
 * were also empty does it ask for semantic diagnostics. `getPreEmitDiagnostics` has no such
 * short-circuit, so on a project with a syntax error it would report a semantic set the CLI never
 * computes. Reproducing the cascade is what makes the measured parity structural: the two agree
 * because they are the same algorithm, not because this project happens to have no syntax errors.
 *
 * `sortAndDeduplicateDiagnostics` is the CLI's final step too, and it matters for the ratchet:
 * without it the same diagnostic reachable twice would be counted twice and read as a new error.
 *
 * THE EMIT STEP IS NOT REPLICATED, AND THE REASON IS BOUNDED TO THIS PROJECT ON THIS COMPILER —
 * not a general claim about `noEmit`, which an earlier version of this comment did make and which
 * is not true as stated. What is true, and measured:
 *
 *   - the frozen `tsconfig.app.json` sets `noEmit: true` and sets NONE of `incremental`,
 *     `composite`, `tsBuildInfoFile`, `declaration`, `declarationMap`, `emitDeclarationOnly`,
 *     `outFile` or `noEmitOnError` (`getEmitDeclarations(options)` is `false`);
 *   - on the installed TypeScript 5.8.3, `handleNoEmitOptions` (typescript.js:128854) returns
 *     `program.emitBuildInfo(...)` on the `options.noEmit` branch and RETURNS THERE — before the
 *     `noEmitOnError` block that is the only path to `getDeclarationDiagnostics()`. So under this
 *     configuration declaration diagnostics are unreachable in the CLI too, which is why omitting
 *     them here is parity rather than a shortcut. (Measured on this project for good measure:
 *     `getDeclarationDiagnostics()` yields 0 even when called directly.)
 *   - with no buildInfo path configured, that `emitBuildInfo` writes nothing and returns no
 *     diagnostics: measured on this project, `program.emit()` → 0 diagnostics and 0 `writeFile`
 *     calls, `program.emitBuildInfo()` → 0 diagnostics. A project that DID set `incremental` or
 *     `composite` could get a diagnostic out of that call (a TS5033 write failure), so this
 *     reasoning does not transfer to one.
 *   - and the check that does not depend on reading the compiler's source at all: the real CLI
 *     parity fixture. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
 *     --pretty false` and this child produce the SAME 62 signatures / 82 occurrences, exactly (see
 *     the parity block at the top of this file). Whatever emit does or does not contribute, it
 *     demonstrably contributes the same nothing to both.
 *
 * `noEmit` is passed as an option override for exactly the same reason the npm script passes
 * `--noEmit` on the command line.
 *
 * `message` is the HEAD of the diagnostic's message chain — the text the CLI prints on the
 * diagnostic's own line, with the chain's children on the indented lines below it. The baseline
 * was built from those head lines, which is why the chain is flattened and cut at the first
 * newline rather than joined.
 *
 * `file` is the compiler's ABSOLUTE path, which `signatureCounts` then makes repo-relative. The
 * CLI instead prints a path already relativized against its working directory, and the two agree
 * exactly for every file INSIDE the project — which is every file this project compiles, and why
 * the measured parity is exact. They would differ for a file outside the project root, where the
 * CLI prints a `../…` form and this signs with the absolute path; that signature is in no
 * baseline under either spelling, so such a file surfaces as a new error either way.
 *
 * Throws on anything it cannot turn into a diagnostic. That is the point: the child's caller
 * converts a throw into a non-zero exit with stderr, which the parent refuses outright — an
 * unusable project must never be able to look like a clean one.
 */
function collectDiagnostics(cwd) {
  const ts = requireFromHere('typescript');
  const configPath = join(cwd, 'tsconfig.app.json');

  // An UNRECOVERABLE config diagnostic (the file is absent, or its JSON is not an object) is
  // reported through this callback and makes the parse return undefined. The CLI prints exactly
  // these as positionless diagnostics and exits non-zero, so they are carried as diagnostics here
  // too — a missing tsconfig becomes `|TS5083|Cannot read file …`, which no baseline contains and
  // which therefore fails the gate as a new error.
  const unrecoverable = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: () => cwd,
    onUnRecoverableConfigFileDiagnostic: (d) => { unrecoverable.push(d); },
  });

  let diagnostics;
  if (!parsed) {
    // ...but a parse that failed WITHOUT saying why is not a diagnostic set at all, and emitting
    // an empty envelope for it would be a false green of the worst kind. Refuse instead.
    if (unrecoverable.length === 0) {
      throw new Error(`${configPath} could not be parsed, and the compiler reported no reason`);
    }
    diagnostics = unrecoverable;
  } else {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
    });
    const all = [...program.getConfigFileParsingDiagnostics()];
    const configErrors = all.length;
    all.push(...program.getSyntacticDiagnostics());
    if (all.length === configErrors) {
      all.push(...program.getOptionsDiagnostics());
      all.push(...program.getGlobalDiagnostics());
      if (all.length === configErrors) all.push(...program.getSemanticDiagnostics());
    }
    diagnostics = ts.sortAndDeduplicateDiagnostics(all);
  }

  return diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ({
      file: d.file ? d.file.fileName : null,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0],
    }));
}

/** Write every byte, or throw. `process.stdout.write` on a pipe is asynchronous and a subsequent
 *  `process.exit` can truncate it — which would produce a SHORT envelope, the one shape a
 *  byte-comparing parent must never be handed by accident rather than by fault. `writeSync` can
 *  return a partial count, so it loops. */
function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** The child's whole entry point. Every failure becomes stderr plus a non-zero exit, and nothing
 *  is ever written to stdout except one complete envelope: the serialization is built in full
 *  before a single byte leaves, so a throw mid-collection leaves stdout empty rather than partial. */
function emitDiagnostics(cwd = process.cwd()) {
  try {
    const diagnostics = collectDiagnostics(cwd);
    writeAll(1, `${serializeEnvelope({ protocol: PROTOCOL, completed: true, diagnostics })}\n`);
    return 0;
  } catch (e) {
    writeAll(2, `${(e && e.stack) || String(e)}\n`);
    return 1;
  }
}

// ── THE PARENT ────────────────────────────────────────────────────────────────────────────────

/** The zero-length channel. A `Buffer` and not `''`, because every consumer below judges these
 *  channels as bytes; a string here would be refused as "not raw bytes", which is correct but
 *  would be reporting a transport defect this function is supposed to not have. */
const NO_BYTES = Buffer.alloc(0);

/**
 * Run the type-check in an isolated child and hand back its raw transport result. Never throws:
 * the caller decides what a given shape means, which is the whole point — a thrown error used to
 * be indistinguishable from a clean run.
 *
 * `spawnSync`, not `execFileSync`, and that is a correctness requirement rather than a preference:
 * `execFileSync` RETURNS stdout, so on a successful child there is no stderr to inspect at all and
 * the "stderr must be empty" rule would be unenforceable exactly where it matters most. `spawnSync`
 * reports stdout, stderr, status, signal and spawn errors on every exit path.
 *
 * AND NO `encoding`, WHICH IS THE SECOND HALF OF THE SAME REQUIREMENT. With `encoding: 'utf8'`
 * node decodes both channels before this function ever sees them: an invalid byte silently becomes
 * U+FFFD, `stderr.length` starts counting UTF-16 code units instead of bytes, and the parent's
 * byte-for-byte rule turns into a string comparison between two values the decoder has already
 * agreed about. Omitting it yields `Buffer`s, so the bytes the child actually wrote are the bytes
 * that get judged — by `classify` for stderr, and by `decodeEnvelope` for stdout.
 *
 * The two channels are passed on EXACTLY as `spawnSync` reported them, with no coercion. A missing
 * or non-Buffer channel on a non-error path is a transport anomaly, and normalising it to an empty
 * buffer would convert the most dangerous shape of all — an unreadable stderr — into the one value
 * that passes. It is forwarded as-is and refused downstream instead.
 *
 * Spawned without a shell, so a child killed by a signal reports that signal rather than arriving
 * as an opaque 128+N. `maxBuffer` is far past any plausible envelope; if it were ever exceeded,
 * `spawnSync` sets `error` and this returns a spawn failure rather than a silently truncated —
 * and therefore byte-mismatched — result.
 *
 * `cwd` is a parameter because the child resolves its project relative to it, so a test can point
 * the REAL child at a throwaway project. `typescript` is a parameter so the "there is no compiler"
 * refusal is directly exercisable without uninstalling anything.
 */
export function runDiagnostics(cwd = process.cwd(), typescript = resolveTypeScript()) {
  if (!typescript) {
    return { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES, spawnError:
      "the installed TypeScript compiler could not be resolved ('typescript')" };
  }
  const res = spawnSync(process.execPath, [SELF, CHILD_FLAG], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    env: childEnv(),
  });
  if (res.error) {
    return { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES,
      spawnError: res.error.code || res.error.message || 'spawn failed' };
  }
  return {
    status: typeof res.status === 'number' ? res.status : null,
    signal: res.signal ?? null,
    stdout: res.stdout,
    stderr: res.stderr,
    spawnError: null,
  };
}

/**
 * Decide whether a child result is a TRUSTWORTHY completed type-check, and if so what it found.
 * Pure, so every failure shape below is directly testable without provoking a real OOM.
 *
 * THE TRANSPORT IS JUDGED FIRST, WHOLE, AND WITHOUT READING THE PAYLOAD. Nothing about the
 * diagnostics — not their count, not their overlap with the baseline — can rescue a child that
 * did not complete, and `--update` branches on this same verdict, so a refusal here is also what
 * stops a non-answer from being written into the committed baseline.
 *
 * Returns `{ trusted: true, counts }` or `{ trusted: false, problem }`.
 */
export function classify(result, baseline, cwd = process.cwd()) {
  const { status, signal, stdout, stderr, spawnError = null } = result ?? {};

  // (1) IT NEVER RAN. No compiler to resolve, ENOENT, EACCES, ENOBUFS — there is no result at all.
  if (spawnError) {
    return { trusted: false, problem: `the diagnostics child could not be run (${spawnError})` };
  }

  // (2) IT WAS KILLED. A signal is never a verdict about the code — and this is checked before
  //     stdout is looked at, so a child that emitted a complete envelope and was THEN killed is
  //     still refused. (Under the byte rule it would be refused anyway only if the write were
  //     truncated; a completed write plus a kill is precisely the case that needs this rule.)
  if (signal) {
    return { trusted: false, problem: `the diagnostics child was terminated by signal ${signal}` };
  }

  // (3) NO EXIT STATUS AT ALL — a 128+N shell-reported death, or a transport that lost it.
  if (typeof status !== 'number') {
    return { trusted: false, problem: 'the diagnostics child returned no exit status' };
  }

  // (4) ANY NON-ZERO EXIT. Diagnostics are DATA in this protocol: a child that completed reports
  //     82 errors and 0 errors with the same exit 0, so non-zero can only mean the child itself
  //     failed — it threw, its compiler was unusable, node refused its options. There is no
  //     "expected non-zero" left to carve out, which is exactly why the old exit-code vocabulary
  //     (0/1/2 completed, everything else not) is gone.
  if (status !== 0) {
    const quoted = quoteBytes(stderr);
    return { trusted: false, problem:
      `the diagnostics child exited ${status}${quoted ? ` — ${quoted}` : ''}` };
  }

  // (5) STDERR IS A CLOSED CHANNEL AND ITS ONLY ACCEPTED VALUE IS ZERO BYTES — counted as BYTES,
  //     on a `Buffer`, which is what the byte in "zero bytes" now refers to. Measured: the child
  //     writes diagnostics into its envelope on stdout and leaves stderr empty. So anything here
  //     is by definition not a diagnostics result — a crash trailer, an indented stack frame, a
  //     node warning, an unfamiliar notice. Length and not emptiness-of-a-string, and certainly
  //     not `.trim()`: whitespace is a byte the child did not write, and treating it as silence
  //     was itself a finding. Nothing on this channel is parsed or classified; it is quoted (with
  //     the LOSSY decoder, and only here) purely so the refusal is legible.
  //
  //     A channel that is not a Buffer at all is refused before that, and deliberately loudly: it
  //     means something between `spawnSync` and here handed over a decoded — or absent — value,
  //     and "I could not see this channel" must never resolve to "this channel was empty".
  if (!Buffer.isBuffer(stderr)) {
    return { trusted: false, problem:
      `the diagnostics child's stderr did not arrive as raw bytes (${describeShape(stderr)}), so it cannot be shown to be empty` };
  }
  if (stderr.length !== 0) {
    return { trusted: false, problem:
      `the diagnostics child wrote ${stderr.length} byte(s) to stderr, which a completed child leaves empty (${quoteBytes(stderr)})` };
  }

  // (6) STDOUT MUST BE THE CANONICAL ENVELOPE, BYTE FOR BYTE — the raw buffer, decoded with a
  //     FATAL UTF-8 decoder and compared against a re-encoding of what was validated. This is the
  //     whole parser.
  const decoded = decodeEnvelope(stdout);
  if (!decoded.ok) return { trusted: false, problem: decoded.problem };

  const counts = signatureCounts(decoded.diagnostics, cwd);
  const total = decoded.diagnostics.length;
  const baselineTotal = Object.values(baseline ?? {}).reduce((a, b) => a + b, 0);

  // (7) A RESULT THAT SHARES NOTHING WITH A NON-EMPTY BASELINE IS INCONSISTENT WITH IT. Genuinely
  //     fixing every baseline error yields an EMPTY diagnostic list, which is handled as the clean
  //     case; a non-empty set that overlaps the baseline nowhere is a foreign result — the wrong
  //     project, the wrong root — not a verdict about this one. Kept from the previous version
  //     unchanged, as defence in depth for `--update`, which does not run the coverage gate below.
  //     (A run that overlaps the baseline only PARTIALLY is rejected too, by `baselineCoverage`,
  //     because `--update` legitimately needs that weaker guarantee.)
  if (total > 0 && baselineTotal > 0 && !Object.keys(counts).some((sig) => sig in baseline)) {
    return { trusted: false, problem: `the diagnostics child reported ${total} diagnostic(s), none of which appear in the ${Object.keys(baseline).length}-signature baseline` };
  }

  return { trusted: true, counts };
}

/**
 * SECOND GATE: is a COMPLETED result actually comparable to the known baseline?
 *
 * `classify` proves the child ran to completion and said something coherent. It cannot prove the
 * child checked EVERYTHING — and that was the hole this closes. A type-check that reported 1 of
 * the 62 baseline signatures exceeds no baseline count, so the ratchet found "no new errors" and
 * printed a green tick over a run that had type-checked almost nothing. One overlapping signature
 * is not consistency with a 62-signature baseline; it is a partial result that happens to
 * intersect it.
 *
 * So a non-clean run is comparable only if it reproduces the COMPLETE baseline: every signature,
 * at least as many times as the baseline records. Anything less is either an incomplete run or a
 * genuine fix, and the diagnostics alone cannot tell those apart — the checker must not guess,
 * and `--update` exists precisely so an operator can state which it was.
 *
 * Returns `{ complete, missing }`; `missing` names the baseline signatures the run did not
 * reproduce in full, so the failure can say exactly what was not seen.
 */
export function baselineCoverage(counts, baseline) {
  const missing = Object.entries(baseline ?? {})
    .filter(([sig, n]) => ((counts ?? {})[sig] || 0) < n)
    .map(([sig]) => sig);
  return { complete: missing.length === 0, missing };
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * The whole gate. `run` and the console are injected so every branch — including the ones that
 * only occur when a machine runs out of memory — is exercisable by a direct test without
 * provoking the real condition. Returns the process exit code rather than calling `process.exit`,
 * for the same reason.
 */
export function main({ run = runDiagnostics, argv = process.argv, cwd = process.cwd(),
  log = console.log, err = console.error } = {}) {
  const update = argv.includes('--update');

  if (!update && !existsSync(BASELINE)) {
    err('No tsc baseline. Generate it with:  node scripts/check-tsc-baseline.mjs --update');
    return 1;
  }
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};

  const verdict = classify(run(cwd), baseline, cwd);

  // NO TRUSTWORTHY COMPARISON HAPPENED — so this is an error, and it says which one. It is NOT
  // reported as "no new type errors": the script has no idea whether there are any.
  if (!verdict.trusted) {
    err(`\n❌ tsconfig.app.json — the type-check did not produce a trustworthy result: ${verdict.problem}.`);
    err('\nNo baseline comparison was performed, so this is NOT a statement that the code is clean.');
    err(`Re-run the check; if it keeps failing this way the type-checker itself needs attention`);
    err(`(a heap-exhausted child is the known cause — it dies mid-run and emits no envelope.`);
    err(`This run gave the child ${CHILD_HEAP_MB} MB unless NODE_OPTIONS already carried a cap, or`);
    err(`carried quoting this script will not second-guess — in either case NODE_OPTIONS wins.)`);
    return 1;
  }
  const current = verdict.counts;

  // `--update` REWRITES THE BASELINE, so it demands the same trusted result as the gate: a
  // truncated run here would silently ERASE known errors from the baseline, which is strictly
  // worse than a false green. It is reached only past the guard above.
  if (update) {
    const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    log(`Wrote ${BASELINE}: ${Object.keys(sorted).length} signatures, ${sum(sorted)} errors.`);
    return 0;
  }

  // THE COMPLETENESS GATE, AND WHY IT IS SEPARATE FROM `--update`. A completed non-clean run is
  // only comparable to the baseline if it reproduced ALL of it. A run reporting a strict subset
  // is refused here rather than ratcheted against, because "I fixed 61 things" and "I only
  // checked one file" produce the identical diagnostic set and only the operator knows which.
  //
  // `sum(current) > 0` is exactly "not the clean case": an envelope with an empty diagnostic list
  // is a completed zero-error type-check, so a genuinely clean run skips this and is reported
  // below — with its shrink hint, which is therefore reachable ONLY from a completed zero-error
  // run.
  const coverage = baselineCoverage(current, baseline);
  if (sum(current) > 0 && !coverage.complete) {
    err(`\n❌ tsconfig.app.json — the type-check did not reproduce the known baseline: ${coverage.missing.length} of ${Object.keys(baseline).length} baseline signature(s) are absent from a run that reported ${sum(current)} diagnostic(s).`);
    err('\nA COMPLETE type-check finds every baseline error. A run that finds only some of them is');
    err('either incomplete — truncated output, a partially checked project, the wrong tsconfig — or');
    err('the missing errors were genuinely fixed. Those two are indistinguishable from diagnostics');
    err('alone, so this fails closed instead of guessing. Missing:');
    err(coverage.missing.slice(0, 8).map((sig) => `  - ${sig.split('|')[0]}`).join('\n'));
    err('\nIf you fixed them, run `node scripts/check-tsc-baseline.mjs --update` and commit the smaller baseline.');
    return 1;
  }

  const newErrors = [];
  for (const [sig, n] of Object.entries(current)) {
    const allowed = baseline[sig] || 0;
    if (n > allowed) newErrors.push(`  +${n - allowed}  ${sig.replaceAll('|', '  ')}`);
  }
  // The same rule the gate above applies, reused rather than restated: a signature "appears
  // fixed" exactly when the run did not reproduce it in full. Past the gate, that can only be
  // true of a completed ZERO-error run, which is what keeps the hint below honest.
  const resolved = coverage.missing;

  if (newErrors.length) {
    err(`\n❌ tsconfig.app.json — ${newErrors.length} NEW type-error signature(s) (baseline ${sum(baseline)}, now ${sum(current)}):\n`);
    err(newErrors.join('\n'));
    err('\nFix them. If a new error is genuinely intentional, run `node scripts/check-tsc-baseline.mjs --update` and commit the baseline.');
    return 1;
  }
  log(`✅ tsconfig.app.json — no new type errors (${sum(current)} pre-existing, baseline ${sum(baseline)}).`);
  // The shrink hint is reachable only from a trusted, completed run — which is what makes it a
  // hint rather than an invitation to bake a truncated result into the baseline.
  if (resolved.length) {
    log(`\nℹ️  ${resolved.length} baseline signature(s) appear fixed — run \`--update\` to shrink the baseline (optional):`);
    log(resolved.slice(0, 8).map((sig) => `  - ${sig.split('|')[0]}`).join('\n'));
  }
  return 0;
}

// Run only when invoked as a script, so a test can import the pieces above without spawning
// anything. The CHILD branch is checked FIRST and returns without touching the baseline: this one
// file is both sides of the protocol, and `--emit-diagnostics` is unambiguously the child.
if (process.argv[1] && SELF === process.argv[1]) {
  process.exit(process.argv.includes(CHILD_FLAG) ? emitDiagnostics() : main());
}
