// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

/**
 * Codex round-7 #7: prove the KEYSET pagination pattern (`WHERE id > $after ORDER BY id LIMIT n`) the
 * edge discovery reads now use returns EVERY matching row over a >1000-row filtered set in a real
 * (pglite) Postgres, with no truncation, no duplicate, and — critically — no skipped row when a claim
 * leaves the filter (status change) mid-pagination. This is the SQL-level counterpart to the Deno
 * fetchAllKeyset unit tests.
 */
describe('keyset pagination over >1000 real filtered rows (Codex round-7 #7)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Zero-padded text ids — an orderable unique key is all keyset needs (the edge uses uuid ids, but
    // gen_random_uuid isn't in bare pglite; the pagination property is identical for any ordered key).
    await db.query(`CREATE TABLE claims (id text PRIMARY KEY, status text NOT NULL)`);
    await db.query(`INSERT INTO claims (id, status) SELECT lpad(g::text, 8, '0'), 'pending' FROM generate_series(1, 1500) AS g`);
  });

  // Drive the exact keyset shape the edge uses. `afterFirstPage` runs once, after page 1, to simulate a
  // concurrent status change landing mid-pagination.
  const drainKeyset = async (afterFirstPage?: () => Promise<void>): Promise<string[]> => {
    const all: string[] = [];
    let after: string | null = null;
    let page = 0;
    for (;;) {
      const rows = (await db.query<{ id: string }>(
        `SELECT id FROM claims WHERE status='pending' AND ($1::text IS NULL OR id > $1) ORDER BY id LIMIT 1000`,
        [after],
      )).rows;
      all.push(...rows.map((r) => r.id));
      if (page === 0 && afterFirstPage) await afterFirstPage();
      page++;
      if (rows.length < 1000) break;
      after = rows[rows.length - 1].id;
    }
    return all;
  };

  it('returns ALL 1500 rows — no truncation, no duplicates', async () => {
    const ids = await drainKeyset();
    expect(ids.length).toBe(1500);
    expect(new Set(ids).size).toBe(1500); // no duplicates across pages
  });

  it('a claim leaving the pending filter mid-pagination does not skip any still-pending row', async () => {
    // Flip an already-read (page-1) row to 'claimed' after page 1. Keyset continues by id > lastKey, so
    // no row after that key is skipped (an OFFSET read would shift and drop one — see the Deno test).
    const ids = await drainKeyset(async () => {
      const first = (await db.query<{ id: string }>(`SELECT id FROM claims WHERE status='pending' ORDER BY id LIMIT 1`)).rows[0];
      await db.query(`UPDATE claims SET status='claimed' WHERE id=$1`, [first.id]);
    });
    const stillPending = (await db.query<{ id: string }>(`SELECT id FROM claims WHERE status='pending' ORDER BY id`)).rows.map((r) => r.id);
    // Every row that is still pending was collected during the drain (the read-before-change row is also
    // present, having been read in page 1) — nothing was skipped.
    for (const id of stillPending) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length); // still no duplicates
  });
});
