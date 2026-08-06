// @vitest-environment node
// Every event the catalog seeds MUST have a human label in BOTH languages.
//
// The settings page renders `notifications.events.<key>.label` and falls back to the raw catalog
// key with underscores replaced (`key.replace(/_/g, ' ')`) — so a seeded event with no label shows
// INTERNAL IMPLEMENTATION LANGUAGE to every user, in every language, on the page email footers
// deep-link to as the unsubscribe target. That is exactly what shipped with open_slots_player in
// 10c-b: the migration seeded the event, the i18n diff touched only trainer.json, and the page
// test mocks i18next by echoing keys — so nothing could notice. This test closes that class: the
// keys are extracted from the MIGRATIONS (the source of truth for what the page will render), not
// from a hand-kept list that would drift the same way.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/**
 * FAIL-CLOSED extraction: a broad, case-insensitive detector finds every statement that inserts
 * into the table — unqualified, `public.`-qualified, or with QUOTED schema/table identifiers,
 * any spacing around the dot — and any detected statement whose VALUES tuples yield no key is an
 * ERROR rather than a silent skip. Otherwise a future seed written in a shape this parser does
 * not read (lowercase keywords, INSERT … SELECT, `"public"."notification_event_types"`) would
 * leave every assertion green while its raw key reaches users — the exact failure this test
 * exists to close. The detector itself is self-tested below against those variants, so its own
 * blind spots cannot silently return either.
 */
const DETECT =
  /insert\s+into\s+(?:"?public"?\s*\.\s*)?"?notification_event_types"?\b([\s\S]*?)(?:on\s+conflict|;)/gi;

const extractFrom = (files: Array<{ name: string; sql: string }>): string[] => {
  const keys = new Set<string>();
  const unparsed: string[] = [];
  for (const { name, sql } of files) {
    for (const insert of sql.matchAll(DETECT)) {
      const tuples = [...insert[1].matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]);
      if (tuples.length === 0) {
        unparsed.push(`${name}: ${insert[0].slice(0, 120).replace(/\s+/g, ' ')}…`);
        continue;
      }
      for (const k of tuples) keys.add(k);
    }
  }
  if (unparsed.length) {
    throw new Error(
      `a notification_event_types insert exists that this extractor cannot read — teach it the shape rather than letting the seed escape the label check:\n${unparsed.join('\n')}`,
    );
  }
  return [...keys].sort();
};

/** Every event key seeded into notification_event_types, extracted from the real migrations. */
const seededKeys = (): string[] =>
  extractFrom(
    readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') })),
  );

const labels = (lang: string): Record<string, { label?: string }> =>
  JSON.parse(readFileSync(join(process.cwd(), 'src', 'i18n', 'locales', lang, 'notifications.json'), 'utf8'))
    .notifications.events ?? {};

describe('notification catalog ↔ i18n label parity', () => {
  const keys = seededKeys();

  it('finds the seeded catalog (extraction is not vacuous)', () => {
    // the foundation migration seeds 20 events and 10c-b added open_slots_player
    expect(keys.length).toBeGreaterThanOrEqual(21);
    expect(keys).toContain('open_slots_player');
    expect(keys).toContain('booking_confirmed_player');
  });

  it.each(['en', 'nl'])('every seeded event has a %s label that is not the raw key', (lang) => {
    const map = labels(lang);
    const missing = keys.filter((k) => !map[k]?.label);
    expect(missing, `add notifications.events.<key>.label to ${lang}/notifications.json for: ${missing.join(', ')}`)
      .toEqual([]);
    // A "label" that just restates the key is the same failure wearing a translation key.
    // CASE-SENSITIVE on purpose: the page's fallback renders the key lowercased, so a lazy
    // copy-paste of it is exactly lowercase — while a legitimate sentence-cased label that
    // happens to share the words ("Password reset") is fine.
    const lazy = keys.filter((k) => map[k]?.label === k.replace(/_/g, ' '));
    expect(lazy, `these ${lang} labels merely echo the internal key: ${lazy.join(', ')}`).toEqual([]);
  });

  it('en and nl define the same event-label key set', () => {
    expect(Object.keys(labels('en')).sort()).toEqual(Object.keys(labels('nl')).sort());
  });

  // The detector's own blind spots are the escape hatch this test must not have: every valid
  // SQL shape a future seed could take must either be READ or REFUSED — never skipped.
  it('the extractor reads every insert shape a seed could legitimately take', () => {
    const shapes = [
      ["INSERT INTO public.notification_event_types (key) VALUES ('a_one', true);", ['a_one']],
      ["insert into notification_event_types (key) values ('b_two', 1);", ['b_two']],
      [`INSERT INTO "public"."notification_event_types" (key) VALUES ('c_three', x);`, ['c_three']],
      [`INSERT INTO "notification_event_types" (key) VALUES ('d_four', x) ON CONFLICT (key) DO NOTHING;`, ['d_four']],
      ["INSERT INTO public . notification_event_types (key) VALUES ('e_five', x);", ['e_five']],
    ] as const;
    for (const [sql, expected] of shapes) {
      expect(extractFrom([{ name: 'fixture.sql', sql }]), sql).toEqual([...expected]);
    }
  });

  it('the extractor REFUSES a detected insert it cannot read, rather than skipping it', () => {
    expect(() => extractFrom([{
      name: 'fixture.sql',
      sql: 'INSERT INTO public.notification_event_types (key) SELECT key FROM somewhere;',
    }])).toThrow(/cannot read/);
  });

  it('the extractor is not vacuous on unrelated tables', () => {
    expect(extractFrom([{ name: 'fixture.sql', sql: "INSERT INTO public.other_table VALUES ('x_key', 1);" }]))
      .toEqual([]);
  });
});
