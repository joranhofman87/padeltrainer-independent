// ══ THE TRAINER SOURCE AUTHORITY, EXERCISED AS A UNIT ════════════════════════════════════════
//
// `scripts/check-abc27-trainer-source-authority.mjs` is what proves that every write to
// `availability_slots` in the ABC-27 suite binds `trainer_id` to a value the authority issued.
// This file is the evidence that the guard DISCRIMINATES — that its verdicts are decided by the
// property rather than by whatever the repository happens to look like today.
//
// ONE CORPUS, TWO RUNNERS. The fixtures live in the guard itself and are imported here, so the CI
// step (`npm run check:trainer-authority:selftest`) and this unit suite exercise exactly the same
// adversarial set. A second, hand-copied corpus would drift, and the copy that drifted would be
// the one nobody ran.
//
// EVERY REFUSAL FIXTURE IS A MUTATION. Each names a way the property could be broken — a literal
// UUID, an `as`-cast, `any`, a server-chosen row, an id minted in SQL, a trainer-moving UPDATE,
// and the four obfuscated spellings the retired source scan's terminal review named as escapes it
// could not see. Every acceptance fixture is the other half: a guard that refuses everything
// proves nothing and gets deleted, so the sanctioned forms are asserted to pass.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXEMPTION_FIXTURES, EXPECTED_EXEMPTIONS, EXPECTED_WRITE_SITES, FIXTURES, LEXER_CASES,
  analyze, analyzeFixtures, decodeUnicodeEscapes, lexSql,
} from '../../scripts/check-abc27-trainer-source-authority.mjs';
import {
  BOOTSTRAP_IDENTITY, canonicalTrainerId, currentIdentity, declareTrainer,
  installTrainerAuthorityHooks, mintTrainerRange, newTrainerId, sqlFragment, sqlUuid,
  testTrainer, trainerOwner,
} from './abc27TrainerAuthority';

/**
 * One program for the whole corpus — see the guard's own note on why it is not one per fixture.
 *
 * BUILT ONCE, AT COLLECTION. Every fixture assertion below then reads a result rather than
 * type-checking anything, which is what keeps them inside the default per-test budget; the two
 * tests that DO build a program carry an explicit timeout, the way this repository's other
 * compiler-driving tests do.
 */
const results = analyzeFixtures([...FIXTURES, ...EXEMPTION_FIXTURES]);

describe('ABC-27 trainer source authority — the guard discriminates', () => {
  it('has a corpus that covers both directions', () => {
    // NOT A ROUND NUMBER, AND NOT A FLOOR. A corpus that quietly loses its acceptance half stops
    // being able to tell "refuses the right things" from "refuses everything".
    const refusals = FIXTURES.filter((f) => f.verdict === 'refuse');
    const acceptances = FIXTURES.filter((f) => f.verdict === 'accept');
    expect({ refusals: refusals.length, acceptances: acceptances.length })
      .toEqual({ refusals: 64, acceptances: 17 });
    expect(new Set(FIXTURES.map((f) => f.name)).size,
      'every fixture must have a distinct name, or one silently shadows another')
      .toBe(FIXTURES.length);
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

  it('leaves the authority module itself clean under its own guard', () => {
    expect(results.has('<authority>')).toBe(false);
  });
});

describe('ABC-27 trainer source authority — the SQL lexer boundary', () => {
  // Stated rather than inferred from a verdict: the lexer is a pure function, and every defect the
  // retired regex scan had was a consequence of guessing at exactly these boundaries.
  for (const { ok, msg } of LEXER_CASES()) {
    it(msg, () => { expect(ok).toBe(true); });
  }

  it('decodes only the escape form it implements', () => {
    expect(decodeUnicodeEscapes('availability\\005Fslots')).toBe('availability_slots');
    expect(() => lexSql(`SELECT U&"x" UESCAPE '!'`)).toThrow(/UESCAPE/);
  });
});

describe('ABC-27 trainer source authority — the repository it guards', () => {
  // AN EXPLICIT BUDGET, because this builds a real `ts.Program` over a 29,000-line file. It
  // measures about a second on an idle machine and well past the 15 s default on a busy one, which
  // is the same reason `rehearsalSharding` and `tscBaselineChecker` carry their own timeouts.
  it('is clean, with the exact inventory and the one declared exemption', () => {
    const real = analyze({});
    expect(real.violations.map((v: { file: string; line: number; detail: string }) =>
      `${v.file}:${v.line} ${v.detail}`)).toEqual([]);
    expect({ sites: real.writeSites.size, exemptions: real.exemptions.length })
      .toEqual({ sites: EXPECTED_WRITE_SITES, exemptions: EXPECTED_EXEMPTIONS });
  }, 180_000);
});

// ══ THE RUNTIME REGISTRY ═════════════════════════════════════════════════════════════════════
//
// The guard above is the STATIC half: it proves every write site binds a value the authority
// issued. This is the other half, and it is the one that runs in every invocation of every suite
// that imports the module — a trainer belongs to one test, and a second test asking for it is
// refused AT ACQUISITION, before a row exists.
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

describe('ABC-27 sql fragments — one expression, or a refusal', () => {
  // THE RULE THE STATIC READER LEANS ON. A fixture override is interpolated into a fixed slot
  // INSERT, so a text that could close its VALUES row and open another would decide a trainer no
  // reader of the template can see. Everything below is refused for that reason.
  it('accepts the expression forms the fixtures actually use', () => {
    for (const ok of [
      "'indoor'", '12.50', 'true', "'[]'::jsonb", "'[{\"a\":1}]'::jsonb", 'NULL',
      "'2026-09-01T17:00:00Z'::timestamptz + make_interval(days => 7)",
      "interval '1 hour'", "start_time + interval '90 minutes 30 seconds'",
      "'it''s quoted'", 'ab000000-0000-4000-8000-0000000000aa',
    ]) {
      expect(sqlFragment(ok), ok).toBe(ok);
    }
  });

  it('refuses anything that could change the shape of the statement around it', () => {
    for (const [bad, why] of [
      ["x), (gen_random_uuid(), '55555555-5555-4555-8555-555555555555'", 'closes its row and opens another'],
      ["'a', 'b'", 'a top-level comma is two expressions'],
      ["1; DROP TABLE x", 'a statement separator'],
      ["1 -- and the rest of the line", 'a line comment'],
      ["1 /* and the rest", 'a block comment'],
      ["(1", 'leaves a parenthesis open'],
      ["1)", 'closes a parenthesis it did not open'],
      ["'unterminated", 'an unterminated string'],
      ['"unterminated', 'an unterminated quoted identifier'],
      ['$q$ unterminated', 'an unterminated dollar-quote'],
    ] as Array<[string, string]>) {
      expect(() => sqlFragment(bad), why).toThrow(/abc27 sql fragment/);
    }
  });

  it('lexes rather than matches, so a marker inside a string is not a marker', () => {
    // `--`, `,`, `;` and `)` inside a SQL string are data, and refusing them would make the
    // validator unusable for the fixture overrides that legitimately carry them.
    for (const ok of ["'a -- b'", "'a, b'", "'a; b'", "'a) b'", "E'a\\'b'", '$q$ a, b; c $q$']) {
      expect(sqlFragment(ok), ok).toBe(ok);
    }
  });
});

describe('ABC-27 quoted literals — a UUID, or a refusal', () => {
  // `sqlFragment` promises ONE EXPRESSION, which is the right promise for an unquoted position and
  // the wrong one inside static quotes: `x', 'y` is one expression, and `'x', 'y'` is two. This is
  // the primitive for a value that belongs inside quotes, and its invariant needs no lexing —
  // hex digits and hyphens cannot close a quote, open a comment or separate a statement.
  it('canonicalises a UUID, in every spelling PostgreSQL accepts', () => {
    expect(sqlUuid('AB000000-0000-4000-8000-0000000000AA'))
      .toBe('ab000000-0000-4000-8000-0000000000aa');
    expect(sqlUuid('{ab000000-0000-4000-8000-0000000000aa}'))
      .toBe('ab000000-0000-4000-8000-0000000000aa');
  });

  it('refuses the very text that defeats a fragment inside quotes', () => {
    for (const bad of ["x', 'y", "'indoor'", '12.50', "1); DROP", '']) {
      expect(() => sqlUuid(bad), bad).toThrow(/is not a UUID/);
    }
  });

  it('and sqlFragment really does accept that text, which is why the two are different', () => {
    // NOT A CURIOSITY — it is the finding. A validator that accepted this AND was permitted inside
    // quotes would let a fixture override decide a column no reader of the template can see.
    expect(sqlFragment("x', 'y")).toBe("x', 'y");
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
