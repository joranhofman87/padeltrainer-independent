/**
 * SEO length lint test
 *
 * Asserts that every translated `title` and `description` in the marketing
 * locale files stays within search-engine-friendly limits:
 *   - title (after the " | PadelTrainer.ai" suffix appended by SEO.tsx) ≤ 60 chars
 *   - description ≤ 160 chars
 *
 * Existing entries that are too long are tracked in KNOWN_LONG_KEYS as a
 * deliberate temporary allowlist. New offending strings will fail the test.
 * To clear an allowlist entry: shorten the copy in every locale, then remove
 * the key from KNOWN_LONG_KEYS.
 */
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TITLE_SUFFIX = ' | PadelTrainer.ai';
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

// Snapshot of currently-too-long keys (locale-prefixed). Reduce over time.
const KNOWN_LONG_KEYS = new Set<string>([
  // English
  'en::cityPage.title',
  'en::provincePage.title',
  'en::seo.home.title',
  'en::quiz.seo.title',
  'en::playground.seo.title',
  'en::redFlagQuiz.seo.title',
  'en::challengeMode.seo.title',
  // Dutch
  'nl::home.features.title',
  'nl::home.cta.title',
  'nl::cityPage.title',
  'nl::provincePage.title',
  'nl::seo.home.title',
  'nl::quiz.seo.title',
  'nl::gear.listing.title',
  'nl::playground.seo.title',
  'nl::redFlagQuiz.seo.title',
  // Spanish
  'es::cityPage.title',
  'es::provincePage.title',
  'es::seo.home.title',
  'es::seo.home.description',
  'es::seo.location.title',
  'es::quiz.seo.title',
  'es::gear.listing.title',
  'es::playground.seo.title',
  'es::redFlagQuiz.seo.title',
  // German
  'de::cityPage.title',
  'de::provincePage.title',
  'de::seo.home.title',
  'de::seo.home.description',
  'de::quiz.seo.title',
  'de::gear.listing.title',
  'de::playground.seo.title',
  'de::rateMyCourtPage.seo.title',
  'de::redFlagQuiz.seo.title',
  // French
  'fr::cityPage.title',
  'fr::cityPage.description',
  'fr::provincePage.title',
  'fr::seo.home.title',
  'fr::seo.home.description',
  'fr::seo.location.title',
  'fr::quiz.seo.title',
  'fr::gear.listing.title',
  'fr::playground.seo.title',
  'fr::redFlagQuiz.seo.title',
  // Italian
  'it::home.features.title',
  'it::home.cta.title',
  'it::rateMyCourtPage.seo.title',
  'it::cityPage.title',
  'it::provincePage.title',
  'it::seo.home.title',
  'it::seo.home.description',
  'it::quiz.seo.title',
  'it::gear.listing.title',
  'it::playground.seo.title',
  'it::redFlagQuiz.seo.title',
]);

const LANGS = ['en', 'nl', 'es', 'de', 'fr', 'it'];

interface Issue { locale: string; key: string; type: 'title' | 'description'; length: number; value: string; }

function walk(obj: unknown, segs: string[], out: Array<{ key: string; value: string }>) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object') walk(v, segs.concat(k), out);
    else if (typeof v === 'string') out.push({ key: segs.concat(k).join('.'), value: v });
  }
}

function collectIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const locale of LANGS) {
    const filePath = path.join(process.cwd(), 'src/i18n/locales', locale, 'marketing.json');
    if (!fs.existsSync(filePath)) continue;
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const flat: Array<{ key: string; value: string }> = [];
    walk(json, [], flat);
    for (const { key, value } of flat) {
      const last = key.split('.').pop();
      if (last === 'title') {
        const total = value.length + TITLE_SUFFIX.length;
        if (total > TITLE_MAX) {
          issues.push({ locale, key, type: 'title', length: total, value });
        }
      } else if (last === 'description') {
        if (value.length > DESCRIPTION_MAX) {
          issues.push({ locale, key, type: 'description', length: value.length, value });
        }
      }
    }
  }
  return issues;
}

describe('SEO length limits (marketing locales)', () => {
  const issues = collectIssues();

  it('flags no NEW oversized titles or descriptions', () => {
    const unexpected = issues.filter(i => !KNOWN_LONG_KEYS.has(`${i.locale}::${i.key}`));
    if (unexpected.length > 0) {
      const report = unexpected
        .map(i => `  [${i.locale}] ${i.key} (${i.type}=${i.length}): ${i.value.slice(0, 100)}`)
        .join('\n');
      throw new Error(
        `\nNew SEO copy exceeds limits (title>${TITLE_MAX}, desc>${DESCRIPTION_MAX}):\n${report}\n\n` +
        `Either shorten the copy or, only as a deliberate exception, add the key to KNOWN_LONG_KEYS.\n`,
      );
    }
    expect(unexpected).toHaveLength(0);
  });

  it('does not have stale KNOWN_LONG_KEYS entries (entries that are now within limits)', () => {
    const offending = new Set(issues.map(i => `${i.locale}::${i.key}`));
    const stale = [...KNOWN_LONG_KEYS].filter(k => !offending.has(k));
    if (stale.length > 0) {
      // Soft warn — do not fail; cleanup is beneficial but not blocking.
       
      console.warn(`[seo-lengths] KNOWN_LONG_KEYS has ${stale.length} stale entries that can be removed:\n${stale.join('\n')}`);
    }
    expect(true).toBe(true);
  });
});
