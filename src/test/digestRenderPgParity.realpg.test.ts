// @vitest-environment node
// PR 10c-a3 — cross-layer byte parity: the digest renderer's oversize check (pgJsonbTextByteLength) MUST
// equal PostgreSQL's authoritative octet_length(frozen_request::text) that store_notification_digest_request
// validates. A compact JSON.stringify underestimates by the jsonb separator bytes, which would let a group
// the SQL store rejects slip past the JS oversize gate and strand instead of splitting. Verified on a real
// Postgres over a battery of boundary / unicode / quote / backslash / control-char cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgJsonbTextByteLength, DIGEST_BYTE_BUDGET } from '../../supabase/functions/_shared/digest-render.ts';

const PORT = 54346;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-parity-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  c = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
}, 180_000);

afterAll(async () => { if (c) await c.end(); if (epg) await epg.stop(); });

/** PostgreSQL's authoritative measure of the frozen request: octet_length(jsonb::text). */
async function pgBytes(obj: Record<string, string>): Promise<number> {
  const r = await c.query(`SELECT octet_length($1::jsonb::text)::int AS n`, [JSON.stringify(obj)]);
  return r.rows[0].n;
}

describe('10c-a3 render byte parity — pgJsonbTextByteLength === octet_length(jsonb::text)', () => {
  it('matches PostgreSQL byte-for-byte across ASCII, unicode, quotes, backslashes, control chars, key-order', async () => {
    const cases: Record<string, string>[] = [
      { to: 'p@x.com', subject: 'hi', html: '<p>x</p>' },
      { to: 'π@пример.рф', subject: '日本語 — 🎾', html: '<p>café</p>' },            // multibyte UTF-8
      { to: 'a@b.com', subject: `quote " and backslash \\ and slash /`, html: `<a href="x">y</a>` },
      { to: 'a@b.com', subject: 'tab\tnl\ncr\rbksp\bff\f', html: 'plain body' }, // jsonb-valid control chars (NO NUL)
      { to: 'z'.repeat(50) + '@x.com', subject: 'y'.repeat(300), html: '<p>' + 'w'.repeat(1000) + '</p>' },
      { to: '', subject: '', html: '' },                                                   // empty strings
      { to: 'a@b.com', subject: 'unicode escapes   ', html: 'emoji 👩‍👩‍👧 zwj' },
    ];
    for (const obj of cases) {
      expect(pgJsonbTextByteLength(obj), JSON.stringify(obj)).toBe(await pgBytes(obj));
    }
  });

  it('the oversize boundary agrees with the SQL store exactly (budget vs budget+1)', async () => {
    // build an object whose jsonb::text is EXACTLY the budget, then one byte over.
    const overhead = pgJsonbTextByteLength({ to: '', subject: '', html: '' }); // {"to": "", "subject": "", "html": ""}
    const padTo = DIGEST_BYTE_BUDGET - overhead;
    const atBudget = { to: 'a@b.com', subject: '', html: 'x'.repeat(padTo - 'a@b.com'.length) };
    const atBytes = await pgBytes(atBudget);
    expect(pgJsonbTextByteLength(atBudget)).toBe(atBytes);
    expect(atBytes).toBe(DIGEST_BYTE_BUDGET);              // exactly at budget
    // store validates `> 92160` → at-budget passes; one more byte fails. The JS gate must agree.
    const overBudget = { ...atBudget, html: atBudget.html + 'y' };
    expect(await pgBytes(overBudget)).toBe(DIGEST_BYTE_BUDGET + 1);
    expect(pgJsonbTextByteLength(atBudget) > DIGEST_BYTE_BUDGET).toBe(false);
    expect(pgJsonbTextByteLength(overBudget) > DIGEST_BYTE_BUDGET).toBe(true);
  });
});
