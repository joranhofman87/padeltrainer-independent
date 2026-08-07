/**
 * THE ONE DUPLICATION IN THIS SLICE, PINNED.
 *
 * `legacyDateRange` (src/lib/notifyFollowers.ts, FRONTEND bundle) and `formatLegacyDateRange`
 * (supabase/functions/_shared/open-slots-notify.ts, DENO edge function) produce the same string
 * from the same pair of ISO dates. They are two implementations on purpose — the browser bundle
 * and the edge runtime share no import graph, and neither can import the other — and that is the
 * whole hazard: a duplication nothing compares is a divergence waiting for a deploy.
 *
 * WHY A DIVERGENCE WOULD MATTER, concretely. Both strings are the anchor of the pre-cutover
 * `notification_sends` dedup key, `<trainer>:<player>:na:<range>`. During the frontend/edge deploy
 * overlap the OLD handler claims that key using the string the CLIENT sent, and the NEW handler
 * claims it using the string it DERIVES. If the two formatters disagree by so much as a space,
 * the two handler versions claim different keys for one batch — and a follower is emailed twice.
 * The parser makes it worse than silent: a `date_range` that does not match the derived value
 * byte-for-byte REFUSES the request, so a drift would not merely duplicate, it would break every
 * announcement made from a cached bundle.
 *
 * A third copy is what this file exists to prevent. An earlier revision added a
 * `canonicalLegacyDateRange` twin inside the edge module itself — a duplicate of a duplicate, in
 * the same file, with nothing pinning it to anything. It is gone; the edge module has exactly one
 * definition, and this test holds it to the frontend's.
 *
 * If this test fails, do NOT "fix" it by changing the expectation. Change one implementation to
 * match the other, or the deploy overlap is unsafe.
 */
import { describe, expect, it } from 'vitest';
import { legacyDateRange } from '../lib/notifyFollowers';
import { formatLegacyDateRange } from '../../supabase/functions/_shared/open-slots-notify';

/** Cases chosen because each one has broken a date formatter somewhere before. */
const CASES: Array<[from: string, to: string, why: string]> = [
  ['2026-08-10', '2026-08-16', 'the ordinary same-year week — the overwhelmingly common case'],
  ['2026-08-10', '2026-08-10', 'a single day: both ends identical'],
  ['2026-01-01', '2026-12-31', 'a full year inside one year'],
  ['2026-12-29', '2027-01-05', 'the New Year crossing — both years must be printed'],
  ['2026-01-10', '2027-01-02', 'a 52-week series whose MONTHS are equal across the crossing'],
  ['2026-01-01', '2028-01-02', 'a multi-year span'],
  ['2026-02-28', '2026-03-01', 'a non-leap February boundary'],
  ['2028-02-29', '2028-03-01', 'a LEAP day — Feb 29 exists in 2028'],
  ['2026-01-01', '2026-01-09', 'single-digit days on both ends (no zero padding in this format)'],
  ['2026-09-30', '2026-10-01', 'a month rollover'],
  ['2026-10-01', '2026-10-31', 'a month whose name is 3 letters either way'],
  ['2026-03-09', '2026-11-02', 'single-digit day to single-digit day, months apart'],
];

describe('legacy display range: frontend and edge implementations are byte-identical', () => {
  it.each(CASES)('%s..%s — %s', (from, to, _why) => {
    const frontend = legacyDateRange(from, to);
    const edge = formatLegacyDateRange(from, to);
    expect(edge).toBe(frontend);
    // and it is a non-empty string, so a pair of functions that both returned '' would not pass
    expect(frontend.length).toBeGreaterThan(0);
  });

  it('agrees across a full year of week-long ranges, not just the hand-picked cases', () => {
    // Exhaustive beats representative for a pure function this small. Every start day of 2026 plus
    // a 6-day span, which sweeps every month name, every month-rollover, and the year boundary.
    const day = new Date(Date.UTC(2026, 0, 1));
    let checked = 0;
    while (day.getUTCFullYear() <= 2026) {
      const from = day.toISOString().slice(0, 10);
      const end = new Date(day.getTime() + 6 * 86400000);
      const to = end.toISOString().slice(0, 10);
      expect(formatLegacyDateRange(from, to), `${from}..${to}`).toBe(legacyDateRange(from, to));
      checked++;
      day.setUTCDate(day.getUTCDate() + 1);
    }
    expect(checked).toBe(365);
  });

  it('MUTANT: the historical single-year format diverges on a year crossing', () => {
    // The shape both functions REPLACED: year printed only on the right. It is what makes
    // "Jan 1 - Jan 2, 2027" ambiguous between two different ranges, and it is what a careless
    // "simplification" of either implementation would regress to. Pinned as an executable
    // difference so the divergence cannot be reintroduced quietly.
    const mutant = (fromIso: string, toIso: string) => {
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const p = (iso: string) => {
        const [y, m, d] = iso.split('-');
        return { y, mon: MON[Number(m) - 1], d: String(Number(d)) };
      };
      const a = p(fromIso);
      const b = p(toIso);
      return `${a.mon} ${a.d} - ${b.mon} ${b.d}, ${b.y}`;
    };
    // Same-year: the mutant is indistinguishable, which is exactly why the regression is easy.
    expect(mutant('2026-08-10', '2026-08-16')).toBe(formatLegacyDateRange('2026-08-10', '2026-08-16'));
    // Year-crossing: production prints both years, the mutant loses one.
    expect(mutant('2026-12-29', '2027-01-05')).toBe('Dec 29 - Jan 5, 2027');
    expect(formatLegacyDateRange('2026-12-29', '2027-01-05')).toBe('Dec 29, 2026 - Jan 5, 2027');
    expect(mutant('2026-12-29', '2027-01-05')).not.toBe(legacyDateRange('2026-12-29', '2027-01-05'));
  });
});
