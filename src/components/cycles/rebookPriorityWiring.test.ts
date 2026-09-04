import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

/**
 * ABC-26 — the inverse of what this file used to guard.
 *
 * It previously locked down that BOTH academy rebooking flows mount the manual priority list and
 * submit `priorityPeople`. Supplementary rebooking priority is now unavailable for every class, so
 * those assertions are obsolete positives: keeping them would fail honestly, and "fixing" them by
 * deletion would leave nothing watching the surface. They are REPLACED by the opposite guarantee —
 * neither wizard can offer, hold or submit a selection, and neither can be talked into believing a
 * round was created when the server never said so.
 *
 * Source guards, deliberately: by the time a behavioural test could observe a submitted selection,
 * the request has already been made. The behaviour these guards protect is covered separately in
 * `src/test/abc26RebookWizards.test.tsx`.
 */
const ACADEMY = 'AcademyNewRoundWizard.tsx';
const COHORT = 'RebookCohortWizard.tsx';
const BOTH: Array<[string]> = [[ACADEMY], [COHORT]];

describe('ABC-26 · neither rebooking wizard can offer or submit supplementary priority', () => {
  it.each(BOTH)('%s does not mount a priority selector', (file) => {
    const src = read(`./${file}`);
    expect(src).not.toMatch(/RebookPriorityListField/);
    expect(src).not.toMatch(/setPriorityPeople|priorityPeople\.filter/);
  });

  it.each(BOTH)('%s submits canonical EMPTY arrays, not omitted fields', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/priorityPeople:\s*\[\]/);
    expect(src).toMatch(/priorityGuests:\s*\[\]/);
  });

  it('the cohort wizard also sends an empty second bucket', () => {
    expect(read(`./${COHORT}`)).toMatch(/secondBucketSeriesKeys:\s*\[\]/);
  });

  it.each(BOTH)('%s declares the exact protocol version', (file) => {
    expect(read(`./${file}`)).toMatch(/priorityContractVersion:\s*PRIORITY_PROTOCOL_VERSION/);
  });

  it('the removed selector and its person mapper are gone, not merely unreferenced', () => {
    for (const gone of ['RebookPriorityListField.tsx', 'priorityPerson.ts']) {
      expect(() => read(`./${gone}`)).toThrow();
    }
  });
});

describe('ABC-26 · the second-bucket model is gone from the cohort flow', () => {
  it('the wizard holds no second-bucket state, memo key, handler or count', () => {
    const src = read(`./${COHORT}`);
    expect(src).not.toMatch(/secondBucketSeriesKeys\s*,/);          // memo dependency
    expect(src).not.toMatch(/setSecondBucketSeriesKeys/);
    expect(src).not.toMatch(/secondBucketAdded/);
    expect(src).not.toMatch(/toggleSecondBucketKey/);
    expect(src).not.toMatch(/secondBucketKeys=/);
    expect(src).not.toMatch(/onToggleSecondBucket/);
    // The only surviving mention is the canonical empty array in the request body.
    expect(src.match(/secondBucket/gi) ?? []).toHaveLength(1);
  });

  it('the review table exposes no second-bucket prop, control or copy', () => {
    const src = read('./RebookReviewTable.tsx');
    expect(src).not.toMatch(/secondBucketKeys\??\s*[:=]/);
    expect(src).not.toMatch(/onToggleSecondBucket/);
    expect(src).not.toMatch(/moveToSecondBucket/);
  });

  it('exclusion-only survives: the keep toggle and its callback are still there', () => {
    const src = read('./RebookReviewTable.tsx');
    expect(src).toMatch(/onToggleExcluded/);
    expect(src).toMatch(/excludedKeys/);
    expect(src).toMatch(/rebookReview\.keep/);
  });
});

describe('ABC-26 · the unavailable explanation is UNCONDITIONAL', () => {
  it.each(BOTH)('%s renders it outside any member-window gate', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/PriorityUnavailableExplanation/);
    // The defect this replaces: `{enableMemberWindow && (<Card>…Explanation…</Card>)}` hid the
    // containment truth exactly when the operator switched the member window off.
    expect(src).not.toMatch(/enableMemberWindow &&[\s\S]{0,400}PriorityUnavailableExplanation/);
  });

  it('the review table shows it persistently in interactive mode', () => {
    const src = read('./RebookReviewTable.tsx');
    expect(src).toMatch(/interactive &&\s*\(\s*<PriorityUnavailableExplanation/);
  });
});

describe('ABC-26 · both wizards decode the typed contract, and never fabricate a result', () => {
  it.each(BOTH)('%s routes BOTH server conversations through the shared decoder', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/previewRebookRound/);
    expect(src).toMatch(/createAndDrainRebookRound/);
    // No raw invoke of the rebooking function: that is the path that threw away the typed 409.
    expect(src).not.toMatch(/functions\.invoke\(\s*['"]bulk-rebook-cycle['"]/);
  });

  it.each(BOTH)('%s surfaces refusal AND unknown as persistent, focusable alerts', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/PriorityRefusalAlert/);
    expect(src).toMatch(/RoundUnknownAlert/);
    expect(src).toMatch(/RoundNoWorkNotice/);
    // …and never as a toast, which disappears while the operator is still deciding.
    expect(src).not.toMatch(/toast\.(info|error|warning)\([^\n]*priorityRefusal/);
  });

  it.each(BOTH)('%s only navigates on the verified created arm', (file) => {
    const src = read(`./${file}`);
    // A fallback navigate on a missing id is the false-success shape: it lands the operator on a
    // page that asserts the round exists.
    expect(src).not.toMatch(/navigate\(result\.targetCycleId \?/);
    expect(src).toMatch(/navigate\(`\/app\/academy\/cycles\/\$\{result\.targetCycleId\}\/rebook`\)/);
  });

  it.each(BOTH)('%s pins creation to the reviewed snapshot and revision', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/bodyRevision/);
    expect(src).toMatch(/revision !== bodyRevision/);
    expect(src).toMatch(/sendBlocked/);
    // The handler re-checks the guard the button renders — a disabled button is a hint, not a lock.
    expect(src).toMatch(/if \(!inputsValid \|\| sendBlocked/);
  });

  it.each(BOTH)('%s orders its previews with a generation counter and an AbortController', (file) => {
    const src = read(`./${file}`);
    expect(src).toMatch(/previewGenRef/);
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/signal: ac\.signal/);
    expect(src).toMatch(/result\.phase === 'aborted'/);
  });

  it('the cohort review refresh no longer swallows failures to keep a stale review', () => {
    const src = read(`./${COHORT}`);
    expect(src).not.toMatch(/catch \{ \/\* keep the previous review/);
    expect(src).toMatch(/reviewGenRef/);
    expect(src).toMatch(/reviewPending/);
  });

  it.each(BOTH)('%s decodes response numbers without Number() coercion', (file) => {
    const src = read(`./${file}`);
    // `\b` matters: `optionalNumber(data.x)` is a DECODER and must not trip this guard, while a
    // bare `Number(data.x)` — the coercion that turned an unreadable field into NaN — must.
    expect(src).not.toMatch(/\bNumber\(data/);
    expect(src).toMatch(/Number\.isSafeInteger/);
  });
});
