// @vitest-environment node
//
// ABC-20 — the transitional guest-first rebook-invoice idempotency contract.
//
// The old key was COALESCE(player_id, guest_player_id) — profile-first — so on a DUAL-KEY invoice
// it resolved to the profile. That both collided two DIFFERENT people onto one key and let the
// SAME guest hold two active invoices for one cyclus.
//
// These are behavioural: real inserts against real indexes, including the conflict the old rule
// produced and the one the new rule must still produce.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const CYCLUS = '9c000000-0000-4000-8000-000000000001';
const GUEST_A = IDS.guestOwnedByAttackerAcademy;
const PROFILE_B = IDS.bookedProfile;

const insertInvoice = (cols: Record<string, string | null>) => {
  const keys = Object.keys(cols);
  const vals = keys.map((k) => (cols[k] === null ? 'NULL' : `'${cols[k]}'`));
  return db.exec(
    `INSERT INTO public.invoices (${keys.join(', ')}) VALUES (${vals.join(', ')});`,
  );
};

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);
}, 120_000);

beforeEach(async () => {
  await db.exec(`DELETE FROM public.invoices WHERE rebook_cyclus_id = '${CYCLUS}';`);
});

describe('ABC-20 · the profile-first index is gone, the two partial indexes are installed', () => {
  it('the old COALESCE index no longer exists', async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_claimant'`);
    expect(r.rows[0].n).toBe(0);
  });

  it('both replacements exist and the pure-profile one excludes dual-key rows', async () => {
    const r = await db.query<{ relname: string; def: string }>(
      `SELECT relname, pg_get_indexdef(oid) AS def FROM pg_class
        WHERE relname IN ('uq_invoices_rebook_cyclus_guest','uq_invoices_rebook_cyclus_pure_profile')
        ORDER BY relname`);
    expect(r.rows.map((x) => x.relname)).toEqual([
      'uq_invoices_rebook_cyclus_guest', 'uq_invoices_rebook_cyclus_pure_profile',
    ]);
    const pure = r.rows.find((x) => x.relname === 'uq_invoices_rebook_cyclus_pure_profile')!;
    expect(pure.def).toMatch(/guest_player_id IS NULL/);
    const guest = r.rows.find((x) => x.relname === 'uq_invoices_rebook_cyclus_guest')!;
    expect(guest.def).toMatch(/guest_player_id IS NOT NULL/);
  });
});

describe('ABC-20 · the guest rule', () => {
  it('a guest cannot hold two active invoices for one cyclus — dual-key and guest-only collide', async () => {
    // THE BUG THE OLD KEY HAD: these are the SAME person. Profile-first keyed the first row by
    // its player_id and the second by its guest_player_id, so both were allowed.
    await insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: PROFILE_B, status: 'sent',
    });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: null, status: 'sent',
    })).rejects.toThrow(/uq_invoices_rebook_cyclus_guest|duplicate key/i);
  });

  it('a cancelled invoice does not block a new one', async () => {
    await insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: null, status: 'cancelled',
    });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: null, status: 'sent',
    })).resolves.toBeDefined();
  });

  it('two different guests are independent', async () => {
    await insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: null, status: 'sent',
    });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: IDS.guestOwnedByVictimAcademy,
      player_id: null, status: 'sent',
    })).resolves.toBeDefined();
  });
});

describe('ABC-20 · the pure-profile rule', () => {
  it('a profile cannot hold two active PURE invoices for one cyclus', async () => {
    await insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: null, player_id: PROFILE_B, status: 'sent',
    });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: null, player_id: PROFILE_B, status: 'draft',
    })).rejects.toThrow(/uq_invoices_rebook_cyclus_pure_profile|duplicate key/i);
  });

  it('a guest\'s DUAL-KEY invoice no longer blocks a different person\'s pure-profile invoice', async () => {
    // THE OTHER BUG: profile-first collapsed these two DIFFERENT people onto one key, so the
    // second insert was rejected and that person could not be invoiced at all.
    await insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: GUEST_A, player_id: PROFILE_B, status: 'sent',
    });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: null, player_id: PROFILE_B, status: 'sent',
    })).resolves.toBeDefined();
  });

  it('an invoice with neither identity is unconstrained by both indexes', async () => {
    await insertInvoice({ rebook_cyclus_id: CYCLUS, guest_player_id: null, player_id: null, status: 'sent' });
    await expect(insertInvoice({
      rebook_cyclus_id: CYCLUS, guest_player_id: null, player_id: null, status: 'sent',
    })).resolves.toBeDefined();
  });
});

describe('ABC-20 · concurrency', () => {
  it('two concurrent inserts for one guest cannot both land', async () => {
    // The index IS the concurrency control — this is why idempotency lives in the DB rather than
    // in a read-then-write check in the handler.
    const attempt = () => db.exec(
      `INSERT INTO public.invoices (rebook_cyclus_id, guest_player_id, status)
       VALUES ('${CYCLUS}', '${GUEST_A}', 'sent');`).then(() => 'ok').catch(() => 'conflict');
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);

    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoices
        WHERE rebook_cyclus_id = '${CYCLUS}' AND guest_player_id = '${GUEST_A}' AND status <> 'cancelled'`);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('ABC-20 · the preflight refuses rather than repairs', () => {
  it('aborts on a pre-existing guest conflict and changes nothing', async () => {
    const fresh = new PGlite();
    const exec = (sql: string) => fresh.exec(sql);
    await applyPreH0(exec);
    await fresh.exec(FIXTURE_SQL);

    // Two active invoices for ONE guest, which the old profile-first index permitted because
    // their player_id columns differ. Exactly the state the preflight exists to catch.
    await fresh.exec(`
      INSERT INTO public.invoices (rebook_cyclus_id, guest_player_id, player_id, status)
        VALUES ('${CYCLUS}', '${GUEST_A}', '${PROFILE_B}', 'sent');
      INSERT INTO public.invoices (rebook_cyclus_id, guest_player_id, player_id, status)
        VALUES ('${CYCLUS}', '${GUEST_A}', NULL, 'sent');
    `);

    await expect(applyH0(exec)).rejects.toThrow(/ABC-20 refused/);

    // nothing repaired, nothing cancelled, both rows intact
    const rows = await fresh.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoices WHERE rebook_cyclus_id = '${CYCLUS}'`);
    expect(rows.rows[0].n).toBe(2);
    const cancelled = await fresh.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoices WHERE status = 'cancelled'`);
    expect(cancelled.rows[0].n).toBe(0);
    // and the old index is still in place — the swap did not half-apply
    const old = await fresh.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_claimant'`);
    expect(old.rows[0].n).toBe(1);
  }, 120_000);
});
