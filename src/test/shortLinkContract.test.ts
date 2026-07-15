import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getShortUrl } from '@/lib/domains';

/**
 * CROSS-LAYER CONTRACT: short codes are generated in SQL (gen_short_code) but resolved at the edge by
 * a regex in the Cloudflare Worker. If the two drift — a wider SQL alphabet or a longer code than the
 * worker regex accepts — every new short link 404s at the edge with nothing else to catch it (the
 * worker is a plain .js file outside the type/test gates). This test reads BOTH sources of truth and
 * asserts they stay compatible, so a change to one without the other fails CI here.
 */
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260825100000_short_links.sql'),
  'utf8',
);
const worker = readFileSync(join(process.cwd(), 'docs', 'cloudflare-worker.js'), 'utf8');

// SQL side: the base62 alphabet + the length get_or_create_short_link actually generates.
const alphabet = migration.match(/alphabet constant text := '([^']+)'/)?.[1] ?? '';
const codeLen = Number(migration.match(/gen_short_code\((\d+)\)/)?.[1]);

// Worker side: the /s/<code> matcher  ^\/s\/([0-9A-Za-z]{4,16})$
const workerRe = worker.match(/\^\\\/s\\\/\(\[([0-9A-Za-z-]+)\]\{(\d+),(\d+)\}\)/);
const charClass = workerRe?.[1] ?? '';
const min = Number(workerRe?.[2]);
const max = Number(workerRe?.[3]);

describe('short-link SQL↔worker contract', () => {
  it('parsed both sources of truth', () => {
    expect(alphabet.length).toBe(62); // base62
    expect(codeLen).toBeGreaterThan(0);
    expect(charClass).toBeTruthy();
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
  });

  it('every SQL alphabet character is accepted by the worker regex char-class', () => {
    const accepts = new RegExp(`^[${charClass}]+$`);
    for (const ch of alphabet) {
      expect(accepts.test(ch), `worker regex must accept '${ch}'`).toBe(true);
    }
  });

  it('the generated code length is within the worker regex bounds', () => {
    expect(codeLen).toBeGreaterThanOrEqual(min);
    expect(codeLen).toBeLessThanOrEqual(max);
  });

  it('a getShortUrl() path for a real-length code matches the exact worker regex', () => {
    const sampleCode = alphabet.slice(0, codeLen); // e.g. "0123456"
    const path = getShortUrl(sampleCode).replace('https://padeltrainer.ai', '');
    const workerPathRe = new RegExp(`^\\/s\\/[${charClass}]{${min},${max}}$`);
    expect(workerPathRe.test(path)).toBe(true);
  });
});
