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
 * Every event key seeded into notification_event_types, extracted from the real migrations.
 *
 * FAIL-CLOSED extraction: a broad, case-insensitive detector finds every statement that inserts
 * into the table (qualified or not), and any detected statement whose VALUES tuples yield no key
 * is an ERROR rather than a silent skip — otherwise a future seed written in a shape this parser
 * does not read (lowercase keywords, INSERT … SELECT) would leave every assertion green while its
 * raw key reaches users, which is the exact failure this test exists to close.
 */
const seededKeys = (): string[] => {
  const keys = new Set<string>();
  const unparsed: string[] = [];
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    for (const insert of sql.matchAll(
      /insert\s+into\s+(?:public\.)?(?:"?notification_event_types"?)\b([\s\S]*?)(?:on\s+conflict|;)/gi,
    )) {
      const tuples = [...insert[1].matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]);
      if (tuples.length === 0) {
        unparsed.push(`${f}: ${insert[0].slice(0, 120).replace(/\s+/g, ' ')}…`);
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
});
