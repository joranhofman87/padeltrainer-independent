// ══ THE SLOT WRITE SURFACE, EXERCISED AS A UNIT ══════════════════════════════════════════════
//
// `scripts/check-abc27-trainer-source-authority.mjs` proves that no write to `availability_slots`
// is SPELLED outside `src/test/abc27SlotFixtures.ts`, and that the factory's own statements admit
// no interpolation. This file is the evidence that the guard DISCRIMINATES — that its verdicts
// are decided by the property rather than by whatever the repository happens to look like today.
//
// ONE CORPUS, TWO RUNNERS. The fixtures live in the guard itself and are imported here, so the CI
// step (`npm run check:trainer-authority:selftest`) and this unit suite exercise exactly the same
// adversarial set. A second, hand-copied corpus would drift, and the copy that drifted would be
// the one nobody ran.
//
// EVERY REFUSAL FIXTURE IS A MUTATION. Each names a way the property could be broken — a slot
// write in a suite file, the four obfuscated spellings the retired source scan's terminal review
// named as escapes, a factory statement built from a hole, a SQL-side trainer, and the three
// brand holes the round-5 review found. Every acceptance fixture is the other half: a guard that
// refuses everything proves nothing and gets deleted, so the sanctioned forms are asserted to pass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CATALOGUE_CASES, EXEMPTION_FIXTURES, EXPECTED_EXEMPTIONS, EXPECTED_EXEMPTION_DIGEST,
  EXPECTED_FACTORY_STATEMENTS, FACTORY_EXPORT_SURFACE_CASES,
  AUTHORITY_REL, CATALOGUE_REL, SUITE_REL, SELFTEST_REL,
  CATALOGUE_ENTRYPOINT_ROUTINE, EXPECTED_CATALOGUE_ENTRYPOINTS,
  WRITING_APPLY_ROUTINES,
  FACTORY_REL, FIXTURES, IMPORT_SURFACE_CASES, LEXER_CASES, MENTION_COUNT_CASES,
  ORACLE_CASES, POSITION_CASES, SCOPE_DRIFT_CASES,
  WRITING_ROUTINE_MENTIONS, analyze, analyzeFixtures, decodeUnicodeEscapes, lexSql, main,
} from '../../scripts/check-abc27-trainer-source-authority.mjs';
import {
  BOOTSTRAP_IDENTITY, assertSlotsNotForeign, canonicalTrainerId, currentIdentity, declareTrainer,
  installTrainerAuthorityHooks, mintTrainerRange, newTrainerId, noteSlotsOwned,
  requireAllOwnedByCurrentIdentity, requireOwnedByCurrentIdentity, slotOwner, testTrainer,
  trainerOwner,
} from './abc27TrainerAuthority';

/**
 * THE FROZEN SUBJECTS' BYTES, READ BEFORE ANY IMPORT EXECUTES. `vi.hoisted` runs ahead of every
 * static import of this file — the checker among them, which executes at import — so what is
 * hashed and parsed below is each subject as it was on disk before any imported code ran.
 * (Paths are spelled inline because a hoisted block cannot see this module's own bindings.)
 */
const FROZEN_BYTES = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const read = (relative: string) => readFileSync(resolve(process.cwd(), relative));
  return {
    checker: read('scripts/check-abc27-trainer-source-authority.mjs'),
    suite: read('src/test/abc27RecipientSnapshot.realpg.test.ts'),
  };
});

/**
 * One program for the whole corpus — see the guard's own note on why it is not one per fixture.
 *
 * BUILT ONCE, AT COLLECTION. Every fixture assertion below then reads a result rather than
 * type-checking anything, which is what keeps them inside the default per-test budget; the two
 * tests that DO build a program carry an explicit timeout, the way this repository's other
 * compiler-driving tests do.
 */
const { byName: results, checkedFixtureNames } =
  analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES]);

describe('ABC-27 slot write surface — the guard discriminates', () => {
  it('has a corpus that covers both directions', () => {
    // NOT A ROUND NUMBER, AND NOT A FLOOR. A corpus that quietly loses its acceptance half stops
    // being able to tell "refuses the right things" from "refuses everything".
    const refusals = FIXTURES.filter((f: { verdict: string }) => f.verdict === 'refuse');
    const acceptances = FIXTURES.filter((f: { verdict: string }) => f.verdict === 'accept');
    // ...AND THE FACTORY HALF IS COUNTED SEPARATELY. G2's rules only ever run against a file the
    // analysis was TOLD is the factory, so a corpus that lost those fixtures would leave the
    // factory's own guarantees with no adversarial evidence at all while still looking full.
    const factory = FIXTURES.filter((f: { factory?: boolean }) => f.factory);
    expect({ refusals: refusals.length, acceptances: acceptances.length, factory: factory.length })
      .toEqual({ refusals: 89, acceptances: 30, factory: 44 });
    expect(checkedFixtureNames,
      'analyzeFixtures must return the exact combined name set it checked')
      .toEqual(new Set([...FIXTURES, ...EXEMPTION_FIXTURES].map((f) => f.name)));
    expect(checkedFixtureNames.size,
      'every verdict and exemption fixture must have a distinct name')
      .toBe(FIXTURES.length + EXEMPTION_FIXTURES.length);
  });

  it('refuses a name collision between the verdict and exemption corpora inside analyzeFixtures',
    () => {
      const collidingExemption = { ...EXEMPTION_FIXTURES[0], name: FIXTURES[0].name };
      expect(() => analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES, collidingExemption]))
        .toThrow(/fixture names must be unique across the combined corpus/);
    });

  it('names every distinct collision — zero, one, two, three and several — with the whole analyzeFixtures pin as the authority',
    () => {
      // ══ A SAMPLE, NOT THE AUTHORITY ══════════════════════════════════════════════════════
      //
      // ONE collision proved only that one cardinality is refused: `size === 1` passed it and
      // waved two distinct collisions through, and `size === 1 || size === 2` would pass a
      // two-collision case and wave three through. No finite sample settles that, and this one
      // does not claim to: the predicate `duplicateFixtureNames.size > 0` is held by the
      // whole-declaration pin of `analyzeFixtures` below, where any change to it is a digest
      // mismatch. What this drives is the BEHAVIOUR at several cardinalities — zero (the combined
      // corpus at collection, which the first test holds to the exact name set), then one, two,
      // three and seven distinct collisions — each refused, each naming every colliding name once,
      // sorted; and a name repeated three times is one collision, named once.
      const colliding = (count: number) => FIXTURES.slice(0, count)
        .map((f: { name: string }) => ({ ...EXEMPTION_FIXTURES[0], name: f.name }));
      const refusal = (extra: readonly unknown[]): string => {
        try { analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES, ...extra]); return '<accepted>'; }
        catch (e) { return (e as Error).message; }
      };
      expect(checkedFixtureNames.size, 'zero collisions: the combined corpus was accepted at collection')
        .toBe(FIXTURES.length + EXEMPTION_FIXTURES.length);
      for (const count of [1, 2, 3, 7]) {
        const extra = colliding(count);
        expect(extra, `the premise: ${count} distinct fixture name(s) to collide with`)
          .toHaveLength(count);
        const message = refusal(extra);
        const names = extra.map((f: { name: string }) => f.name).sort().join(', ');
        expect(message, `${count} distinct collision(s) must be refused`)
          .toMatch(/fixture names must be unique across the combined corpus; repeated: /);
        expect(message.endsWith(`repeated: ${names}`),
          `${count} distinct collision(s) must all be named, once each, sorted: ${message}`)
          .toBe(true);
      }
      const [first] = colliding(1);
      expect(refusal([first, { ...first }]).endsWith(`repeated: ${first.name}`),
        'a name repeated three times is one collision, named once').toBe(true);
    });

  for (const fixture of FIXTURES) {
    const verb = fixture.verdict === 'refuse' ? 'refuses' : 'accepts';
    it(`${verb} ${fixture.name}: ${fixture.why}`, () => {
      const r = results.get(fixture.name);
      expect(r, `${fixture.name} produced no result at all`).toBeTruthy();
      if (fixture.verdict === 'refuse') {
        expect(r.violations.length,
          `expected a refusal; the guard accepted it`).toBeGreaterThan(0);
      } else {
        expect(r.violations.map((v: { detail: string }) => v.detail),
          'expected acceptance').toEqual([]);
      }
    });
  }

  for (const fixture of EXEMPTION_FIXTURES) {
    it(`counts the ${fixture.name} case exactly`, () => {
      const r = results.get(fixture.name);
      expect({ exemptions: r.exemptions.length, violations: r.violations.length })
        .toEqual({ exemptions: fixture.exemptions, violations: fixture.violations });
    });
  }

  it('counts an exempt site in the inventory rather than dropping it', () => {
    // A HATCH THAT ALSO HIDES THE SITE would let the tripwire go stale in the same edit that
    // opened it. The exemption suppresses the trainer-binding rule, not the census of writes.
    expect(results.get('exemption-in-comment').writeSites).toBe(1);
  });

  it('leaves the authority module and the factory clean under the guard', () => {
    const stray = results.get('<in-scope-module>');
    expect(stray ? stray.violations.map((v: { file: string; detail: string }) =>
      `${v.file} ${v.detail}`) : []).toEqual([]);
  });
});

describe('ABC-27 slot write surface — the SQL lexer boundary', () => {
  // Stated rather than inferred from a verdict: the lexer is a pure function, and every defect the
  // retired regex scan had was a consequence of guessing at exactly these boundaries.
  for (const { ok, msg } of LEXER_CASES()) {
    it(msg, () => { expect(ok).toBe(true); });
  }

  it('decodes the escape character UESCAPE names, and refuses one that is not a character', () => {
    expect(decodeUnicodeEscapes('availability\\005Fslots')).toBe('availability_slots');
    // THE CUSTOM ESCAPE IS DECODED, NOT REFUSED. This used to throw, and a round-6 review showed
    // that throwing was a fail-OPEN: the catch around the lexer asked its fallback question of the
    // undecoded text, which spells the relation nowhere.
    expect(decodeUnicodeEscapes('availability!005Fslots', '!')).toBe('availability_slots');
    const uescaped = lexSql(`SELECT public.U&"availability!005Fslots" UESCAPE '!'`);
    expect(uescaped.tokens.map((t: { value: unknown }) => String(t.value)))
      .toContain('availability_slots');
    // ...AND A COMMENT IS WHITESPACE BETWEEN THE TWO. Skipping only `\s` decoded with the default
    // escape and then read `UESCAPE` as an unrelated word, which is a different identifier.
    const spaced = lexSql(
      `SELECT public.U&"availability!005Fslots" /* c */ -- and a line comment\n UESCAPE '!'`);
    expect(spaced.tokens.map((t: { value: unknown }) => String(t.value)))
      .toContain('availability_slots');
    // ...and a UESCAPE clause this cannot read is still refused, so decoding did not become
    // guessing.
    expect(() => lexSql(`SELECT U&"x" UESCAPE 'ab'`)).toThrow(/UESCAPE/);
    expect(() => lexSql(`SELECT U&"x" UESCAPE`)).toThrow(/UESCAPE/);
  });
});

describe('ABC-27 slot write surface — the apply catalogue is audited, and G3 discriminates', () => {
  // ══ THE APPLY SIDE'S OWN ADVERSARIAL EVIDENCE ══════════════════════════════════════════════
  //
  // G2's rules run against any file the analysis is TOLD is the factory, so its adversarial cases
  // are ordinary fixtures. G3's are about a whole MODULE — an export surface, seven entrypoints,
  // three private renderers — which a one-function fixture cannot be, so each case is a SPLICE
  // into a copy of the real catalogue. That is better evidence than a synthetic module would be:
  // every one of them proves the rule notices a defect in the file the guard actually reads.
  for (const { ok, msg } of CATALOGUE_CASES({})) {
    it(msg, () => { expect(ok).toBe(true); });
  }

  it('pins every non-invoking mention with its own rationale, and nothing else', () => {
    // THE INVENTORY IS A SET OF DECIDED ANSWERS, not a blanket. Each entry names a text that
    // spells a writing apply routine WITHOUT invoking one — a catalog probe, a GRANT, an
    // installed signature, a splicing anchor, a runbook fragment, a map key — and carries the
    // sentence that says why. A pin with no rationale is a pin nobody read.
    expect(WRITING_ROUTINE_MENTIONS.length).toBe(12);
    for (const [identity, category, count, why] of WRITING_ROUTINE_MENTIONS) {
      expect(identity, 'a pin identity is sha256(category|text) truncated to 16 hex')
        .toMatch(/^[0-9a-f]{16}$/);
      // ONLY THE CATEGORIES A PIN MAY ACTUALLY CARRY. `read` and `composed` used to be listed
      // here even though the prose says neither is pinnable, so the assertion permitted a pin
      // the design forbids. It names the two that exist and the one kind that may join them.
      expect(['string', 'template-whole', 'key']).toContain(category);
      // ...AND THE COUNT IS PART OF THE PIN. A pin decides a text as many times as somebody
      // justified it; without a positive count the tripwire that refuses a NEW occurrence of an
      // already-justified name would have nothing to compare against.
      expect(count, `${identity} must pin how many occurrences were justified`)
        .toBeGreaterThan(0);
      expect((why as string).length,
        `${identity} must carry a rationale, not a placeholder`).toBeGreaterThan(60);
    }
    expect(new Set(WRITING_ROUTINE_MENTIONS.map(([id]) => id)).size,
      'two pins with one identity would let a deletion go unnoticed')
      .toBe(WRITING_ROUTINE_MENTIONS.length);
  });
});

describe('ABC-27 slot write surface — the scope tripwire is connected', () => {
  // A TRIPWIRE THAT NEVER FIRES IS A TRIPWIRE NOBODY KNOWS IS CONNECTED. No `src/test/abc27*`
  // file outside the guard's program names the guarded relation beside a write verb today, so
  // disarming the check changed nothing any sensor could see — a mutant proved exactly that by
  // surviving. These drive it against a throwaway tree instead.
  for (const { ok, msg } of SCOPE_DRIFT_CASES({})) {
    it(msg, () => { expect(ok).toBe(true); });
  }
});

describe('ABC-27 slot write surface — no reader is upstream of the registry', () => {
  // ══ THE ONE STRUCTURAL REASON SIX READER DEFECTS WERE NEVER LIVE DEFECTS ═══════════════════
  //
  // Everything the guard does is READING, and reading has been wrong ten times across these
  // batches, always in the direction that certifies. None of those could have written a row, and
  // the reason is not care: it is that `abc27TrainerAuthority.ts`, `abc27SlotFixtures.ts` and
  // `abc27ApplyCatalogue.ts` import nothing that could carry a reader's verdict to them. That is a
  // property of the import graph, and it is pinned as one — in both directions, and against the
  // real modules.
  for (const { ok, msg } of MENTION_COUNT_CASES()) {
    it(`mention count: ${msg}`, () => { expect(ok).toBe(true); });
  }
  for (const { ok, msg } of POSITION_CASES()) {
    it(`position: ${msg}`, () => { expect(ok).toBe(true); });
  }

  // ══ AND THE CLI ACTUALLY ASKS — WHICH THE CASES ABOVE DO NOT ESTABLISH ═════════════════════
  //
  // The cases drive the comparison FUNCTION. Deleting the two lines in `main` that call it left
  // every committed test green, because the real tree has no miscount to find and a clean run
  // cannot show what would have been refused. These drive `main` itself through its `analyzeFn`
  // seam with a result that is clean in every other respect, so the ONLY thing each can report
  // is the rule under test.
  const cleanResult = () => ({
    violations: [],
    // THE PINNED EXEMPTION'S OWN SHAPE, not an arbitrary `{file:'f'}` — R3 now checks the FILE
    // and the DIGEST, not only the count, so a "clean in every other respect" baseline has to be
    // clean by that rule too, or every case built on it would report R3's rule instead of its own.
    exemptions: Array.from({ length: EXPECTED_EXEMPTIONS },
      (_, i) => ({ file: SUITE_REL, line: i, digest: EXPECTED_EXEMPTION_DIGEST })),
    writeSites: new Set(Array.from(
      { length: EXPECTED_FACTORY_STATEMENTS }, (_, i) => `${FACTORY_REL}:${i}`,
    )),
    mentions: new Map(WRITING_ROUTINE_MENTIONS.map(([id, , count]) => [id, count])),
    mentionCategories: new Map(WRITING_ROUTINE_MENTIONS.map(([id, cat]) => [id, cat])),
  });
  const runMain = (mutate: (r: ReturnType<typeof cleanResult>) => void) => {
    const said: string[] = [];
    const result = cleanResult();
    mutate(result);
    const code = main({
      log: (m: string) => said.push(String(m)),
      err: (m: string) => said.push(String(m)),
      analyzeFn: () => result,
    });
    return { code, said: said.join('\n') };
  };

  it('the self-test CLI prints exactly one summary line, and both of its figures are the corpus\'s',
    () => {
      // ══ THE RECORD IS THE RUNTIME OUTPUT, NOT THE PROSE ═════════════════════════════════════
      //
      // This test used to read `docs/ABC27_ROLLOUT_RUNBOOK.md`, extract every figure its closed-
      // catalogue section stated — fixture splits, control counts, the self-test's assertion
      // total handed back through an `onCount` callback — and require each to equal what the
      // corpus produced. That made a PROSE DOCUMENT a machine-checked authority over test
      // cardinalities, and a journal that is also an assertion input cannot be written freely:
      // every batch that grew the corpus had to edit the record in the same change or go red, and
      // the record's own sections say how often that drifted anyway. The callback existed for no
      // other caller.
      //
      // Both are retired. A machine-derived cardinality now lives in exactly two kinds of place:
      // an EXECUTABLE SET EQUALITY (the corpus split pinned at the top of this file) or RUNTIME
      // OUTPUT (the self-test's own summary line). This closes the loop between the two.
      //
      // BLACK-BOX, UNIQUE, AND EXACT — a review round found the first version of this control
      // wanting on all three. It invoked `selfTest()` in-process, so the CLI's own dispatch could
      // stop calling it with nothing here noticing; it read the FIRST line that looked like a
      // summary, so a second, contradictory one was invisible; and it held the assertion total
      // only to a floor, so `${n + 1}` was as good as `${n}`. The command CI runs is therefore run
      // here as a child process; exactly one line may match the summary shape; and both figures
      // are compared against exact expectations computed from the exported corpus and case
      // generators — the same lists `selfTest` iterates, counted here independently of its own
      // counter, so a figure can move only when the corpus does.
      const cli = spawnSync(process.execPath,
        [resolve(process.cwd(), 'scripts', 'check-abc27-trainer-source-authority.mjs'), '--self-test'],
        { encoding: 'utf8', timeout: 170_000, env: { ...process.env, NO_COLOR: '1' } });
      expect(cli.error, 'the CLI must not be killed for exceeding its own timeout').toBeUndefined();
      expect(cli.status, cli.stderr).toBe(0);
      const SUMMARY_PREFIX = '✅ ABC-27 slot write surface self-test — ';
      const SUMMARY = /^✅ ABC-27 slot write surface self-test — (\d+) assertions over (\d+) synthetic fixtures, plus the real repository checked on its own\.$/;
      const candidates = `${cli.stdout}\n${cli.stderr}`.split('\n')
        .filter((line) => line.startsWith(SUMMARY_PREFIX));
      expect(candidates,
        'exactly one summary candidate across stdout and stderr, so another cannot hide')
        .toHaveLength(1);
      const stated = SUMMARY.exec(candidates[0]);
      expect(stated, 'the unique summary candidate must have the exact stable shape').not.toBeNull();
      if (stated === null) return;
      // THE EXACT EXPECTATIONS. One assertion per verdict fixture; two per exemption fixture; the
      // two inventory assertions; one per case of every case generator, in the order `selfTest`
      // runs them; and the four assertions over the real repository.
      const expectedFixtures = checkedFixtureNames.size;
      const expectedAssertions = FIXTURES.length + 2 * EXEMPTION_FIXTURES.length + 2
        + LEXER_CASES().length + ORACLE_CASES().length
        + IMPORT_SURFACE_CASES({}).length + FACTORY_EXPORT_SURFACE_CASES({}).length
        + CATALOGUE_CASES({}).length + MENTION_COUNT_CASES().length + POSITION_CASES().length
        + SCOPE_DRIFT_CASES({}).length + 4;
      expect({ assertions: Number(stated[1]), fixtures: Number(stated[2]) },
        'both figures the CLI prints are the figures the corpus and its case lists produce')
        .toEqual({ assertions: expectedAssertions, fixtures: expectedFixtures });
      // AN EXPLICIT BUDGET, for the same reason the repository-clean test below carries one: this
      // runs the FULL self-test as a child and then builds the case generators' programs and
      // temporary trees a second time to count them — seconds alone, past the unit project's
      // 15 s default under load.
    }, 180_000);

  it('pins the frozen checker and the frozen realpg suite whole — literal digests over bytes read before this file\'s static imports execute',
    () => {
      // ══ THE WHOLE FILES, BECAUSE A DECLARATION IS NOT ITS BINDING AND AN IMPORT IS NOT THE ONLY
      //    DOOR ═══════════════════════════════════════════════════════════════════════════════════
      //
      // A terminal review took the two authorities below one hop out. The checker's exported
      // `analyzeFixtures` and `selfTest` are declarations, and a declaration slice does not pin
      // the LIVE BINDING importers receive: a reassignment after the pinned declaration —
      // `analyzeFixtures = wrapper` — keeps the sole declaration, its bytes and its digest exactly
      // what they were while every importer runs the wrapper. And the realpg suite's direct calls
      // are found by their resolved static import, which cannot see a namespace acquired some
      // other way — through a computed dynamic specifier, say — and called through a property.
      // Enumerating reassignment forms or module loaders would be the open-ended recogniser this
      // file refuses to build. So each frozen subject is pinned WHOLE, by the literal SHA-256 of
      // its complete raw bytes, read before any import of this file executed; the declaration
      // slices and the call catalogue below are readings within those bytes, not authorities over
      // them. A legitimate change to either subject is an explicit repin plus a fresh deep review.
      const WHOLE_FILES = [
        ['scripts/check-abc27-trainer-source-authority.mjs', FROZEN_BYTES.checker,
          '2d2d3f0cbf8b917a4cc17cf140f4e726a144784d9cc4ccce0af48e01fb7e1546', 356_200],
        ['src/test/abc27RecipientSnapshot.realpg.test.ts', FROZEN_BYTES.suite,
          'a7b1005853b141977d3a9b4843a39e2f2e5fe5e8593aa2c6f2d86ea09fd19d60', 1_981_134],
      ] as const;
      for (const [relative, bytes, digest, length] of WHOLE_FILES) {
        expect(digest, `${relative}: the pin is a literal sha256 hex digest`).toMatch(/^[0-9a-f]{64}$/);
        expect({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
          `${relative} must be byte-for-byte the reviewed bytes, read before this file's static imports execute; `
          + 'a legitimate change is an explicit repin of the literal plus a fresh deep review')
          .toEqual({ bytes: length, sha256: digest });
      }
    });

  it('pins the checker\'s analyzeFixtures and selfTest declarations whole, by literal source-slice digest',
    () => {
      // ══ THE WHOLE DECLARATION, AS A READING WITHIN THE WHOLE-FILE PIN ══════════════════════
      //
      // This replaces two inventories. One read `selfTest`'s options binding, listed where its
      // counter may appear, its mutable bindings and its identifier-callee calls; the other proved
      // the collision predicate at one cardinality. A terminal review named what each could not
      // see — const-container state (`const observed = { count: 0 }`), a call through a property
      // (`globalThis.onCount?.(…)`), a local wrapper around `assert`; a predicate rewritten as
      // `size === 1 || size === 2`. Another inventory would have had its own blind spot, because
      // there is no oracle for JavaScript dataflow to make one complete. So the complete source
      // slice of each declaration is pinned: every statement, every callee, every write and every
      // return inside the declaration is inside the slice by construction, and a change to any of
      // them is a digest mismatch. What a slice does NOT hold is the live binding — a reassignment
      // after the declaration — and that is held by the whole-file pin above, within which these
      // slices are readings.
      //
      // THE DIGESTS ARE LITERALS FROM THE REVIEWED BYTES, never normalised and never derived from
      // the file being judged; a legitimate change to either declaration is an explicit repin of
      // the literal plus a fresh deep review. The slice is the declaration's own text — from its
      // `export` keyword to its closing brace, leading comments excluded — hashed as UTF-8, over
      // the bytes read before any import executed.
      const checkerRel = 'scripts/check-abc27-trainer-source-authority.mjs';
      const text = FROZEN_BYTES.checker.toString('utf8');
      const sf = ts.createSourceFile(checkerRel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const WHOLE: ReadonlyArray<readonly [string, string, number]> = [
        ['analyzeFixtures', '33289ebcc83b8b75393ab0c15ab9e133d71b8c8f2d48ef7182d929c0eb46e560', 3397],
        ['selfTest', 'd42d74e6a9324103b6161a788ea0056963b510b5d1feefbaec67f60d95c35616', 5136],
      ];
      const wearingTheName = (name: string): string[] => {
        const found: string[] = [];
        const visit = (node: ts.Node): void => {
          const declares = (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)
            || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionExpression(node)
            || ts.isClassDeclaration(node) || ts.isClassExpression(node)
            || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node))
            && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name;
          if (declares) found.push(`${ts.SyntaxKind[node.kind]} in ${ts.SyntaxKind[node.parent.kind]}`);
          ts.forEachChild(node, visit);
        };
        visit(sf);
        return found;
      };
      for (const [name, digest, bytes] of WHOLE) {
        // EXACTLY ONE DECLARATION OF ANY KIND wears the name, anywhere in the file, and it is the
        // module-level exported function — so no inner or later binding can answer for it.
        expect(wearingTheName(name), `${name} is declared exactly once, as a module-level function`)
          .toEqual(['FunctionDeclaration in SourceFile']);
        const declarations = sf.statements.filter(ts.isFunctionDeclaration)
          .filter((declaration) => declaration.name?.text === name);
        expect(declarations, `${name} is one top-level function declaration`).toHaveLength(1);
        const [fn] = declarations;
        if (fn === undefined) continue;
        expect((ts.getModifiers(fn) ?? []).map((modifier) => ts.SyntaxKind[modifier.kind]),
          `${name} is exported, and carries no other modifier`).toEqual(['ExportKeyword']);
        const slice = text.slice(fn.getStart(sf), fn.getEnd());
        expect(slice.startsWith(`export function ${name}(`),
          `${name}: the slice begins at its own declaration`).toBe(true);
        expect(slice.endsWith('}'), `${name}: the slice ends at its own closing brace`).toBe(true);
        expect({
          bytes: Buffer.byteLength(slice, 'utf8'),
          sha256: createHash('sha256').update(slice, 'utf8').digest('hex'),
        }, `${name}: the complete declaration must be byte-for-byte the reviewed slice; a `
          + 'legitimate change is an explicit repin of the literal plus a fresh deep review')
          .toEqual({ bytes, sha256: digest });
      }
    });

  it('every direct call of a catalogue entrypoint is pinned whole — by resolved symbol, argument object and adapter',
    () => {
      // ══ THE CALL OBJECTS ARE THE AUTHORITY, NOT A COUNT OF ONE PROPERTY ═══════════════════
      //
      // The census this replaces counted `fingerprintHex:` assignments and required each to be
      // the adapter's answer — and a terminal review appended a computed key equal to
      // `'fingerprintHex'` after the audited property: every count and every resolution held
      // while the raw value won. A count of one property says nothing about the object around
      // it. So each direct call into the catalogue is found by its RESOLVED import symbol, its
      // argument object is held to explicit non-computed property assignments with no duplicate
      // key, and the complete text of the call — callee, record, every property — is pinned,
      // keyed by the declaration and test that enclose it rather than by a line number.
      //
      // A READING WITHIN THE WHOLE-SUITE PIN. A call reached through a namespace acquired some
      // other way than the static import is not a direct call of the import and is not in this
      // catalogue; the whole-suite digest above is what refuses the suite that carries one. What
      // this proves is exactly what it reads: every direct call there is, whole.
      //
      // SHORTHAND, PRECISELY. A spread, a computed key, a method, an accessor and any duplicate
      // key are refused outright, and so is a shorthand `fingerprintHex` — each is a way to write
      // the audited property twice. A shorthand for any OTHER key (`round,`, `targets,`) is an
      // explicit, non-computed key whose value is the same-named binding: the frozen suite
      // carries three, each must resolve to a declaration in the suite, and each is listed in
      // the pin. It cannot overwrite `fingerprintHex`, because the duplicate rule and the
      // exactly-once rule read shorthand keys too.
      const suitePath = resolve(process.cwd(), SUITE_REL);
      // A one-file Program is enough to resolve every local value reference and is deliberately
      // `noResolve`: this question is lexical provenance inside the frozen suite, not whether its
      // 30,000-line import graph type-checks a second time.
      const program = ts.createProgram({
        rootNames: [suitePath],
        options: {
          module: ts.ModuleKind.ESNext, noLib: true, noResolve: true,
          target: ts.ScriptTarget.Latest,
        },
      });
      const sf = program.getSourceFile(suitePath);
      expect(sf, 'the TypeScript Program must contain the realpg suite').toBeTruthy();
      if (sf === undefined) return;
      expect(sf.text === FROZEN_BYTES.suite.toString('utf8'),
        'the tree this catalogue reads is the byte sequence pinned above, read before this file\'s static imports execute')
        .toBe(true);
      expect(program.getSyntacticDiagnostics(sf), 'the suite must parse before references are read')
        .toEqual([]);
      const checker = program.getTypeChecker();
      const declarationOf = (identifier: ts.Identifier): ts.Declaration | undefined => {
        // A shorthand property's name is a READ of a binding as well as a key; the checker
        // answers the binding only when asked for the shorthand's value symbol.
        const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
          ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
          : checker.getSymbolAtLocation(identifier);
        return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      };
      const nodesWhere = (root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] => {
        const found: ts.Node[] = [];
        const visit = (node: ts.Node): void => {
          if (predicate(node)) found.push(node);
          ts.forEachChild(node, visit);
        };
        visit(root);
        return found;
      };
      const kindIn = (node: ts.Node): string =>
        `${ts.SyntaxKind[node.kind]} in ${ts.SyntaxKind[node.parent.kind]}`;
      const declarationsNamed = (name: string): ts.Node[] => nodesWhere(sf, (node) =>
        (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)
          || ts.isBindingElement(node) || ts.isFunctionExpression(node)
          || ts.isClassDeclaration(node) || ts.isClassExpression(node)
          || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node))
        && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name);

      // ── THE ONE IMPORT, PINNED — AND NOTHING RE-EXPORTED ─────────────────────────────────
      const CATALOGUE_SPECIFIER = './abc27ApplyCatalogue';
      const catalogueImports = sf.statements.filter(ts.isImportDeclaration)
        .filter((statement) => ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === CATALOGUE_SPECIFIER);
      expect(catalogueImports.map((statement) => statement.getText(sf)),
        'the suite imports the catalogue exactly once, by name, as exactly this statement')
        .toEqual([[
          'import {',
          '  applyCommandAsActorReachability, applyCommandAsActorReceiptPrivacy,',
          '  applyCommandAsActorRefusalProbe, applyCommandAsActorRenderedBarrier, applyNormalizedCore,',
          '  applyNormalizedCoreShaped, applyNormalizedCoreShapedExtend, canonicalByteaHexFromBytes,',
          '  type CanonicalByteaHex, type RenderedArray,',
          '} from \'./abc27ApplyCatalogue\';',
        ].join('\n')]);
      const [catalogueImport] = catalogueImports;
      const clause = catalogueImport?.importClause;
      const bindings = clause?.namedBindings;
      expect(clause !== undefined && clause.name === undefined && bindings !== undefined
        && ts.isNamedImports(bindings),
      'the import is named — no default, no namespace — so every use is a resolvable identifier')
        .toBe(true);
      if (bindings === undefined || !ts.isNamedImports(bindings)) return;
      const valueImports = new Map<ts.ImportSpecifier, string>();
      const typeImports: string[] = [];
      for (const element of bindings.elements) {
        if (element.isTypeOnly) typeImports.push(element.name.text);
        else valueImports.set(element, element.name.text);
      }
      expect([...valueImports.values()].sort(),
        'the imported value surface is every pinned entrypoint and the adapter, nothing else')
        .toEqual([...EXPECTED_CATALOGUE_ENTRYPOINTS, 'canonicalByteaHexFromBytes'].sort());
      expect(typeImports.sort(), 'and two types').toEqual(['CanonicalByteaHex', 'RenderedArray']);
      // ...AND, AS READINGS WITHIN THE PINNED SUITE: no string but the import specifier names the
      // module, and the suite exports nothing. Neither is the authority for how the module is
      // acquired — a computed specifier would spell it in no string — the whole-suite digest is.
      expect(nodesWhere(sf, (node) => (ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes('abc27ApplyCatalogue')
        && node.parent !== catalogueImport).map((node) => node.parent.getText(sf)),
      'the catalogue is named by no string but its import specifier').toEqual([]);
      expect(sf.statements.filter((statement) => ts.isExportDeclaration(statement)
        || ts.isExportAssignment(statement)
        || (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? [])
          .some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)))
        .map((statement) => statement.getText(sf).slice(0, 80)),
      'the suite exports nothing').toEqual([]);

      // ── EVERY REFERENCE TO A VALUE IMPORT IS THE CALLEE OF A DIRECT CALL ─────────────────
      //
      // Found by SYMBOL, not by name: a local declaration wearing an entrypoint's name resolves
      // to itself and is not in this set, and an alias of the import — passed, bound, stored,
      // read as a property — is refused, so the catalogue below is every invocation there is.
      const direct: Array<{ callee: string; call: ts.CallExpression }> = [];
      const indirect: string[] = [];
      for (const node of nodesWhere(sf, (n) => ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent))) {
        if (!ts.isIdentifier(node)) continue;
        const declaration = declarationOf(node);
        const callee = declaration !== undefined && ts.isImportSpecifier(declaration)
          ? valueImports.get(declaration) : undefined;
        if (callee === undefined) continue;
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          direct.push({ callee, call: node.parent });
        } else {
          indirect.push(`${callee} as ${ts.SyntaxKind[node.parent.kind]}: ${node.parent.getText(sf)}`);
        }
      }
      expect(indirect, 'a catalogue value import is reached only as the callee of a direct call — '
        + 'never aliased, passed, bound, stored or read as a property').toEqual([]);
      expect([...new Set(direct.map((entry) => entry.callee))].sort(),
        'the direct-invocation catalogue and the imported value surface are one set, both ways')
        .toEqual([...valueImports.values()].sort());

      // ── THE ADAPTER: ONE DECLARATION, MODULE-LEVEL, WHOLE, RESOLVED TO THE IMPORT ─────────
      expect(declarationsNamed('fingerprintHexOf').map(kindIn),
        'exactly one declaration of any kind in the suite wears the adapter\'s name')
        .toEqual(['VariableDeclaration in VariableDeclarationList']);
      const adapterStatement = sf.statements.filter(ts.isVariableStatement)
        .find((statement) => statement.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'fingerprintHexOf'));
      expect(adapterStatement !== undefined
        && (adapterStatement.declarationList.flags & ts.NodeFlags.Const) !== 0
        && (ts.getModifiers(adapterStatement) ?? []).length === 0
        && adapterStatement.declarationList.declarations.length === 1,
      'the adapter is one unexported module-level const').toBe(true);
      expect(adapterStatement?.getText(sf), 'the adapter is exactly this complete declaration')
        .toBe([
          'const fingerprintHexOf = (value: unknown, where: string): CanonicalByteaHex => (',
          '  typeof value === \'string\'',
          '    ? value as CanonicalByteaHex',
          '    : canonicalByteaHexFromBytes(value, where));',
        ].join('\n'));
      const adapterDeclaration = adapterStatement?.declarationList.declarations[0];
      const resolvesToTheAdapter = (identifier: ts.Identifier): boolean =>
        adapterDeclaration !== undefined && declarationOf(identifier) === adapterDeclaration;
      const callableName = (node: ts.SignatureDeclaration): string => {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
        if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
          && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          return node.parent.name.text;
        }
        return `<${ts.SyntaxKind[node.kind]}>`;
      };
      const labelOf = (identifier: ts.Identifier): string => {
        const declaration = declarationOf(identifier);
        if (declaration === undefined) return `${identifier.text}:<unresolved>`;
        if (ts.isImportSpecifier(declaration)) {
          const { moduleSpecifier } = declaration.parent.parent.parent;
          return `${identifier.text}:import:${ts.isStringLiteral(moduleSpecifier)
            ? moduleSpecifier.text : '<non-literal specifier>'}`;
        }
        if (ts.isParameter(declaration)) {
          return `${identifier.text}:parameter:${callableName(declaration.parent)}`;
        }
        return `${identifier.text}:<${ts.SyntaxKind[declaration.kind]}>`;
      };
      const isDeclaredName = (identifier: ts.Identifier): boolean => {
        const { parent } = identifier;
        const declares = ts.isVariableDeclaration(parent) || ts.isParameter(parent)
          || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)
          || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)
          || ts.isTypeAliasDeclaration(parent) || ts.isTypeParameterDeclaration(parent)
          || ts.isImportSpecifier(parent) || ts.isImportClause(parent);
        return declares && ts.getNameOfDeclaration(parent) === identifier;
      };
      const isMemberName = (identifier: ts.Identifier): boolean => {
        const { parent } = identifier;
        return (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
          || (ts.isQualifiedName(parent) && parent.right === identifier);
      };
      const readsOf = (root: ts.Node): string[] => [...new Set(nodesWhere(root, (node) =>
        ts.isIdentifier(node) && !isDeclaredName(node) && !isMemberName(node))
        .map((node) => (ts.isIdentifier(node) ? labelOf(node) : '<not an identifier>')))].sort();
      expect(adapterDeclaration === undefined ? [] : readsOf(adapterDeclaration),
        'every name the adapter reads is its own parameter or the catalogue import — its one '
        + 'conversion resolves to the catalogue, not to anything declared in the suite')
        .toEqual([
          'CanonicalByteaHex:import:./abc27ApplyCatalogue',
          'canonicalByteaHexFromBytes:import:./abc27ApplyCatalogue',
          'value:parameter:fingerprintHexOf', 'where:parameter:fingerprintHexOf',
        ]);

      // ── EVERY DIRECT CALL, WHOLE ─────────────────────────────────────────────────────────
      const anchorOf = (call: ts.CallExpression): string => {
        const chain: string[] = [];
        for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
          if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
            chain.unshift(`function ${node.name.text}`);
          } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
            && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
            chain.unshift(`const ${node.parent.name.text}`);
          } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && ['it', 'test', 'describe'].includes(node.expression.text)) {
            const [title] = node.arguments;
            chain.unshift(`${node.expression.text} ${title !== undefined
              && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
              ? JSON.stringify(title.text) : '<non-literal title>'}`);
          }
        }
        return chain.join(' > ');
      };
      type ObjectShape = { keys: string[]; shorthand: string[]; problems: string[] };
      const shapeOf = (object: ts.ObjectLiteralExpression, path: string, shape: ObjectShape): void => {
        const seen = new Set<string>();
        for (const property of object.properties) {
          let key: string;
          if (ts.isPropertyAssignment(property)) {
            if (!ts.isIdentifier(property.name)) {
              shape.problems.push(`${path}: a ${ts.SyntaxKind[property.name.kind]} key`);
              continue;
            }
            key = property.name.text;
            nestedShapeOf(property.initializer, path === '' ? key : `${path}.${key}`, shape);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            key = property.name.text;
            const at = path === '' ? key : `${path}.${key}`;
            if (key === 'fingerprintHex') shape.problems.push(`${at}: a shorthand fingerprintHex`);
            const value = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
            if (value === undefined || value.getSourceFile() !== sf) {
              shape.problems.push(`${at}: a shorthand that resolves to no declaration in the suite`);
            }
            shape.shorthand.push(at);
          } else {
            shape.problems.push(`${path}: a ${ts.SyntaxKind[property.kind]}`);
            continue;
          }
          if (seen.has(key)) shape.problems.push(`${path}: duplicate key ${key}`);
          seen.add(key);
          if (path === '') shape.keys.push(key);
        }
      };
      const nestedShapeOf = (value: ts.Expression, path: string, shape: ObjectShape): void => {
        if (ts.isObjectLiteralExpression(value)) shapeOf(value, path, shape);
        if (ts.isArrayLiteralExpression(value)) {
          value.elements.forEach((element, index) => {
            nestedShapeOf(element, `${path}[${index}]`, shape);
          });
        }
      };
      const rootsOf = (expression: ts.Expression): ts.Identifier[] | undefined => {
        if (ts.isIdentifier(expression)) return [expression];
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
          return [expression.expression];
        }
        if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
          && expression.argumentExpression !== undefined
          && ts.isNumericLiteral(expression.argumentExpression)
          && expression.argumentExpression.text === '6') {
          return [expression.expression];
        }
        if (ts.isBinaryExpression(expression)
          && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          const left = rootsOf(expression.left);
          const right = rootsOf(expression.right);
          return left === undefined || right === undefined ? undefined : [...left, ...right];
        }
        return undefined;
      };
      const initializerAuthority = (initializer: ts.Expression | undefined): string => {
        if (initializer === undefined) return '<no initializer>';
        if (ts.isAwaitExpression(initializer) && ts.isCallExpression(initializer.expression)) {
          return `await:${initializer.expression.expression.getText(sf)}`;
        }
        if (ts.isCallExpression(initializer)) {
          return `call:${initializer.expression.getText(sf)}`;
        }
        if (ts.isAsExpression(initializer)) {
          return `as:${initializer.expression.getText(sf)}`;
        }
        return `<${ts.SyntaxKind[initializer.kind]}>`;
      };
      const resolvedAuthority = (identifier: ts.Identifier): string => {
        const declaration = declarationOf(identifier);
        if (declaration === undefined || declaration.getSourceFile() !== sf) {
          return `${identifier.text}:<unresolved local>`;
        }
        if (ts.isParameter(declaration)) {
          return `${identifier.text}:parameter:${callableName(declaration.parent)}`;
        }
        if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
          return `${identifier.text}:variable:${initializerAuthority(declaration.initializer)}`;
        }
        return `${identifier.text}:<${ts.SyntaxKind[declaration.kind]}>`;
      };
      // The one entrypoint with no fingerprint at all: it mints its own on the server.
      const FINGERPRINT_FREE = new Set(['applyCommandAsActorRefusalProbe']);
      expect([...FINGERPRINT_FREE].filter((name) => !EXPECTED_CATALOGUE_ENTRYPOINTS.includes(name)),
        'the fingerprint-free exception names a pinned entrypoint').toEqual([]);
      type DirectCall = {
        key: string; shorthand: string[];
        fingerprintHex: string | { callee: string; references: string[] };
        text: string;
      };
      const pinnedAdapterCalls = new Set<ts.Node>();
      const records = direct.map(({ callee, call }): DirectCall => {
        const key = `${callee} @ ${anchorOf(call)}`;
        const text = call.getText(sf);
        if (callee === 'canonicalByteaHexFromBytes') {
          // The adapter's own conversion: pinned like every other direct call, resolved above.
          return { key, shorthand: [], fingerprintHex: 'none', text };
        }
        const [, record] = call.arguments;
        expect(call.arguments.length, `${key}: a client and one argument record`).toBe(2);
        expect(record !== undefined && ts.isObjectLiteralExpression(record),
          `${key}: the argument record is an object literal`).toBe(true);
        if (record === undefined || !ts.isObjectLiteralExpression(record)) {
          return { key, shorthand: [], fingerprintHex: 'none', text };
        }
        const shape: ObjectShape = { keys: [], shorthand: [], problems: [] };
        shapeOf(record, '', shape);
        expect(shape.problems, `${key}: the argument object is explicit non-computed property `
          + 'assignments — no spread, computed, method, accessor or duplicate key, and no '
          + 'shorthand fingerprintHex').toEqual([]);
        expect(shape.keys.filter((k) => k === 'fingerprintHex').length,
          `${key}: fingerprintHex exactly once where the entrypoint takes a fingerprint, never `
          + 'otherwise').toBe(FINGERPRINT_FREE.has(callee) ? 0 : 1);
        let fingerprintHex: DirectCall['fingerprintHex'] = 'none';
        for (const property of record.properties.filter(ts.isPropertyAssignment)
          .filter((p) => ts.isIdentifier(p.name) && p.name.text === 'fingerprintHex')) {
          const init = property.initializer;
          expect(ts.isCallExpression(init) && ts.isIdentifier(init.expression)
            && resolvesToTheAdapter(init.expression),
          `${key}: fingerprintHex is initialised by a call whose callee resolves to the one `
            + 'module-level fingerprintHexOf').toBe(true);
          if (!ts.isCallExpression(init)) continue;
          pinnedAdapterCalls.add(init);
          const [first] = init.arguments;
          const roots = first === undefined ? undefined : rootsOf(first);
          fingerprintHex = {
            callee: 'fingerprintHexOf:module-const',
            references: roots?.map(resolvedAuthority) ?? ['<unlisted first-argument shape>'],
          };
        }
        return { key, shorthand: shape.shorthand, fingerprintHex, text };
      });
      expect(records.map((record) => record.key), 'every direct call has a key of its own')
        .toEqual([...new Set(records.map((record) => record.key))]);
      records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      expect(records, 'every direct call into the catalogue, whole — keyed by resolved callee '
        + 'and enclosing declaration or test, each argument object exact').toEqual([
        {
          key: 'applyCommandAsActorReachability @ const applyReachability',
          shorthand: [],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['a:parameter:applyReachability'],
          },
          text: [
            'applyCommandAsActorReachability(client, {',
            '      academy: a[0], command: a[1], round: a[2],',
            '      slots: a[3] as string[], children: a[4] as string[], targets: a[5] as string[],',
            '      fingerprintHex: fingerprintHexOf(a[6], \'the operator-reachability fingerprint\'),',
            '    })',
          ].join('\n'),
        },
        {
          key: 'applyCommandAsActorReceiptPrivacy @ it "round 9: a peer actor with a known UUID receives NULL receipt bytes; the owner replay returns the stored authority" > const applyAsActor',
          shorthand: ['round'],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['o:parameter:applyAsActor', 'reviewed:variable:await:previewNormalized'],
          },
          text: [
            'applyCommandAsActorReceiptPrivacy(c, {',
            '          academy: ACADEMY, command: cmd, round,',
            '          slots: (o.slots as string[] | undefined) ?? ser.slots,',
            '          children: (o.children as string[] | undefined) ?? ser.slots.map(() => child),',
            '          targets: (o.targets as string[] | undefined) ?? targets,',
            '          fingerprintHex: fingerprintHexOf(o.fingerprint ?? reviewed.review_fingerprint,',
            '            \'the fingerprint the receipt-privacy round presents\'),',
            '        })',
          ].join('\n'),
        },
        {
          key: 'applyCommandAsActorRefusalProbe @ it "refuses on every wrapper under unsupported isolation and unusable JWT, with one closed row"',
          shorthand: [],
          fingerprintHex: 'none',
          text: 'applyCommandAsActorRefusalProbe(c, { academy: ACADEMY })',
        },
        {
          key: 'applyCommandAsActorRenderedBarrier @ it "the rendered bytea means the same bytes whatever `standard_conforming_strings` says"',
          shorthand: [],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['fingerprint:variable:call:Buffer.from'],
          },
          text: [
            'applyCommandAsActorRenderedBarrier(recorder as never, {',
            '        academy: randomUUID(), round: randomUUID(),',
            '        fingerprintHex: fingerprintHexOf(fingerprint, \'the barrier decode fingerprint\'),',
            '        slots: [], targets: [],',
            '        sources: { kind: \'literal\', type: \'uuid\', values: [randomUUID()] },',
            '        children: { kind: \'literal\', type: \'uuid\', values: [randomUUID()] },',
            '        targetArray: { kind: \'literal\', type: \'uuid\', values: [randomUUID()] },',
            '      })',
          ].join('\n'),
        },
        {
          key: 'applyCommandAsActorRenderedBarrier @ it "two-session barriers: same-command handoff, extend NOWAIT, lifecycle fence, and manager revocation — all deterministic"',
          shorthand: [],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['v1:variable:await:previewNormalized'],
          },
          text: [
            'applyCommandAsActorRenderedBarrier(db1, {',
            '        academy: ACADEMY, round: revRound,',
            '        fingerprintHex: fingerprintHexOf(v1.review_fingerprint, \'the revoked-manager barrier fingerprint\'),',
            '        slots: serRev.slots, targets: revTargets,',
            '        sources: renderedList(serRev.slots),',
            '        children: renderedList(serRev.slots.map(() => revChild)),',
            '        targetArray: renderedList(revTargets),',
            '      })',
          ].join('\n'),
        },
        {
          key: 'applyNormalizedCore @ function applyNormalized',
          shorthand: [],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['o:parameter:applyNormalized'],
          },
          text: [
            'applyNormalizedCore(client, {',
            '    actor: (o.actor as string) ?? FIXTURE_ACTOR, academy: (o.academy as string) ?? ACADEMY,',
            '    version: p.version, kind: p.kind, command: o.command, round: p.round, expected: p.expected,',
            '    label: p.label, start: p.start, end: p.end, weeks: p.weeks, prio: p.prio, member: p.member,',
            '    pay: p.pay, strict: p.strict, mode: p.mode, split: p.split,',
            '    review: p.review, price: p.price, auto: p.auto, lead: p.lead, isub: p.isub, ibody: p.ibody,',
            '    rsub: p.rsub, rbody: p.rbody, rules: p.rules, claim: p.claim,',
            '    hFrom: p.hFrom, hTo: p.hTo, hLabel: p.hLabel,',
            '    slots: p.slots, children: p.children, targets: p.targets,',
            '    fingerprintHex: fingerprintHexOf(o.fingerprint, \'the fingerprint applyNormalized presents\'),',
            '  })',
          ].join('\n'),
        },
        {
          key: 'applyNormalizedCoreShaped @ it "review-3 closure: replay enforces the live array/holiday shape grammar before any Domain-P work" > const applyShaped',
          shorthand: ['round', 'targets'],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['fingerprint:variable:as:s1.review_fingerprint'],
          },
          text: [
            'applyNormalizedCoreShaped(c, {',
            '        actor: FIXTURE_ACTOR, academy: ACADEMY, command: o.command ?? cmd, round,',
            '        fingerprintHex: fingerprintHexOf(fingerprint, \'the shaped replay fingerprint\'),',
            '        slots: ser.slots, targets,',
            '        holidayFrom: o.hFrom ?? renderedList(hol.hFrom, \'date\'),',
            '        holidayTo: o.hTo ?? renderedList(hol.hTo, \'date\'),',
            '        holidayLabel: o.hLabel ?? renderedList(hol.hLabel, \'text\'),',
            '        sources: o.src ?? renderedList(ser.slots),',
            '        children: o.child ?? renderedList(ser.slots.map(() => child)),',
            '        targetArray: o.target ?? renderedList(targets),',
            '      })',
          ].join('\n'),
        },
        {
          key: 'applyNormalizedCoreShapedExtend @ it "review-3 closure: replay enforces the live array/holiday shape grammar before any Domain-P work"',
          shorthand: ['round'],
          fingerprintHex: {
            callee: 'fingerprintHexOf:module-const',
            references: ['e1:variable:await:previewNormalized'],
          },
          text: [
            'applyNormalizedCoreShapedExtend(c, {',
            '        actor: FIXTURE_ACTOR, academy: ACADEMY, command: eCmd, round,',
            '        fingerprintHex: fingerprintHexOf(e1.review_fingerprint, \'the extend-shape fingerprint\'),',
            '        slots: serE.slots, targets: eTargets,',
            '        sources: renderedList(serE.slots),',
            '        children: renderedList(serE.slots.map(() => eChild)),',
            '        targetArray: renderedList(eTargets),',
            '      })',
          ].join('\n'),
        },
        {
          key: 'canonicalByteaHexFromBytes @ const fingerprintHexOf',
          shorthand: [],
          fingerprintHex: 'none',
          text: 'canonicalByteaHexFromBytes(value, where)',
        },
      ]);

      // ── THE ADAPTER IS CALLED FROM THE PINNED INITIALIZERS AND FROM NOWHERE ELSE ─────────
      const adapterReferences = adapterDeclaration === undefined ? [] : nodesWhere(sf, (node) =>
        ts.isIdentifier(node) && node.parent !== adapterDeclaration && resolvesToTheAdapter(node));
      expect(adapterReferences.filter((node) => !(ts.isCallExpression(node.parent)
        && node.parent.expression === node && pinnedAdapterCalls.has(node.parent)))
        .map((node) => `${ts.SyntaxKind[node.parent.kind]}: ${node.parent.getText(sf)}`),
      'every reference to fingerprintHexOf is the callee of a pinned fingerprintHex initializer — '
        + 'no alias, no other call').toEqual([]);
      expect(adapterReferences.length,
        'and every pinned initializer is one of those references, so the two sets are equal')
        .toBe(pinnedAdapterCalls.size);
      // ...AND, AS A READING: no identifier-named `fingerprintHex` property is written anywhere
      // but at the top of a pinned argument object. A computed spelling of the same key is not
      // seen here; the whole-suite digest is what refuses it.
      const pinnedRecords = new Set<ts.Node | undefined>(direct.map(({ call }) => call.arguments[1]));
      expect(nodesWhere(sf, (node) =>
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
        && ts.isIdentifier(node.name) && node.name.text === 'fingerprintHex'
        && !pinnedRecords.has(node.parent)).map((node) => node.parent.getText(sf)),
      'no fingerprintHex property is written anywhere but at the top of a pinned argument object')
        .toEqual([]);
    }, 60_000);

  it('analyze() actually CALLS each of its three checks, proved on a throwaway tree', () => {
    // ══ A CALL THAT NOTHING DRIVES IS A CHECK THAT IS NOT WIRED ═══════════════════════════════
    //
    // The scope, import-surface and catalogue rules all have adversarial cases — but those call
    // the functions DIRECTLY. Nothing established that `analyze` still calls them: the real tree
    // is clean, so deleting a call left every committed test green, and the rule would simply
    // stop running. A clean tree cannot show what a check would have refused.
    //
    // So a throwaway copy of the program is made dirty in three different ways, one per call,
    // and `analyze` is asked. Each mutation is chosen to be refusable by exactly one of them.
    const root = mkdtempSync(join(tmpdir(), 'abc27-wiring-'));
    try {
      const PROGRAM = [AUTHORITY_REL, FACTORY_REL, CATALOGUE_REL, SUITE_REL, SELFTEST_REL];
      const plant = (edits: Readonly<Record<string, (t: string) => string>> = {}) => {
        for (const rel of PROGRAM) {
          const to = join(root, rel);
          mkdirSync(dirname(to), { recursive: true });
          const text = readFileSync(resolve(process.cwd(), rel), 'utf8');
          writeFileSync(to, edits[rel] ? edits[rel](text) : text);
        }
      };
      const detailsOf = () => (analyze({ repoRoot: root }) as {
        violations: { detail: string }[];
      }).violations.map((v) => v.detail).join(' | ');

      plant();
      expect(detailsOf(), 'THE CONTROL: an unmodified copy analyses clean').toBe('');

      // (1) THE SCOPE CALL: a sibling `abc27*` file that sends SQL and is not in the program.
      plant();
      // THE PROBE SENDS SQL WITHOUT NAMING THE GUARDED RELATION. Spelling an `INSERT` into it
      // here would put a slot write in the guard's OWN program file, which G1 refuses — it did.
      // A COMPUTED member cannot be shown not to be `.query`, which is the scope rule's other
      // arm and needs no relation name at all.
      writeFileSync(join(root, 'src', 'test', 'abc27WiringProbe.ts'),
        'declare const client: Record<string, (t: string) => Promise<unknown>>;\n'
        + 'declare const member: string;\n'
        + "export const go = () => client[member]('SELECT 1');\n");
      expect(detailsOf(), 'analyze must still ask the scope rule').toContain('OUTSIDE');

      // (2) THE IMPORT-SURFACE CALL: a dependency the authority module is not pinned to.
      plant({ [AUTHORITY_REL]: (t) => `import 'node:os';\n${t}` });
      expect(detailsOf(), 'analyze must still ask the import-surface rule')
        .toContain('not one of its pinned dependencies');

      // (3) THE CATALOGUE CALL: a statement that invokes the routine its entrypoint may not.
      // THE ROUTINE NAMES ARE DERIVED, NOT SPELLED. Writing them here would be a mention
      // outside the catalogue — G4 refused this very file for it when they were spelled.
      // Sorted, so the pair is named by position rather than by spelling: the wrapper sorts
      // first. The core statement is made to invoke the wrapper, which every structural rule
      // still accepts and only the entrypoint binding refuses.
      const [asActor, normalizedCore] = [...WRITING_APPLY_ROUTINES].sort();
      plant({
        [CATALOGUE_REL]: (t) => t.replace(
          `const APPLY_NORMALIZED_CORE = \`SELECT * FROM public.${normalizedCore}(`,
          `const APPLY_NORMALIZED_CORE = \`SELECT * FROM public.${asActor}(`,
        ),
      });
      expect(detailsOf(), 'analyze must still ask the catalogue rule').toContain('entitled to');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('every catalogue entrypoint has a pinned routine, so none can fail open', () => {
    // The audit refuses a statement whose entrypoint has no pinned routine, which is the right
    // behaviour for a state that must never exist. This is what stops it existing: a row deleted
    // from the table would otherwise remove the routine rule for that entrypoint silently, and
    // the swap case only covers the one entrypoint it splices.
    const missing = EXPECTED_CATALOGUE_ENTRYPOINTS
      .filter((e: string) => !(e in CATALOGUE_ENTRYPOINT_ROUTINE));
    expect(missing, 'every entrypoint must be pinned to the routine it may invoke').toEqual([]);
    const stray = Object.keys(CATALOGUE_ENTRYPOINT_ROUTINE)
      .filter((e) => !EXPECTED_CATALOGUE_ENTRYPOINTS.includes(e));
    expect(stray, 'and the table may not name an entrypoint that does not exist').toEqual([]);
    for (const [entry, routine] of Object.entries(CATALOGUE_ENTRYPOINT_ROUTINE)) {
      expect(WRITING_APPLY_ROUTINES, `${entry} must be pinned to a WRITING routine`)
        .toContain(routine);
    }
  });

  it('the CLI accepts a result that matches every pin, so the refusals below are rules', () => {
    expect(runMain(() => {}).code).toBe(0);
  });


  it('the CLI REFUSES a result carrying violations', () => {
    const { code, said } = runMain((r) => {
      r.violations.push({ file: 'src/test/x.ts', line: 7, detail: 'a planted refusal' });
    });
    expect(code, 'a violation must fail the run').toBe(1);
    expect(said).toContain('a planted refusal');
  });

  it('the CLI REFUSES an exemption count that is not the declared one', () => {
    for (const delta of [-1, +1]) {
      const { code, said } = runMain((r) => {
        if (delta > 0) {
          r.exemptions.push({ file: 'src/test/x.ts', line: 1, digest: '0'.repeat(64) });
        }
        else r.exemptions.pop();
      });
      expect(code, `${delta} exemptions must fail the run`).toBe(1);
      expect(said).toContain('expected exactly');
    }
  });

  // ══ THE COUNT IS NOT THE PIN — WHERE IT IS, AND WHAT IT EXEMPTS, ARE ═══════════════════════
  //
  // A count of one is satisfied by any single exempt write anywhere a marker is written. These
  // three each keep the count at exactly one and move ONLY the property under test, so a rule
  // that regressed to counting alone would leave all three green.
  it('the CLI REFUSES the one exemption sitting in the wrong FILE', () => {
    const { code, said } = runMain((r) => { r.exemptions[0].file = 'src/test/somewhere-else.ts'; });
    expect(code).toBe(1);
    expect(said).toContain('is not the pinned census control');
  });

  it('the CLI REFUSES the one exemption whose DIGEST is not the reviewed statement\'s', () => {
    const { code, said } = runMain((r) => { r.exemptions[0].digest = '0'.repeat(64); });
    expect(code).toBe(1);
    expect(said).toContain('is not the pinned census control');
  });

  it('the CLI ACCEPTS the one exemption at the pinned file and digest, whatever its line',
    () => {
      // THE LINE IS DELIBERATELY NOT PART OF THE PIN. An edit above the census control in a
      // 30,000-line suite moves its line number for a reason that has nothing to do with the
      // exemption, and a pin that included it would churn on unrelated changes — exactly the
      // false-positive cost this record already measured for other pins and rejected.
      const { code } = runMain((r) => { r.exemptions[0].line = 99999; });
      expect(code).toBe(0);
    });

  it('the CLI REFUSES a factory statement count that is not the pinned one', () => {
    for (const delta of [-1, +1]) {
      const { code, said } = runMain((r) => {
        if (delta > 0) r.writeSites.add(`${FACTORY_REL}:extra`);
        else r.writeSites.delete(`${FACTORY_REL}:0`);
      });
      expect(code, `${delta} factory statements must fail the run`).toBe(1);
      expect(said).toContain('expected ');
    }
  });

  it('the CLI REFUSES a pinned mention whose occurrence count moved', () => {
    const { code, said } = runMain((r) => {
      const [id, , count] = WRITING_ROUTINE_MENTIONS[0];
      r.mentions.set(id, (count as number) + 1);
    });
    expect(code, 'a changed occurrence count must fail the run').toBe(1);
    expect(said).toContain('OCCURRENCE COUNT moved');
  });

  it('the CLI REFUSES a pinned mention seen in a category other than the declared one', () => {
    const { code, said } = runMain((r) => {
      r.mentionCategories.set(WRITING_ROUTINE_MENTIONS[0][0], 'read');
    });
    expect(code, 'a pin inherited by the wrong kind of occurrence must fail the run').toBe(1);
    expect(said).toContain('declared category is not the category it is seen in');
  });
  for (const { ok, msg } of IMPORT_SURFACE_CASES({})) {
    it(msg, () => { expect(ok).toBe(true); });
  }
});

describe('ABC-27 slot write surface — the repository it guards', () => {
  // AN EXPLICIT BUDGET, because this builds a real `ts.Program` over a 29,000-line file. It
  // measures about a second on an idle machine and well past the 15 s default on a busy one, which
  // is the same reason `rehearsalSharding` and `tscBaselineChecker` carry their own timeouts.
  it('is clean, with the exact inventory and the one declared exemption', () => {
    const real = analyze({});
    expect(real.violations.map((v: { file: string; line: number; detail: string }) =>
      `${v.file}:${v.line} ${v.detail}`)).toEqual([]);
    // ...AND THE WALK RECORDS THE CATEGORY IT SAW EACH IDENTITY IN. The CLI refusal for a
    // misdeclared category is driven with an injected map, which says nothing about whether the
    // production still happens: delete the one line that records it and that test stays green
    // while the comparison becomes permanently vacuous, because an absent category is skipped.
    // Asserted HERE rather than in its own test because this is where the program is already
    // built — a second `analyze({})` costs another 20 seconds under load and timed out.
    const seenCategories = real.mentionCategories as Map<string, string>;
    expect(WRITING_ROUTINE_MENTIONS
      .filter(([id]) => !seenCategories.has(id as string)).map(([id]) => id),
    'every pinned identity must be seen WITH a category').toEqual([]);
    expect(WRITING_ROUTINE_MENTIONS
      .filter(([id, cat]) => seenCategories.get(id as string) !== cat).map(([id]) => id),
    'and it must be the category the pin declares').toEqual([]);
    const sites = [...real.writeSites] as string[];
    // BOTH HALVES OF THE INVENTORY. The factory holds exactly the stated number of statements,
    // and NOTHING outside it is counted — a site counted elsewhere would mean G1 admitted one.
    expect({
      factory: sites.filter((s) => s.startsWith(`${FACTORY_REL}:`)).length,
      elsewhere: sites.filter((s) => !s.startsWith(`${FACTORY_REL}:`) && !s.includes(':exempt:')),
      exemptions: real.exemptions.length,
    }).toEqual({
      factory: EXPECTED_FACTORY_STATEMENTS, elsewhere: [], exemptions: EXPECTED_EXEMPTIONS,
    });
    // ...AND THE ONE EXEMPTION IS THE PINNED CENSUS CONTROL, not merely one of some count. Read
    // straight off the REAL repository's own analysis, not the `runMain` mocks above, so this is
    // the end-to-end proof that what R3 pins is what the tree actually carries.
    const [exemption] = real.exemptions as Array<{ file: string; digest: string }>;
    expect({ file: exemption.file, digest: exemption.digest })
      .toEqual({ file: SUITE_REL, digest: EXPECTED_EXEMPTION_DIGEST });
  }, 180_000);

  for (const { ok, msg } of FACTORY_EXPORT_SURFACE_CASES({})) {
    it(msg, () => { expect(ok).toBe(true); });
  }
});

// ══ THE RUNTIME REGISTRY ═════════════════════════════════════════════════════════════════════
//
// The guard above is the STATIC half, and its claim is narrow: no slot write is SPELLED outside
// the factory in any text it can read. It says nothing about where a value came from — that claim
// belonged to a predecessor and a review round refused it three ways.
//
// This is the half that holds. It runs in every invocation of every suite that imports the module:
// a trainer belongs to one test, a slot belongs to one test, and a second test asking for either
// is refused AT ACQUISITION or AT THE WRITE, before a row exists.
//
// EXERCISED HERE RATHER THAN ONLY IN THE DATABASE SUITE. The property is pure bookkeeping and
// needs no database at all, so proving it costs milliseconds instead of a five-minute lineage
// replay — and a sensor that cheap is one that actually runs on every change.
installTrainerAuthorityHooks();

/** A client stub that records what the factories send, in order. */
const recordingClient = () => {
  const sent: string[] = [];
  return {
    sent,
    client: { query: async (text: string) => { sent.push(text); return { rows: [] }; } } as never,
  };
};

describe('ABC-27 trainer authority — the registry refuses reuse at acquisition', () => {
  const CONTESTED = 'eeeeeeee-0000-4000-8000-00000000ee01';

  it('the first test to ask for a trainer owns it', async () => {
    const { client } = recordingClient();
    expect(await declareTrainer(client, CONTESTED)).toBe(CONTESTED);
    expect(trainerOwner(CONTESTED)).toBe(currentIdentity());
    // ...and asking again inside the SAME test is the normal case, not a conflict.
    expect(await declareTrainer(client, CONTESTED)).toBe(CONTESTED);
  });

  it('a second test cannot acquire it, and the refusal names the owner', async () => {
    // THE REAL CROSS-TEST PATH. Run under a filter that selects only this test, the acquisition
    // would SUCCEED and this assertion would go red — a vacuous control fails in the right
    // direction, which is why the workflow contract now refuses a name filter in any CI lane.
    const { client, sent } = recordingClient();
    await expect(declareTrainer(client, CONTESTED)).rejects
      .toThrow(/already owned by ".*the first test to ask for a trainer owns it"/);
    expect(sent, 'a refused acquisition writes nothing at all').toEqual([]);
  });

  it('derives a per-test trainer, stably, and never outside a test', async () => {
    const { client, sent } = recordingClient();
    const first = await testTrainer(client);
    // ENSURED ON EVERY CALL, not memoised: a fixture that rolls its transaction back would
    // otherwise lose the `trainer_profiles` row while the id kept being handed out.
    const second = await testTrainer(client);
    expect(second).toBe(first);
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.includes('trainer_profiles') && s.includes('ON CONFLICT DO NOTHING')))
      .toBe(true);
    // A v4-shaped UUID derived from the test name, so a digest-pinned fixture stays byte-stable.
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(trainerOwner(first)).toBe(currentIdentity());
  });

  it('registers BEFORE it writes, so a refusal leaves no row behind', async () => {
    const { client, sent } = recordingClient();
    const mine = await newTrainerId(client);
    expect(trainerOwner(mine)).toBe(currentIdentity());
    expect(sent, 'exactly one upsert, and it is for the id just registered').toHaveLength(1);
    expect(sent[0]).toContain('trainer_profiles');
  });

  it('mints a contiguous range with the ids the SQL expression used to produce', async () => {
    // BYTE-IDENTICAL TO `('9e0f…' || lpad(g.i::text, 12, '0'))::uuid` over generate_series(1, n),
    // which is what lets the two ceiling fixtures keep their pinned digests while losing their
    // SQL-side trainer source.
    const { client, sent } = recordingClient();
    const range = await mintTrainerRange(client, '9e0f9e0f-0000-4000-8000-', 3);
    expect(range).toEqual([
      '9e0f9e0f-0000-4000-8000-000000000001',
      '9e0f9e0f-0000-4000-8000-000000000002',
      '9e0f9e0f-0000-4000-8000-000000000003',
    ]);
    expect(sent, 'one round trip for the whole range').toHaveLength(1);
    for (const id of range) expect(trainerOwner(id)).toBe(currentIdentity());
  });

  // TWO TESTS WITH THE SAME FULL NAME. Vitest allows it, and `currentTestName` reports one string
  // for both — so a registry keyed on the name alone would consider them one test and hand them
  // one trainer. These two are deliberately titled identically.
  it('same name, contested', async () => {
    const { client } = recordingClient();
    expect(await declareTrainer(client, 'ee000000-0000-4000-8000-00000000ee02'))
      .toBe('ee000000-0000-4000-8000-00000000ee02');
  });

  it('same name, contested', async () => {
    const { client } = recordingClient();
    await expect(declareTrainer(client, 'ee000000-0000-4000-8000-00000000ee02')).rejects
      .toThrow(/already owned by ".*same name, contested"/);
  });

  it('gives a hook the bootstrap identity, which no test name can equal', () => {
    // `currentTestName` is NOT cleared when a test ends in this Vitest version, so without the
    // insideTest flag a later `beforeAll` would acquire trainers as the PREVIOUS test.
    // AN ORDINAL, THEN THE NAME. Vitest permits two tests to share a full name, so the name alone
    // is not an identity; the ordinal makes it one while the name keeps a refusal legible.
    expect(currentIdentity()).toMatch(/^\d+:/);
    expect(currentIdentity()).toContain(expect.getState().currentTestName);
    expect(currentIdentity()).not.toBe(BOOTSTRAP_IDENTITY);
    expect(BOOTSTRAP_IDENTITY).toBe('<bootstrap: suite setup and hooks>');
  });
});

describe('ABC-27 trainer authority — the registry keys on the UUID, not on its spelling', () => {
  // PostgreSQL normalises `{AA00…}`, `aa00…` and the un-hyphenated form to ONE value, and the
  // overlap trigger sees one namespace. A registry keyed on the raw text would hand the same
  // namespace to two tests and call them different — the exact defect it exists to prevent.
  const SPELLINGS = [
    'AB000000-0000-4000-8000-0000000000AA',
    'ab000000-0000-4000-8000-0000000000aa',
    '{ab000000-0000-4000-8000-0000000000aa}',
    'ab00000000004000800000000000 00aa'.replace(/\s/g, ''),
    'ab000000000040008000000000 0000aa'.replace(/\s/g, ''),
  ];

  it('canonicalises every spelling PostgreSQL accepts to one key', () => {
    const canonical = 'ab000000-0000-4000-8000-0000000000aa';
    for (const spelling of SPELLINGS.slice(0, 3)) {
      expect(canonicalTrainerId(spelling), spelling).toBe(canonical);
    }
    expect(canonicalTrainerId('ab00000000004000800000000000 00aa'.replace(/ /g, '')))
      .toBe(canonical);
  });

  it('refuses a value that is not a UUID at all', () => {
    // Registering one would be a namespace no database row can ever carry, so the ownership it
    // records is about nothing.
    expect(() => canonicalTrainerId('not-a-uuid')).toThrow(/is not a UUID/);
    expect(() => canonicalTrainerId('')).toThrow(/is not a UUID/);
    expect(() => canonicalTrainerId('ab000000-0000-4000-8000-0000000000ag')).toThrow(/is not a UUID/);
  });

  it('issues the canonical form, and a second test cannot take it under another spelling', async () => {
    const { client } = recordingClient();
    const issued = await declareTrainer(client, SPELLINGS[0]);
    expect(issued, 'the value handed to SQL is the value the registry keyed on')
      .toBe('ab000000-0000-4000-8000-0000000000aa');
    // The SAME test, a different spelling: not a conflict.
    expect(await declareTrainer(client, SPELLINGS[2])).toBe(issued);
    expect(trainerOwner('{AB000000-0000-4000-8000-0000000000AA}'))
      .toBe(currentIdentity());
  });

  it('and the refusal follows the value across spellings', async () => {
    const { client } = recordingClient();
    await expect(declareTrainer(client, 'AB000000-0000-4000-8000-0000000000AA')).rejects
      .toThrow(/already owned by ".*issues the canonical form/);
  });
});

describe('ABC-27 ownership — the capability check that actually runs', () => {
  // ══ THIS IS THE LOAD-BEARING HALF ══════════════════════════════════════════════════════════
  //
  // The guard above refuses a slot write SPELLED outside the factory. It does not, and no longer
  // claims to, decide where a value came from — a review round defeated that claim through a
  // containing type, an aliased array and a getter, none of which needs a cast under this
  // repository's `strict: false`.
  //
  // What stops one test from writing with another's trainer is this: every factory entrypoint
  // asks the registry, at the moment it writes, about the STRING it actually received. A forged
  // brand is a string by then, and the registry has never heard of it.
  const MINE = 'fa000000-0000-4000-8000-00000000fa01';

  it('refuses an id the authority never issued, however it was typed', async () => {
    const { client } = recordingClient();
    await declareTrainer(client, MINE);
    expect(requireOwnedByCurrentIdentity(MINE)).toBe(MINE);
    // THE FORGERY, EXACTLY AS A CAST OR AN `any` WOULD DELIVER IT: a well-formed UUID that no
    // test ever acquired. The type system is satisfied and the registry is not.
    expect(() => requireOwnedByCurrentIdentity('fa000000-0000-4000-8000-00000000fa99'))
      .toThrow(/was never acquired from the authority/);
  });

  it('refuses an id another identity owns, and names it', () => {
    // MINE was acquired by the test above, so this one may not write with it.
    expect(() => requireOwnedByCurrentIdentity(MINE))
      .toThrow(/is owned by ".*refuses an id the authority never issued/);
  });

  it('checks every element of a range, not just the first', async () => {
    const { client } = recordingClient();
    const range = await mintTrainerRange(client, 'fa000000-0000-4000-8001-', 3);
    expect(requireAllOwnedByCurrentIdentity(range)).toEqual(range);
    // ONE POISONED ELEMENT IS ENOUGH. This is the shape the retired static rule was defeated by:
    // an array widened by annotation and mutated through the alias, which leaves a value the
    // checker still calls branded. Here the array is simply read.
    expect(() => requireAllOwnedByCurrentIdentity([...range, MINE]))
      .toThrow(/is owned by/);
  });

  it('keys the capability on the UUID, not on the text that spelled it', async () => {
    const { client } = recordingClient();
    await declareTrainer(client, 'fa000000-0000-4000-8002-0000000000aa');
    expect(requireOwnedByCurrentIdentity('{FA000000-0000-4000-8002-0000000000AA}'))
      .toBe('fa000000-0000-4000-8002-0000000000aa');
  });
});

describe('ABC-27 ownership — slots, for the path where no trainer is ever named', () => {
  // The apply and extend cores derive the TARGET trainer from the SOURCE SLOTS they are handed,
  // so a fixture that passes another test's slot writes into that test's overlap namespace
  // without naming a trainer at all. A slot id is an ordinary `string`, so no type sees this.
  const A = 'fb000000-0000-4000-8000-00000000fb01';
  const B = 'fb000000-0000-4000-8000-00000000fb02';

  it('claims the slots a test wrote', () => {
    noteSlotsOwned([A, B]);
    expect(slotOwner(A)).toBe(currentIdentity());
    // Re-claiming inside the same test is the normal case: a series is many slots, one test.
    noteSlotsOwned([A]);
    expect(slotOwner(A)).toBe(currentIdentity());
  });

  it('refuses a source slot belonging to another test', () => {
    expect(() => assertSlotsNotForeign([A], 'the source slots handed to previewNormalized'))
      .toThrow(/owned by ".*claims the slots a test wrote"/);
    expect(() => noteSlotsOwned([B])).toThrow(/a slot belongs to one test/);
  });

  it('leaves an id NOBODY owns alone, which several cases depend on', () => {
    // A `randomUUID()` ghost, a foreign ACADEMY's slot and a `null` are all deliberate fixtures —
    // "a caller who guesses a real UUID learns exactly what one who invents a UUID learns" is
    // itself a property under test. An id no test holds cannot carry another test's namespace.
    expect(() => assertSlotsNotForeign(
      ['fb000000-0000-4000-8000-00000000fbff', null, undefined, 'not-a-uuid', 7],
      'the source slots handed to previewNormalized')).not.toThrow();
  });
});

// ══ A HOOK IS NOT THE PREVIOUS TEST ══════════════════════════════════════════════════════════
//
// Vitest does not clear `currentTestName` when a test ends, so inside a `beforeAll` that runs
// after any test has run, it still reports that test's name. `testTrainer` derives its id from
// that name — so reading it without the `insideTest` gate would let a hook derive and acquire a
// trainer belonging to a test that has not run yet, and the test would then be refused its own id.
let hookOutcome = '<the hook did not run>';

describe('ABC-27 trainer authority — a hook may not derive a test\'s trainer', () => {
  beforeAll(async () => {
    const { client } = recordingClient();
    try {
      await testTrainer(client);
      hookOutcome = '<accepted, which is the defect>';
    } catch (e) { hookOutcome = (e as Error).message; }
  });

  it('refuses testTrainer in a hook even though currentTestName is still set', () => {
    // The premise: the name really is stale here, so the refusal is about the FLAG and not about
    // an absent name. If this ever becomes falsy the control has stopped discriminating.
    expect(expect.getState().currentTestName, 'the premise: a test name is available').toBeTruthy();
    expect(hookOutcome).toMatch(/called outside a test/);
  });
});
