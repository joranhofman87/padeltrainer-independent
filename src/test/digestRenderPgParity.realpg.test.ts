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
import { pgJsonbTextByteLength, DIGEST_BYTE_BUDGET, isDigestRequestOversize } from '../../supabase/functions/_shared/digest-render.ts';

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
    // The PRODUCTION frozen request is FOUR fields {from,to,subject,html} — model that everywhere.
    const F = 'PadelTrainer.ai <noreply@app.padeltrainer.ai>';
    const cases: Record<string, string>[] = [
      { from: F, to: 'p@x.com', subject: 'hi', html: '<p>x</p>' },
      { from: F, to: '\u03c0@\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444', subject: '\u65e5\u672c\u8a9e \u2014 \ud83c\udfbe', html: '<p>caf\u00e9</p>' },  // multibyte UTF-8
      { from: F, to: 'a@b.com', subject: `quote " and backslash \\ and slash /`, html: `<a href="x">y</a>` },
      { from: F, to: 'a@b.com', subject: 'tab\tnl\ncr\rbksp\bff\f', html: 'plain body' },  // jsonb control chars (NO NUL)
      { from: F, to: 'z'.repeat(50) + '@x.com', subject: 'y'.repeat(300), html: '<p>' + 'w'.repeat(1000) + '</p>' },
      { from: '', to: '', subject: '', html: '' },                                            // empty strings
      { from: F, to: 'a@b.com', subject: 'unicode escapes   ', html: 'emoji \ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc67 zwj' },
    ];
    for (const obj of cases) {
      expect(pgJsonbTextByteLength(obj), JSON.stringify(obj)).toBe(await pgBytes(obj));
    }
  });

  it('the oversize boundary agrees with the SQL store exactly (budget vs budget+1) \u2014 FOUR-field request', async () => {
    const F = 'PadelTrainer.ai <noreply@app.padeltrainer.ai>';
    const overhead = pgJsonbTextByteLength({ from: F, to: 'a@b.com', subject: '', html: '' });
    const padTo = DIGEST_BYTE_BUDGET - overhead;
    const atBudget = { from: F, to: 'a@b.com', subject: '', html: 'x'.repeat(padTo) };
    const atBytes = await pgBytes(atBudget);
    expect(pgJsonbTextByteLength(atBudget)).toBe(atBytes);
    expect(atBytes).toBe(DIGEST_BYTE_BUDGET);              // exactly at budget
    const overBudget = { ...atBudget, html: atBudget.html + 'y' };
    expect(await pgBytes(overBudget)).toBe(DIGEST_BYTE_BUDGET + 1);
    expect(isDigestRequestOversize(atBudget as never)).toBe(false);
    expect(isDigestRequestOversize(overBudget as never)).toBe(true);
  });

  it('MUTATION PIN: `from` is counted \u2014 a size calc that dropped it undercounts vs the real request', async () => {
    const F = 'PadelTrainer.ai <noreply@app.padeltrainer.ai>';
    const withFrom = { from: F, to: 'a@b.com', subject: 's', html: '<p>x</p>' };
    const droppingFrom = { to: withFrom.to, subject: withFrom.subject, html: withFrom.html };
    // the correct 4-key measure matches PG's octet_length of the REAL stored request...
    expect(pgJsonbTextByteLength(withFrom)).toBe(await pgBytes(withFrom));
    // ...while measuring WITHOUT `from` (the regression) diverges from the real bytes and undercounts.
    expect(pgJsonbTextByteLength(droppingFrom)).not.toBe(await pgBytes(withFrom));
    expect(pgJsonbTextByteLength(droppingFrom)).toBeLessThan(pgJsonbTextByteLength(withFrom));
    // and it flips the gate: a request that is 1 byte over ONLY because `from` is counted must read oversize.
    const overhead = pgJsonbTextByteLength({ from: F, to: 'a@b.com', subject: '', html: '' });
    const oneOver = { from: F, to: 'a@b.com', subject: '', html: 'x'.repeat(DIGEST_BYTE_BUDGET - overhead + 1) };
    expect(isDigestRequestOversize(oneOver as never)).toBe(true);
    expect(pgJsonbTextByteLength(oneOver) - pgJsonbTextByteLength({ to: oneOver.to, subject: oneOver.subject, html: oneOver.html })).toBeGreaterThan(0);
  });
});
