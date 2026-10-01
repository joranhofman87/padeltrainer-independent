// @vitest-environment node
//
// DIRECT EVIDENCE FOR `scripts/check-tsc-baseline.mjs` — the type-check ratchet's own gate.
//
// WHY THIS FILE EXISTS. The ratchet used to funnel every failure into one `catch` that read
// `e.stdout || ''` and carried on, so a type-checker that ran out of heap, was killed, or never
// started produced an empty diagnostic set, exceeded no baseline signature, and printed a green
// tick. Reproduced on this repo at a 1.9 GB peak against node's default cap: `✅ … (0 pre-existing,
// baseline 82)`, exit 0, having found NONE of the 82 errors it exists to see. That is a claim
// about failure shapes, and failure shapes are what a normal green CI run never exercises — so
// they are exercised here, deliberately.
//
// AND THE THING BEING TESTED IS NO LONGER A TEXT PARSER. Four reviews found the same class of
// defect in the checker's reading of the compiler's HUMAN output — a wrapper notice with an open
// tail, a `Found N errors.` summary the compiler does not emit but which was recognised anyway,
// an indented stack frame accepted as a "continuation", a contradictory trailer that survived by
// being indented, `stderr.trim()` treating whitespace as silence, and an `execFileSync` return
// value that structurally cannot carry stderr on a SUCCESSFUL child. Each patch could only move
// the hole, because compiler text has no version, no framing and no end marker.
//
// So the checker now speaks a versioned canonical envelope, emitted by an isolated child that
// uses the repository's own TypeScript compiler API, and the parent requires stdout to be
// BYTE-FOR-BYTE the canonical serialization of what it validated. This file proves both halves:
// the REAL child really produces those bytes and really reproduces the 82-error baseline, and the
// parent's decoder really refuses every deviation — including the six historical ones above,
// which are now structurally unreachable rather than individually blocked.
//
// AND THE TRANSPORT IS RAW BYTES, WHICH IS THE SEVENTH FINDING AND A DIFFERENT CLASS FROM THE SIX.
// The byte rule was stated correctly and implemented over decoded text: `spawnSync` was called
// with `encoding: 'utf8'`, so an invalid byte became U+FFFD before the parent could look at it,
// stderr was judged as a string, and "byte-for-byte" was really string-to-string between two
// values node's decoder had already reconciled. Every fixture below therefore injects a `Buffer`,
// composed as bytes or composed as text and then ENCODED — never decoded to a string first, which
// is the exact mistake under test. A string on either channel is itself refused, so a future
// `encoding: 'utf8'` cannot pass this file.
//
// The baseline, the npm script, the tsconfig, the workflow and its contract are untouched by this
// file; it only reads the baseline to build realistic inputs, and asserts its bytes never change.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Diagnostic = { file: string | null; code: string; message: string };
type Envelope = { protocol: string; completed: boolean; diagnostics: Diagnostic[] };
type ChildResult = {
  status: number | null; signal: string | null;
  stdout: Buffer; stderr: Buffer; spawnError: string | null;
};

// Imported through a runtime URL rather than a literal specifier: the checker is `.mjs` and this
// project does not enable `allowJs`, so a static import would itself be a new type error — in the
// very gate under test. The module runs nothing on import (its entry point is guarded), so this
// only exposes the pieces.
const CHECKER_URL = new URL('../../scripts/check-tsc-baseline.mjs', import.meta.url).href;
const checker = await import(/* @vite-ignore */ CHECKER_URL) as {
  PROTOCOL: string;
  serializeEnvelope: (envelope: Envelope) => string;
  decodeEnvelope: (stdout: unknown) =>
    { ok: boolean; problem?: string; diagnostics?: Diagnostic[] };
  signatureCounts: (diagnostics: Diagnostic[], cwd?: string) => Record<string, number>;
  classify: (r: unknown, baseline: Record<string, number>, cwd?: string) =>
    { trusted: boolean; problem?: string; counts?: Record<string, number> };
  baselineCoverage: (counts: Record<string, number>, baseline: Record<string, number>) =>
    { complete: boolean; missing: string[] };
  childEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  resolveTypeScript: () => string | null;
  runDiagnostics: (cwd?: string, typescript?: string | null) => ChildResult;
  main: (o: Record<string, unknown>) => number;
};

const REPO = resolve(process.cwd());
const BASELINE_PATH = resolve(REPO, 'scripts/tsc-app.baseline.json');
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;

/** The committed baseline, re-expressed as the STRUCTURED diagnostics a completed child emits for
 *  it. Line/column never appear, because the protocol does not carry them — which is the same
 *  reason the signature drops them. An empty file field round-trips to `null`, the positionless
 *  shape (TS5083, TS2688). */
const baselineDiagnostics = (extra: Diagnostic[] = []): Diagnostic[] => {
  const out: Diagnostic[] = [];
  for (const [sig, n] of Object.entries(BASELINE)) {
    const [file, code, ...rest] = sig.split('|');
    for (let i = 0; i < n; i += 1) {
      out.push({ file: file === '' ? null : file, code, message: rest.join('|') });
    }
  }
  return [...out, ...extra];
};

/** The canonical TEXT for a diagnostic set — built with the checker's OWN serializer, so every
 *  "noncanonical" fixture below is a stated, visible deviation from it rather than a second
 *  encoder that might merely disagree. */
const envelopeText = (diagnostics: Diagnostic[]): string =>
  `${checker.serializeEnvelope({ protocol: checker.PROTOCOL, completed: true, diagnostics })}\n`;

/** ...AND THE BYTES, which are what the parent actually judges. Every fixture in this file reaches
 *  the parent as a `Buffer`: composed directly as bytes when the deviation IS a byte, or composed
 *  as text and then encoded when it is a shape. Never the other way round — nothing here decodes
 *  bytes into a string and injects the string, because that is the defect under test. */
const envelope = (diagnostics: Diagnostic[]): Buffer =>
  Buffer.from(envelopeText(diagnostics), 'utf8');

/** A byte-empty channel: a zero-length `Buffer`, not `''`. The difference is the whole point. */
const NO_BYTES = Buffer.alloc(0);

/** A completed child result carrying exactly those diagnostics. */
const completed = (diagnostics: Diagnostic[]): ChildResult => ({
  status: 0, signal: null, stdout: envelope(diagnostics), stderr: NO_BYTES, spawnError: null,
});

/** Run `main` with an injected child result, capturing everything it would have printed. */
const run = (result: unknown, argv: string[] = []) => {
  const out: string[] = [];
  const code = checker.main({
    run: () => result, argv, cwd: REPO,
    log: (...a: unknown[]) => out.push(a.join(' ')),
    err: (...a: unknown[]) => out.push(a.join(' ')),
  });
  return { code, text: out.join('\n') };
};

/**
 * Prove a result is refused by the gate AND cannot be written into the baseline by `--update`,
 * with the committed bytes byte-identical either way.
 *
 * BOTH HALVES MATTER, and the second is the worse one. `--update` branches on the same `classify`
 * verdict the gate does, so a shape that is trusted-but-empty does not merely mis-report one run:
 * it REWRITES the committed baseline over the top of 82 known errors and makes the ratchet
 * permanently blind to them. Every refusal below is therefore checked on both paths.
 */
const refusedAndCannotUpdate = (
  result: Record<string, unknown>, label: string, expected: RegExp,
) => {
  const before = readFileSync(BASELINE_PATH, 'utf8');

  const gate = run(result);
  expect(gate.code, label).toBe(1);
  expect(gate.text, label).toMatch(expected);
  expect(gate.text, label).toContain('No baseline comparison was performed');
  expect(gate.text, label).not.toContain('✅');
  expect(gate.text, label).not.toContain('no new type errors');
  expect(readFileSync(BASELINE_PATH, 'utf8'), `${label} (gate must not write)`).toBe(before);

  const upd = run(result, ['--update']);
  expect(upd.code, label).toBe(1);
  expect(upd.text, label).not.toContain('Wrote');
  expect(upd.text, label).not.toContain('✅');
  expect(readFileSync(BASELINE_PATH, 'utf8'), `${label} (--update must not write)`).toBe(before);
};

describe('check-tsc-baseline: a completed envelope is judged exactly as before', () => {
  it('round-trips the committed baseline through the canonical bytes, signature for signature', () => {
    // Everything else rests on this: if the decoder or the signature model under-counts, "no new
    // errors" becomes meaningless. Round-tripping the real 82-error/62-signature baseline through
    // serialize → decode → sign pins all three at once.
    const decoded = checker.decodeEnvelope(envelope(baselineDiagnostics()));
    expect(decoded.ok).toBe(true);
    expect(decoded.diagnostics).toHaveLength(82);
    expect(checker.signatureCounts(decoded.diagnostics as Diagnostic[], REPO)).toEqual(BASELINE);
  });

  it('accepts the exact baseline and reports no new errors', () => {
    const { code, text } = run(completed(baselineDiagnostics()));
    expect(code).toBe(0);
    expect(text).toContain('no new type errors (82 pre-existing, baseline 82)');
  });

  it('REJECTS a new app-project type error', () => {
    const { code, text } = run(completed(baselineDiagnostics([
      { file: 'src/lib/pricing.ts', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
    ])));
    expect(code).toBe(1);
    expect(text).toContain('1 NEW type-error signature(s)');
    expect(text).toContain('src/lib/pricing.ts');
    expect(text).not.toContain('✅');
  });

  it('reports a genuine baseline shrink ONLY from a completed zero-error run', () => {
    // The one path that may print the shrink hint: the child COMPLETED and found nothing, so every
    // baseline signature is genuinely gone. Note what makes this safe now — completion is a
    // declared field of the envelope, not an inference from an exit code plus an empty stream.
    const { code, text } = run(completed([]));
    expect(code).toBe(0);
    expect(text).toContain('no new type errors (0 pre-existing, baseline 82)');
    expect(text).toContain(`${Object.keys(BASELINE).length} baseline signature(s) appear fixed`);
  });

  it('REFUSES a completed run that reproduces only PART of the baseline', () => {
    // THE COMPLETENESS HOLE. One signature short of the baseline exceeds no baseline count, so the
    // ratchet finds "no new errors". A run that reports 61 of 62 signatures is either an incomplete
    // type-check or a genuine fix, and nothing in the diagnostics distinguishes them.
    const [first] = Object.keys(BASELINE);
    const kept = baselineDiagnostics().filter(
      (d) => `${d.file ?? ''}|${d.code}|${d.message}` !== first);
    const { code, text } = run(completed(kept));
    expect(code).toBe(1);
    expect(text).toContain('did not reproduce the known baseline');
    expect(text).toContain('1 of 62 baseline signature(s) are absent');
    expect(text).toContain(first.split('|')[0]);
    expect(text).not.toContain('✅');
    expect(text).not.toContain('no new type errors');
    // ...and it names the remedy rather than leaving an operator to guess.
    expect(text).toContain('--update');
  });

  it('REFUSES a one-signature overlap — the shape that used to print a green tick', () => {
    // The extreme of the same rule, and the exact reproduction of the OOM symptom: a run that
    // type-checked almost nothing still intersects the baseline somewhere.
    const [first] = baselineDiagnostics();
    const r = run(completed([first]));
    expect(r.code).toBe(1);
    expect(r.text).toContain('61 of 62 baseline signature(s) are absent');
    expect(r.text).not.toContain('✅');
  });

  it('REFUSES a run that reproduces every signature but not every OCCURRENCE', () => {
    // COUNTS ARE PART OF THE BASELINE, not just the signature set: 62 signatures carry 82 errors,
    // so a run that finds each file once has still not reproduced the baseline. Comparing key sets
    // alone would pass this.
    const multi = Object.entries(BASELINE).find(([, n]) => n > 1);
    expect(multi, 'the baseline must carry a repeated signature for this control to mean anything')
      .toBeDefined();
    const [dupSig] = multi as [string, number];
    let dropped = false;
    const short = baselineDiagnostics().filter((d) => {
      if (dropped || `${d.file ?? ''}|${d.code}|${d.message}` !== dupSig) return true;
      dropped = true;
      return false;
    });
    const { code, text } = run(completed(short));
    expect(code).toBe(1);
    expect(text).toContain('did not reproduce the known baseline');
    expect(text).toContain('1 of 62 baseline signature(s) are absent');
  });

  it('separates "the child completed" from "the result is comparable", as two rules', () => {
    // The two gates are deliberately distinct functions, because `--update` needs the FIRST and
    // the ratchet needs BOTH: a partial run must be refusable as a verdict while still being a
    // legitimate basis for an operator-authored baseline rewrite.
    const partial = baselineDiagnostics().slice(0, 5);
    const verdict = checker.classify(completed(partial), BASELINE, REPO);
    expect(verdict.trusted).toBe(true);
    expect(checker.baselineCoverage(verdict.counts as Record<string, number>, BASELINE).complete)
      .toBe(false);
    // ...and the complete set satisfies both.
    const full = checker.signatureCounts(baselineDiagnostics(), REPO);
    expect(checker.baselineCoverage(full, BASELINE)).toEqual({ complete: true, missing: [] });
    // A run carrying the whole baseline PLUS a new error is still "comparable" — that is what lets
    // the ratchet report the new error instead of hiding it behind a completeness refusal.
    expect(checker.baselineCoverage({ ...full, 'src/new.ts|TS2322|nope.': 1 }, BASELINE).complete)
      .toBe(true);
  });

  it('counts a POSITIONLESS diagnostic under an empty file field, so it surfaces as new', () => {
    // `error TS5083: Cannot read file …` and `error TS2688: Cannot find type definition file …`
    // carry no file position; in the envelope that is `file: null`. They sign with an EMPTY file
    // field, which no baseline entry has, so a broken project configuration surfaces as a new
    // error instead of vanishing — even riding a complete baseline, where the completeness gate
    // could not see it.
    const positionless: Diagnostic = {
      file: null, code: 'TS2688', message: "Cannot find type definition file for 'node'." };
    expect(checker.signatureCounts([positionless], REPO))
      .toEqual({ "|TS2688|Cannot find type definition file for 'node'.": 1 });
    const { code, text } = run(completed(baselineDiagnostics([positionless])));
    expect(code).toBe(1);
    expect(text).toContain('1 NEW type-error signature(s)');
    expect(text).toContain('TS2688');
    expect(text).not.toContain('✅');
  });
});

describe('check-tsc-baseline: the transport is refused before anything is compared', () => {
  // Each entry is a way the child can fail to produce an answer. Before the repair EVERY one of
  // them printed the green tick and exited 0, because each arrives as an exception carrying little
  // or no stdout — indistinguishable, to the old `catch`, from a clean compile.
  const CANONICAL = envelope(baselineDiagnostics());

  const UNTRUSTWORTHY: Array<[string, Record<string, unknown>, RegExp]> = [
    ['the child never started (ENOENT)',
      { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES, spawnError: 'ENOENT' },
      /could not be run \(ENOENT\)/],
    ['there is no compiler to resolve',
      { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES,
        spawnError: "the installed TypeScript compiler could not be resolved ('typescript')" },
      /could not be run/],
    ['the transport overflowed its buffer (ENOBUFS)',
      { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES, spawnError: 'ENOBUFS' },
      /could not be run \(ENOBUFS\)/],
    ['the child was killed by a signal (the OOM abort)',
      { status: null, signal: 'SIGABRT', stdout: NO_BYTES, stderr: NO_BYTES, spawnError: null },
      /terminated by signal SIGABRT/],
    ['the child was OOM-killed by the kernel',
      { status: null, signal: 'SIGKILL', stdout: NO_BYTES, stderr: NO_BYTES, spawnError: null },
      /terminated by signal SIGKILL/],
    ['there is no exit status at all',
      { status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES, spawnError: null },
      /no exit status/],
    // THE SHARPEST KILL CONTROL, and the reason the signal rule is checked BEFORE stdout. The
    // payload is byte-perfect — the whole 82-diagnostic canonical envelope — and only the death is
    // different. A parent that decoded first and asked about the process afterwards would print a
    // green tick over a child that did not finish.
    ['a child that emitted the WHOLE canonical envelope and was then killed',
      { status: null, signal: 'SIGKILL', stdout: CANONICAL, stderr: NO_BYTES, spawnError: null },
      /terminated by signal SIGKILL/],
    // ...and the same payload with a non-zero exit. Under this protocol diagnostics are DATA, so a
    // completed child exits 0 whether it found 82 errors or none; non-zero can only mean the child
    // itself failed, and there is no "expected non-zero" left to carve out.
    ['a child that emitted the whole envelope and then exited 1',
      { status: 1, signal: null, stdout: CANONICAL, stderr: NO_BYTES, spawnError: null },
      /exited 1/],
    ['a child that exited with a heap-abort code',
      { status: 134, signal: null, stdout: NO_BYTES, stderr: NO_BYTES, spawnError: null },
      /exited 134/],
    ['a child that threw, and said so on stderr',
      { status: 1, signal: null, stdout: NO_BYTES,
        stderr: Buffer.from('Error: Debug Failure. False expression.\n    at Object.crash (tsc.js:1:1)\n', 'utf8'),
        spawnError: null },
      /exited 1 — Error: Debug Failure/],
    // THE HEAP FATAL. No marker list decides this any more: the child died, so it exited non-zero
    // with an empty stdout, and the fatal text is quoted only to make the refusal legible.
    ['node printed its heap fatal',
      { status: 134, signal: null, stdout: NO_BYTES,
        stderr: Buffer.from('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'utf8'),
        spawnError: null },
      /exited 134 — FATAL ERROR: Reached heap limit/],
    // A DEAD CHILD'S STDERR NEED NOT BE TEXT AT ALL, and formatting the refusal must not throw on
    // it. These bytes are not valid UTF-8; they are quoted with a LOSSY decoder, which is the only
    // place in the checker where lossy decoding is allowed — the verdict was already taken.
    ['a child that died leaving bytes that are not UTF-8 on stderr',
      { status: 134, signal: null, stdout: NO_BYTES,
        stderr: Buffer.from([0xff, 0xfe, 0x46, 0x41, 0x54, 0x41, 0x4c]), spawnError: null },
      /exited 134 — /],
  ];

  it.each(UNTRUSTWORTHY)('fails closed when %s', (_label, result, expected) => {
    const { code, text } = run(result);
    expect(code).toBe(1);
    // It says WHICH failure, and says plainly that no comparison happened...
    expect(text).toMatch(expected);
    expect(text).toContain('No baseline comparison was performed');
    // ...and cannot have printed any form of success.
    expect(text).not.toContain('✅');
    expect(text).not.toContain('no new type errors');
  });

  it('REFUSES ANY nonempty stderr on a COMPLETED child — zero bytes, not "no visible content"', () => {
    // THE CHANNEL RULE, AND THE TWO FINDINGS IT CLOSES. A completed child writes its envelope to
    // stdout and leaves stderr at zero bytes, so anything here is by definition not a diagnostics
    // result. Every fixture below carries the byte-perfect canonical envelope on stdout, so the
    // ONLY thing that can refuse it is the stderr rule.
    //
    // Byte LENGTH and not emptiness-of-a-string, and certainly not `.trim()`: whitespace-only
    // stderr was blessed by an earlier version of this very file, and "whitespace is silence" is a
    // judgement about content — the child wrote bytes it does not write, and that is the whole
    // signal. The last three fixtures are bytes that no string comparison would characterise the
    // same way: a lone NUL, and sequences that are not valid UTF-8 at all.
    for (const [label, bytes] of [
      ['a whitespace-only stderr', Buffer.from('\n  \n', 'utf8')],
      ['a single stray newline', Buffer.from('\n', 'utf8')],
      ['an indented stack frame', Buffer.from('    at Object.crash (runner.js:1:1)', 'utf8')],
      ['a tab-indented frame',
        Buffer.from('\tat Module._compile (node:internal/modules/cjs/loader:1105:14)', 'utf8')],
      ['a node warning', Buffer.from('(node:123) WARNING: Exited the environment with code 0', 'utf8')],
      ['an unknown notice', Buffer.from('Debugger listening on ws://127.0.0.1:9229/', 'utf8')],
      ['a crash trailer', Buffer.from('Error: Debug Failure. False expression.', 'utf8')],
      ['the heap fatal alongside a complete envelope',
        Buffer.from('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'utf8')],
      ['a single NUL byte', Buffer.from([0x00])],
      ['a lone invalid byte', Buffer.from([0xff])],
      ['a truncated multi-byte sequence', Buffer.from([0xe2, 0x82])],
    ] as const) {
      refusedAndCannotUpdate(
        { status: 0, signal: null, stdout: CANONICAL, stderr: bytes, spawnError: null },
        label, /wrote \d+ byte\(s\) to stderr/);
      // ...and the count in that message is a BYTE count. `'\n  \n'` is 4 of each so it proves
      // nothing; the multi-byte fixture below is where the two numbers diverge.
    }
    // THE COUNT IS BYTES, NOT CHARACTERS — three characters, six bytes, and the refusal says six.
    // Under the previous string transport this said three, which is the smaller symptom of the
    // same defect: the parent was counting something the child never wrote.
    const sixBytes = Buffer.from('€€', 'utf8');
    expect(sixBytes.length).toBe(6);
    expect(sixBytes.toString('utf8').length).toBe(2);
    const byteCount = run({ status: 0, signal: null, stdout: CANONICAL, stderr: sixBytes, spawnError: null });
    expect(byteCount.code).toBe(1);
    expect(byteCount.text).toContain('wrote 6 byte(s) to stderr');

    // A STDERR THAT IS NOT RAW BYTES IS REFUSED OUTRIGHT — including the empty string, which is
    // the shape the previous `encoding: 'utf8'` transport produced. "I cannot see this channel"
    // must never resolve to "this channel was empty", so re-introducing a decoding transport
    // fails here rather than passing silently.
    for (const [label, notBytes, shape] of [
      ['an empty STRING stderr — the old decoded transport', '', 'string'],
      ['a nonempty string stderr', 'boom', 'string'],
      ['an undefined stderr', undefined, 'undefined'],
      ['a null stderr', null, 'null'],
      ['a bare Uint8Array stderr', new Uint8Array(0), 'Uint8Array'],
    ] as const) {
      refusedAndCannotUpdate(
        { status: 0, signal: null, stdout: CANONICAL, stderr: notBytes, spawnError: null },
        label, new RegExp(`stderr did not arrive as raw bytes \\(${shape}\\)`));
    }

    // ...while a byte-EMPTY stderr alongside the same stdout is the passing case, so this rule is
    // discriminating rather than merely strict.
    expect(run({ status: 0, signal: null, stdout: CANONICAL, stderr: NO_BYTES, spawnError: null }).code)
      .toBe(0);
  });
});

describe('check-tsc-baseline: only the canonical envelope is an answer', () => {
  const CANONICAL_TEXT = envelopeText(baselineDiagnostics());
  const CANONICAL = envelope(baselineDiagnostics());
  /** Every fixture becomes BYTES before it reaches the parent. The shape deviations below are
   *  natural to express as text, so they are written as text and encoded here — the one direction
   *  that is allowed. */
  const asChild = (stdout: string | Buffer): Record<string, unknown> => ({
    status: 0, signal: null, stderr: NO_BYTES, spawnError: null,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'),
  });

  it('REFUSES stdout that is not byte-for-byte the canonical serialization', () => {
    // THE RULE THAT REPLACES THE GRAMMAR. None of these deviations is enumerated anywhere in the
    // checker: they fail because re-serializing what was parsed does not reproduce what arrived.
    // That is why this closes the open-ended cases a line grammar could only chase — including
    // the exact two the last review found, which are marked below.
    for (const [label, stdout] of [
      ['a prefix before the envelope', `starting type-check\n${CANONICAL_TEXT}`],
      ['a suffix after the envelope', `${CANONICAL_TEXT}Found 5 errors.\n`],
      // REVIEW FINDING: an INDENTED contradictory trailer. Under a line grammar it rode through as
      // a "continuation" of the diagnostic above it. Here it is simply not the canonical bytes.
      ['an indented contradictory trailer', `${CANONICAL_TEXT}  Found 0 errors.\n`],
      ['a second trailing newline', `${CANONICAL_TEXT}\n`],
      ['no trailing newline at all', CANONICAL_TEXT.slice(0, -1)],
      ['leading whitespace', `  ${CANONICAL_TEXT}`],
      ['a truncated envelope', `${CANONICAL_TEXT.slice(0, 4000)}\n`],
      ['a mid-write truncation with no newline', CANONICAL_TEXT.slice(0, 4000)],
      ['nothing at all', ''],
      ['prose instead of an envelope', 'the type-checker is fine, honestly\n'],
      ['a bare JSON array', '[]\n'],
      ['a JSON null', 'null\n'],
      ['a JSON string', '"padeltrainer.tsc-diagnostics.v1"\n'],
    ] as const) {
      refusedAndCannotUpdate(asChild(stdout), label,
        /did not emit a padeltrainer\.tsc-diagnostics\.v1 envelope|not the canonical serialization|produced no output at all|is not a JSON object/);
    }
  });

  it('REFUSES prefix and suffix BYTES that no text fixture can express', () => {
    // The same rule at the byte level. A leading UTF-8 BOM and a trailing NUL are both invisible
    // in a terminal and both change the stream; a stray CR is the classic "same text, different
    // bytes". None of them is enumerated in the checker.
    for (const [label, bytes] of [
      ['a UTF-8 BOM before the envelope',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CANONICAL])],
      ['a trailing NUL byte', Buffer.concat([CANONICAL, Buffer.from([0x00])])],
      ['a CR before the terminating LF',
        Buffer.concat([CANONICAL.subarray(0, -1), Buffer.from([0x0d, 0x0a])])],
      ['one byte lopped off the end', CANONICAL.subarray(0, -1)],
      ['a zero-length stdout', NO_BYTES],
    ] as const) {
      expect(Buffer.isBuffer(bytes), label).toBe(true);
      expect(bytes.equals(CANONICAL), `${label} must really deviate`).toBe(false);
      refusedAndCannotUpdate(asChild(bytes), label,
        /did not emit a padeltrainer\.tsc-diagnostics\.v1 envelope|not the canonical serialization|produced no output at all/);
    }
  });

  it('REFUSES stdout that did not arrive as a Buffer — including the old decoded string', () => {
    // THE REGRESSION GUARD FOR THIS ROUND. If `encoding: 'utf8'` ever comes back to the spawn,
    // stdout arrives as a string and the parent can no longer make the guarantee it claims. It
    // refuses rather than comparing strings and calling that a byte check.
    //
    // The bare `Uint8Array` is refused for a narrower reason and deliberately so: it does carry
    // bytes, but `spawnSync` returns `Buffer`s, so anything else means a layer intervened between
    // the child and this decision. An unexplained layer is exactly what must not be trusted here,
    // and refusing is free — the real transport never produces one.
    // ...and the refusal NAMES the shape it got. `typeof` alone would flatten null, a plain
    // object and a Uint8Array all to "object", which is useless for finding the layer at fault.
    for (const [label, notBytes, shape] of [
      ['the canonical envelope as a STRING', CANONICAL_TEXT, 'string'],
      ['an empty string', '', 'string'],
      ['undefined', undefined, 'undefined'],
      ['null', null, 'null'],
      ['a bare Uint8Array rather than a Buffer', new Uint8Array(CANONICAL), 'Uint8Array'],
    ] as const) {
      refusedAndCannotUpdate(
        { status: 0, signal: null, stdout: notBytes, stderr: NO_BYTES, spawnError: null },
        label, new RegExp(`stdout did not arrive as raw bytes \\(${shape}\\)`));
    }
  });

  it('REFUSES pretty-printed, reordered and duplicated JSON that still parses to the right shape', () => {
    // THE HALF A STRUCTURAL CHECK CANNOT DO. Each of these validates perfectly — right members,
    // right types, right protocol, `completed: true` — and each is refused purely because its
    // BYTES are not the ones a canonical child emits. Field order and JSON spacing are protocol,
    // not presentation, and a duplicate member is a shape `JSON.parse` silently collapses.
    const diagnostics = baselineDiagnostics();
    const noncanonical: Array<[string, string]> = [
      ['pretty-printed with indentation',
        `${JSON.stringify({ protocol: checker.PROTOCOL, completed: true, diagnostics }, null, 2)}\n`],
      ['envelope members in a different order',
        `${JSON.stringify({ completed: true, protocol: checker.PROTOCOL, diagnostics })}\n`],
      ['diagnostic members in a different order',
        `${JSON.stringify({ protocol: checker.PROTOCOL, completed: true,
          diagnostics: diagnostics.map((d) => ({ message: d.message, code: d.code, file: d.file })) })}\n`],
      ['a duplicated envelope member',
        CANONICAL_TEXT.replace('"completed":true', '"completed":true,"completed":true')],
      ['a duplicated diagnostic member',
        CANONICAL_TEXT.replace('"code":"TS2322"', '"code":"TS2322","code":"TS2322"')],
    ];
    for (const [label, stdout] of noncanonical) {
      // Each fixture must really be a DEVIATION, or it would be proving nothing.
      expect(stdout, label).not.toBe(CANONICAL_TEXT);
      refusedAndCannotUpdate(asChild(stdout), label, /not the canonical serialization/);
    }
  });

  it('REFUSES invalid UTF-8 BEFORE parsing, coverage or update — not as a byte mismatch', () => {
    // THE ORDERING CLAIM, MADE CHECKABLE. A lossy decoder turns an invalid byte into U+FFFD and
    // hands on text that may well parse; the corruption then has to be caught — if at all — by
    // something downstream looking at an object the decoder already invented. A FATAL decoder
    // refuses at the transport, and the refusal MESSAGE is how that ordering is observable: these
    // say "not valid UTF-8", never "not the canonical serialization" and never a schema
    // complaint, which is only possible if the decode ran first.
    const utf8Refusal = /stdout is not valid UTF-8/;
    for (const [label, bytes] of [
      ['a lone invalid byte', Buffer.from([0xff])],
      ['an invalid byte inside the protocol name',
        Buffer.concat([CANONICAL.subarray(0, 10), Buffer.from([0x80]), CANONICAL.subarray(11)])],
      ['an invalid byte where a message would be',
        Buffer.concat([CANONICAL.subarray(0, -1), Buffer.from([0xc3, 0x28])])],
      ['a truncated multi-byte sequence at the end',
        Buffer.concat([CANONICAL.subarray(0, -1), Buffer.from([0xe2, 0x82])])],
      ['an overlong encoding of NUL',
        Buffer.concat([CANONICAL.subarray(0, -1), Buffer.from([0xc0, 0x80])])],
      ['an unpaired surrogate, encoded',
        Buffer.concat([CANONICAL.subarray(0, -1), Buffer.from([0xed, 0xa0, 0x80])])],
    ] as const) {
      refusedAndCannotUpdate(asChild(bytes), label, utf8Refusal);
      // ...and it is NOT reaching the schema or byte stages to say so.
      const { text } = run(asChild(bytes));
      expect(text, label).not.toContain('not the canonical serialization');
      expect(text, label).not.toContain('members are not exactly');
    }

    // THE DISCRIMINATING HALF: the same envelope with legitimate MULTI-BYTE content decodes,
    // round-trips and is accepted. Today's real diagnostics are pure ASCII, so without this the
    // UTF-8 handling would only ever be proven on bytes that cannot tell a decoder apart.
    const multibyte: Diagnostic = {
      file: 'src/päd/€ntry.ts', code: 'TS2322',
      message: "Type '“ok”' is not assignable to type 'ölçü — 日本語 🎾'.",
    };
    const withMultibyte = envelope(baselineDiagnostics([multibyte]));
    expect(withMultibyte.length, 'the fixture must really be multi-byte')
      .toBeGreaterThan(envelopeText(baselineDiagnostics([multibyte])).length);
    const decoded = checker.decodeEnvelope(withMultibyte);
    expect(decoded.problem).toBeUndefined();
    expect(decoded.ok).toBe(true);
    const carried = decoded.diagnostics as Diagnostic[];
    expect(carried[carried.length - 1]).toEqual(multibyte);
    // It rides the complete baseline, so it is reported as a NEW signature rather than refused —
    // proving the multi-byte path reaches the ratchet intact rather than dying in transport.
    const { code, text } = run(completed(baselineDiagnostics([multibyte])));
    expect(code).toBe(1);
    expect(text).toContain('1 NEW type-error signature(s)');
    expect(text).toContain('src/päd/€ntry.ts');
  });

  it('REFUSES unknown, missing and wrongly-typed members, naming which', () => {
    // THE HALF THE BYTE CHECK CANNOT DO: it would refuse all of these anyway, but it could not say
    // why. A structural failure that reads "unknown member" or "code is not TSnnnn" is the
    // difference between a fixable protocol mismatch and an opaque one.
    const P = checker.PROTOCOL;
    const one: Diagnostic = { file: 'src/a.ts', code: 'TS2322', message: 'nope.' };
    const malformed: Array<[string, string, RegExp]> = [
      ['an unknown envelope member',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [], extra: 1 })}\n`,
        /members are not exactly protocol, completed, diagnostics/],
      // Hand-built, because an object literal cannot carry this key — `__proto__:` in a literal
      // sets the prototype instead. `JSON.parse` makes it an ordinary OWN property (measured: no
      // prototype pollution, and `Object.keys` reports it), so the exact-key rule sees a fourth
      // member and refuses rather than silently ignoring it the way a destructuring read would.
      ['a __proto__ member',
        `{"protocol":"${P}","completed":true,"diagnostics":[],"__proto__":{"polluted":true}}\n`,
        /members are not exactly protocol, completed, diagnostics/],
      ['a missing envelope member',
        `${JSON.stringify({ protocol: P, diagnostics: [] })}\n`,
        /members are not exactly protocol, completed, diagnostics/],
      ['an unknown protocol version',
        `${JSON.stringify({ protocol: 'padeltrainer.tsc-diagnostics.v2', completed: true, diagnostics: [] })}\n`,
        /declares an unknown protocol/],
      ['diagnostics that are not an array',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: { 0: one } })}\n`,
        /carries no diagnostics array/],
      ['a diagnostic that is not an object',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: ['src/a.ts(1,1): error TS2322: nope.'] })}\n`,
        /diagnostic 0 in the envelope is not a JSON object/],
      ['a diagnostic with an unknown member',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ ...one, line: 4 }] })}\n`,
        /diagnostic 0's members are not exactly file, code, message/],
      ['a diagnostic with a missing member',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ code: 'TS2322', message: 'nope.' }] })}\n`,
        /diagnostic 0's members are not exactly file, code, message/],
      ['a file that is neither string nor null',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ ...one, file: 42 }] })}\n`,
        /diagnostic 0 has a file that is neither a string nor null/],
      ['a numeric code',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ ...one, code: 2322 }] })}\n`,
        /diagnostic 0 has a code that is not TSnnnn/],
      ['a code in the wrong shape',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ ...one, code: 'error TS2322' }] })}\n`,
        /diagnostic 0 has a code that is not TSnnnn/],
      ['a non-string message',
        `${JSON.stringify({ protocol: P, completed: true, diagnostics: [{ ...one, message: null }] })}\n`,
        /diagnostic 0 has a message that is not a string/],
    ];
    for (const [label, stdout, expected] of malformed) {
      refusedAndCannotUpdate(asChild(stdout), label, expected);
    }
  });

  it('distinguishes a COMPLETED clean result from an incomplete or invalid one', () => {
    // THE DISTINCTION THE WHOLE ROUND EXISTS FOR. "Zero diagnostics" and "no answer" used to be
    // the same bytes — an empty stream — and telling them apart was the job the text grammar kept
    // failing at. Completion is now a declared member of the envelope, so the two are different
    // objects rather than different readings of the same one.
    //
    // COMPLETED AND CLEAN: trusted, zero counts, and the shrink hint.
    const clean = { status: 0, signal: null, stdout: envelope([]), stderr: NO_BYTES, spawnError: null };
    expect(checker.classify(clean, BASELINE, REPO)).toEqual({ trusted: true, counts: {} });
    expect(run(clean).code).toBe(0);
    expect(run(clean).text).toContain('no new type errors (0 pre-existing, baseline 82)');

    // NOT COMPLETED, same empty diagnostic list, one member different: refused, and it says so.
    for (const [label, value] of [
      ['completed: false', false],
      ['completed: "true"', 'true'],
      ['completed: 1', 1],
      ['completed: null', null],
    ] as const) {
      refusedAndCannotUpdate(
        asChild(`${JSON.stringify({ protocol: checker.PROTOCOL, completed: value, diagnostics: [] })}\n`),
        label, /reported an INCOMPLETE result/);
    }

    // ...AND THE SAME INCOMPLETE FLAG CANNOT HIDE BEHIND A COMPLETE-LOOKING PAYLOAD EITHER, which
    // is what makes it a completion rule rather than an emptiness rule.
    refusedAndCannotUpdate(
      asChild(`${JSON.stringify({ protocol: checker.PROTOCOL, completed: false,
        diagnostics: baselineDiagnostics() })}\n`),
      'an incomplete envelope carrying the whole baseline', /reported an INCOMPLETE result/);
  });

  it('REFUSES a completed envelope that overlaps a non-empty baseline nowhere', () => {
    // Genuinely fixing every baseline error yields an EMPTY diagnostic list, handled as the clean
    // case above; a non-empty set that overlaps the baseline nowhere is a foreign result — the
    // wrong project, the wrong root — and `--update` does not run the coverage gate, so this is
    // where that is caught.
    refusedAndCannotUpdate(
      completed([{ file: 'src/ghost.ts', code: 'TS9999', message: 'from another project.' }]),
      'a foreign diagnostic set', /none of which appear in the 62-signature baseline/);
  });
});

describe('check-tsc-baseline: operator heap authority survives', () => {
  it('gives the child a heap unless one is already configured, and never strips an override', () => {
    expect(checker.childEnv({}).NODE_OPTIONS).toContain('--max-old-space-size=4096');
    // An operator-supplied cap wins outright — this raises a ceiling, it does not impose one.
    expect(checker.childEnv({ NODE_OPTIONS: '--max-old-space-size=99' }).NODE_OPTIONS)
      .toBe('--max-old-space-size=99');
    // ...and an unrelated NODE_OPTIONS is preserved rather than replaced.
    expect(checker.childEnv({ NODE_OPTIONS: '--enable-source-maps' }).NODE_OPTIONS)
      .toBe('--enable-source-maps --max-old-space-size=4096');

    // EVERY SPELLING NODE HONOURS, QUOTED OR NOT, because the LAST flag wins — so appending after
    // an operator's cap does not sit alongside it, it REPLACES it. Measured on this node by
    // reading `v8.getHeapStatistics()` from a child: each of these produces the same 196 MiB limit
    // that `--max-old-space-size=99` does, and appending a larger flag after any of them moves the
    // limit to the later value.
    //
    // THE QUOTED FORMS ARE THE REVIEW FINDING. `HEAP_FLAG_RE` used to require start-or-whitespace
    // before `--max`, so the leading `"` blocked the match: node honoured the operator's 99 MB
    // cap, this script appended 4096 behind it, and the child ran with 4192 MB. A ceiling somebody
    // had deliberately LOWERED came back raised.
    for (const set of [
      '--max_old_space_size=99', '--max_old-space_size=99',
      '--enable-source-maps --max_old_space_size=99', '--max_old_space_size=99 --enable-source-maps',
      '"--max-old-space-size=99"', '"--max_old_space_size=99"',
      "'--max_old_space_size=99'", '--max-old-space-size="99"',
      '--enable-source-maps "--max-old-space-size=99"',
      '"--max-old-space-size=99" --enable-source-maps',
    ]) {
      expect(checker.childEnv({ NODE_OPTIONS: set }).NODE_OPTIONS, set).toBe(set);
      // ...and the point of preserving it: no later flag of ours can override it.
      expect(checker.childEnv({ NODE_OPTIONS: set }).NODE_OPTIONS, set).not.toContain('4096');
    }

    // A VALUE THIS SCRIPT CANNOT CONFIDENTLY LEX IS PRESERVED RATHER THAN OVERRIDDEN. NODE_OPTIONS
    // has its own quoting rules (measured: `"` groups, `'` does not), and appending to a quoted or
    // escaped value could land the flag inside somebody else's value — or behind a cap the regex
    // failed to see. Standing down costs only the default; overriding could cost the operator's
    // intent, so the ambiguity fails safe in the preserving direction.
    for (const set of ['--title="my app"', "--redirect-warnings='/tmp/w log'", '--foo=a\\ b']) {
      expect(checker.childEnv({ NODE_OPTIONS: set }).NODE_OPTIONS, set).toBe(set);
    }
    // THE SEPARATE-ARGUMENT FORM IS PRESERVED TOO, for safety rather than because it works:
    // NODE_OPTIONS rejects it outright (`--max-old-space-size 99` makes node exit `bad option`),
    // so appending to such a value could never have helped. Standing down and letting node report
    // its own error beats appending a second, contradictory flag to a value already broken.
    for (const set of ['--max-old-space-size 99', '--max_old_space_size 99']) {
      expect(checker.childEnv({ NODE_OPTIONS: set }).NODE_OPTIONS, set).toBe(set);
    }
    // ...AND THE MATCH IS ANCHORED, so a longer flag that merely CONTAINS the name is not mistaken
    // for it and the default is still applied. Both of these leave node without a real cap, which
    // is precisely the case this script exists to cover.
    for (const set of ['--max-old-space-sizeXX=99', '--foo=--max-old-space-size=1']) {
      expect(checker.childEnv({ NODE_OPTIONS: set }).NODE_OPTIONS, set)
        .toBe(`${set} --max-old-space-size=4096`);
    }
  });
});

describe('check-tsc-baseline: the REAL isolated child, with nothing stubbed', () => {
  // Everything above injects a transport result. These spawn the actual child — this repository's
  // own installed TypeScript, through its compiler API — and pin what it really produces. Without
  // this block the decoder could be perfectly strict about bytes no real child ever emits.

  /** A throwaway project OUTSIDE the repository, type-checked by the SAME child through the SAME
   *  `runDiagnostics`, so these are genuine compiler results rather than approximations of them.
   *  `realpathSync` because the child reports paths under its resolved cwd, and the signature
   *  model strips exactly the cwd it is handed. */
  const scratchProject = (files: Record<string, string>, options: Record<string, unknown> = {}) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tscgate-')));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tsconfig.app.json'), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, target: 'ES2020', module: 'ESNext',
        moduleResolution: 'bundler', skipLibCheck: true, types: [], ...options,
      },
      include: ['src'],
    }));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'src', name), body);
    return dir;
  };

  it('resolves the repo\'s own TypeScript, and fails closed when there is none', () => {
    const typescript = checker.resolveTypeScript();
    expect(typescript, 'this gate is meaningless without the repo\'s own TypeScript')
      .toMatch(/[\\/]node_modules[\\/]typescript[\\/]/);
    expect(existsSync(typescript as string)).toBe(true);

    // ...and the absent-compiler branch of the REAL `runDiagnostics`, exercised without
    // uninstalling anything: it refuses before spawning, so there is no child to misread.
    const missing = checker.runDiagnostics(REPO, null);
    expect(missing).toEqual({
      status: null, signal: null, stdout: NO_BYTES, stderr: NO_BYTES,
      spawnError: "the installed TypeScript compiler could not be resolved ('typescript')",
    });
    // ...as BUFFERS on this path too, not `''`. Every exit path of the transport reports bytes.
    expect(Buffer.isBuffer(missing.stdout) && Buffer.isBuffer(missing.stderr)).toBe(true);
    refusedAndCannotUpdate(missing, 'no compiler at all', /could not be run/);
  });

  it('a CLEAN scratch project completes with an EMPTY diagnostic list, not with silence', () => {
    // The distinction the protocol exists to make, produced rather than asserted: a completed
    // zero-error child says `completed: true, diagnostics: []` — a positive statement — where the
    // CLI said nothing at all and left "clean" and "died before printing" sharing a shape.
    const dir = scratchProject({ 'ok.ts': 'export const n: number = 1;\n' });
    try {
      const real = checker.runDiagnostics(dir);
      expect(real).toEqual({
        status: 0, signal: null, stdout: envelope([]), stderr: NO_BYTES, spawnError: null });
      // ...and both channels really are Buffers, judged as bytes.
      expect(Buffer.isBuffer(real.stdout)).toBe(true);
      expect(Buffer.isBuffer(real.stderr) && real.stderr.length === 0).toBe(true);
      expect(real.stdout.equals(envelope([]))).toBe(true);
      // ...and the gate reads it as the genuine shrink case, from a run known to be complete.
      const { code, text } = run(real);
      expect(code).toBe(0);
      expect(text).toContain('no new type errors (0 pre-existing, baseline 82)');
      expect(text).toContain(`${Object.keys(BASELINE).length} baseline signature(s) appear fixed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a CONTROLLED new type error becomes a structured diagnostic the baseline rejects', () => {
    // A genuine TS2322, from the real compiler, arriving as protocol data rather than as a line of
    // text to be pattern-matched.
    const dir = scratchProject({ 'bad.ts': 'export const s: string = 1;\n' });
    const before = readFileSync(BASELINE_PATH, 'utf8');
    try {
      const real = checker.runDiagnostics(dir);
      expect({ status: real.status, signal: real.signal, spawnError: real.spawnError })
        .toEqual({ status: 0, signal: null, spawnError: null });
      expect(Buffer.isBuffer(real.stderr) && real.stderr.length === 0).toBe(true);

      const decoded = checker.decodeEnvelope(real.stdout);
      expect(decoded.problem).toBeUndefined();
      expect(decoded.diagnostics).toEqual([{
        file: join(dir, 'src', 'bad.ts'),
        code: 'TS2322',
        message: "Type 'number' is not assignable to type 'string'.",
      }]);

      // (a) ON ITS OWN it shares nothing with the 62-signature baseline, so it is refused outright
      //     and cannot be written into the baseline.
      refusedAndCannotUpdate(real as unknown as Record<string, unknown>,
        'a genuine foreign diagnostic', /none of which appear in the 62-signature baseline/);

      // (b) RIDING THE REAL BASELINE — the shape a genuine regression in this repo would have — it
      //     is reported as a NEW signature. The diagnostic is the compiler's own, unmodified.
      const [fresh] = decoded.diagnostics as Diagnostic[];
      const { code, text } = run(completed(baselineDiagnostics([fresh])));
      expect(code).toBe(1);
      expect(text).toContain('1 NEW type-error signature(s)');
      expect(text).toContain('TS2322');
      expect(text).toContain('bad.ts');
      expect(text).not.toContain('✅');
      expect(readFileSync(BASELINE_PATH, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a POSITIONLESS diagnostic from the real child arrives as file: null', () => {
    // `error TSxxxx: …` with no file position — produced by pointing the compiler at a type
    // library that is not installed. Under the text parser this shape needed its own pattern and
    // its own continuation handling; in the protocol it is simply a null field.
    const dir = scratchProject({ 'ok.ts': 'export const n: number = 1;\n' },
      { types: ['definitely-not-installed'] });
    try {
      const real = checker.runDiagnostics(dir);
      expect(real.status).toBe(0);
      expect(Buffer.isBuffer(real.stderr) && real.stderr.length === 0).toBe(true);
      const decoded = checker.decodeEnvelope(real.stdout);
      expect(decoded.diagnostics).toEqual([{
        file: null,
        code: 'TS2688',
        message: "Cannot find type definition file for 'definitely-not-installed'.",
      }]);
      // ...and it signs with an EMPTY file field, which no baseline entry has.
      expect(checker.signatureCounts(decoded.diagnostics as Diagnostic[], dir)).toEqual({
        "|TS2688|Cannot find type definition file for 'definitely-not-installed'.": 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('SEES stderr on a child that exits 0 — the defect `execFileSync` made unobservable', () => {
    // THE REVIEW FINDING, REPRODUCED LIVE RATHER THAN INJECTED. `execFileSync` RETURNS stdout, so
    // on a successful child there is no stderr value to inspect at all and the previous parent
    // hard-coded `stderr: ''`. Every "nonempty stderr is refused" rule was therefore unenforceable
    // in exactly the case that mattered: a child that completed AND wrote to stderr was trusted,
    // and `--update` would have written its diagnostics into the baseline.
    //
    // `--trace-exit` makes node print a warning to stderr when the child exits, WITHOUT changing
    // its exit code or its stdout — so this is a real child, exiting 0, emitting a byte-perfect
    // canonical envelope, with bytes on stderr. Under `spawnSync` those bytes are observed.
    const dir = scratchProject({ 'ok.ts': 'export const n: number = 1;\n' });
    const saved = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = '--trace-exit';
      const real = checker.runDiagnostics(dir);

      // The child genuinely succeeded: exit 0, no signal, and the envelope is byte-perfect...
      expect({ status: real.status, signal: real.signal, spawnError: real.spawnError })
        .toEqual({ status: 0, signal: null, spawnError: null });
      expect(real.stdout.equals(envelope([]))).toBe(true);
      // ...and yet stderr carries bytes, which only a transport that reports both channels on a
      // successful exit can see — and reports as BYTES, so this is a byte count, not a decoded
      // string's length.
      expect(Buffer.isBuffer(real.stderr)).toBe(true);
      expect(real.stderr.length).toBeGreaterThan(0);
      expect(real.stderr.includes(Buffer.from('Exited the environment with code 0', 'utf8')))
        .toBe(true);

      // So the result is refused, and cannot reach the baseline.
      refusedAndCannotUpdate(real as unknown as Record<string, unknown>,
        'a successful child that also wrote to stderr', /wrote \d+ byte\(s\) to stderr/);
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('the CHILD flag outranks --update, so the CLI cannot write a baseline while emitting', () => {
    // ONE FILE IS BOTH SIDES OF THIS PROTOCOL, so the argv dispatch is a safety boundary rather
    // than a convenience: `--emit-diagnostics` is checked BEFORE `main`, and the child branch
    // returns without ever reaching the baseline writer. Adding `--update` to a child invocation
    // must therefore emit an envelope and write nothing — proven on the real CLI, in a scratch
    // project whose diagnostics would otherwise ERASE the committed 82-error baseline.
    const dir = scratchProject({ 'ok.ts': 'export const n: number = 1;\n' });
    const before = readFileSync(BASELINE_PATH, 'utf8');
    try {
      // Spawned WITHOUT `encoding`, like the checker's own transport, so this pins the child's
      // real bytes rather than a decoding of them.
      const res = spawnSync(process.execPath,
        [resolve(REPO, 'scripts/check-tsc-baseline.mjs'), '--emit-diagnostics', '--update'],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      expect({ status: res.status, signal: res.signal }).toEqual({ status: 0, signal: null });
      expect(res.stderr.length).toBe(0);
      expect(res.stdout.equals(envelope([]))).toBe(true);
      expect(res.stdout.includes(Buffer.from('Wrote', 'utf8'))).toBe(false);
      expect(readFileSync(BASELINE_PATH, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs the REAL project through the REAL child: canonical bytes, empty stderr, exact baseline', () => {
    const real = checker.runDiagnostics(REPO);   // no stub, no injection

    // (a) THE TRANSPORT IS EXACTLY THE MEASURED ONE, AND IT IS RAW BYTES. Diagnostics are data, so
    //     a project with 82 errors still exits 0; the channel that would carry a failure is
    //     BYTE-empty, observed as a zero-length Buffer rather than as a hard-coded or decoded ''.
    expect({ status: real.status, signal: real.signal, spawnError: real.spawnError })
      .toEqual({ status: 0, signal: null, spawnError: null });
    expect(Buffer.isBuffer(real.stdout), 'stdout must arrive as raw bytes').toBe(true);
    expect(Buffer.isBuffer(real.stderr), 'stderr must arrive as raw bytes').toBe(true);
    expect(real.stderr.length).toBe(0);

    // (b) STDOUT IS ONE LINE OF CANONICAL JSON AND NOTHING ELSE: no control BYTES at all except
    //     the single terminating newline — so no ANSI, no CR, no second line, and no
    //     partially-written record. Asserted over the whole stream rather than against a list of
    //     specific control bytes, and it holds for every diagnostic shape rather than only these
    //     82, because the encoder escapes any control character inside a message.
    const body = real.stdout.subarray(0, -1);
    expect([...body].filter((b) => b < 0x20)).toEqual([]);
    expect(real.stdout.subarray(-2).equals(Buffer.from('}\n', 'utf8'))).toBe(true);

    // (c) IT DECODES, AND RE-ENCODES TO THE VERY BYTES THAT ARRIVED — a Buffer comparison, on the
    //     buffer the child actually wrote.
    const decoded = checker.decodeEnvelope(real.stdout);
    expect(decoded.problem).toBeUndefined();
    expect(decoded.ok).toBe(true);
    const diagnostics = decoded.diagnostics as Diagnostic[];
    expect(diagnostics).toHaveLength(82);
    expect(envelope(diagnostics).equals(real.stdout)).toBe(true);

    // (d) AND ITS NORMALIZED SIGNATURES ARE THE COMMITTED BASELINE, EXACTLY — 62 signatures, 82
    //     occurrences, nothing extra, nothing missing, no count different. This is the API-to-CLI
    //     parity claim, asserted on every run rather than measured once: the compiler API child is
    //     a legitimate substitute for `tsc -p tsconfig.app.json` only while this holds.
    const counts = checker.signatureCounts(diagnostics, REPO);
    expect(Object.keys(counts)).toHaveLength(62);
    expect(counts).toEqual(BASELINE);
    expect(checker.baselineCoverage(counts, BASELINE)).toEqual({ complete: true, missing: [] });

    // (e) THE VERDICT IS TRUSTED...
    expect(checker.classify(real, BASELINE, REPO)).toEqual({ trusted: true, counts: BASELINE });

    // (f) ...AND THE WHOLE GATE, ON THOSE REAL BYTES, IS GREEN AND WRITES NOTHING.
    const before = readFileSync(BASELINE_PATH, 'utf8');
    const { code, text } = run(real);
    expect(code).toBe(0);
    expect(text).toContain('no new type errors (82 pre-existing, baseline 82)');
    expect(text).not.toContain('appear fixed');
    expect(readFileSync(BASELINE_PATH, 'utf8')).toBe(before);
  }, 300_000);
});
