// @vitest-environment node
// Trainer double-booking guard (migration 20260708100000): an AFTER ROW trigger on
// availability_slots rejects any INSERTed/time-moved slot whose [start,end) range
// overlaps another slot of the SAME trainer — the DB backstop behind every
// slot-creation path's best-effort client dedup. Runs the REAL migration SQL.
//
// The AFTER (not BEFORE) choice is load-bearing and asserted here: a single UPDATE
// statement shifting a whole cycle's sessions by exactly one week (each row landing on
// a sibling's OLD time — apply_slot_edit_to_cycle does this shape) must pass, because
// the trigger sees the statement's FINAL state.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const T1 = '10000000-0000-0000-0000-000000000001';
const T2 = '10000000-0000-0000-0000-000000000002';

const S = (h: number, m = 0, day = 10) =>
  `2026-08-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

const insertSlot = (trainer: string, start: string, end: string, id?: string) =>
  db.query(
    id
      ? `INSERT INTO availability_slots (id, trainer_id, start_time, end_time) VALUES ($1, $2, $3, $4)`
      : `INSERT INTO availability_slots (trainer_id, start_time, end_time) VALUES ($1, $2, $3)`,
    id ? [id, trainer, start, end] : [trainer, start, end],
  );

const expectOverlapRefusal = async (p: Promise<unknown>) => {
  let err: unknown;
  await p.then(
    () => {
      throw new Error('expected trainer_slot_overlap, but the write succeeded');
    },
    (e: unknown) => {
      err = e;
    },
  );
  expect(String((err as { message?: string })?.message ?? err)).toContain('trainer_slot_overlap');
};

const count = async (where = 'TRUE', params: unknown[] = []) =>
  Number(
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM availability_slots WHERE ${where}`, params))
      .rows[0].n,
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid NOT NULL,
      start_time timestamptz NOT NULL,
      end_time timestamptz NOT NULL,
      is_public boolean DEFAULT false,
      price_per_session numeric,
      cyclus_id uuid
    );
    CREATE INDEX idx_availability_slots_trainer_start ON availability_slots (trainer_id, start_time);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260708100000_trainer_slot_overlap_guard.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.exec(`DELETE FROM availability_slots;`);
});

describe('check_trainer_slot_overlap (real migration SQL)', () => {
  it('rejects an exact duplicate for the same trainer', async () => {
    await insertSlot(T1, S(10), S(11));
    await expectOverlapRefusal(insertSlot(T1, S(10), S(11)));
    expect(await count()).toBe(1);
  });

  it('rejects a partial overlap (the exact-start-dedup blind spot)', async () => {
    await insertSlot(T1, S(10), S(11));
    await expectOverlapRefusal(insertSlot(T1, S(10, 30), S(11, 30)));
    // ...and a slot fully containing the existing one
    await expectOverlapRefusal(insertSlot(T1, S(9), S(12)));
    expect(await count()).toBe(1);
  });

  it('allows back-to-back sessions (half-open ranges) and other trainers at the same time', async () => {
    await insertSlot(T1, S(10), S(11));
    await insertSlot(T1, S(11), S(12)); // starts exactly at the other's end
    await insertSlot(T1, S(9), S(10)); // ends exactly at the other's start
    await insertSlot(T2, S(10), S(11)); // different trainer, same time
    expect(await count()).toBe(4);
  });

  it('aborts a batch INSERT containing an internal duplicate (all-or-nothing)', async () => {
    await expectOverlapRefusal(
      db.query(
        `INSERT INTO availability_slots (trainer_id, start_time, end_time)
         VALUES ($1, $2, $3), ($1, $2, $3)`,
        [T1, S(10), S(11)],
      ),
    );
    expect(await count()).toBe(0);
  });

  it('rejects an UPDATE that moves a slot onto a sibling', async () => {
    const A = '20000000-0000-0000-0000-00000000000a';
    await insertSlot(T1, S(10), S(11), A);
    await insertSlot(T1, S(12), S(13));
    await expectOverlapRefusal(
      db.query(`UPDATE availability_slots SET start_time = $2, end_time = $3 WHERE id = $1`, [A, S(12, 30), S(13, 30)]),
    );
  });

  it('allows a single-statement whole-cycle shift where rows land on siblings OLD times (AFTER-trigger semantics)', async () => {
    // Weekly sessions on Aug 10/17/24; shift ALL one week earlier in ONE statement:
    // Aug 17 lands exactly on Aug 10's old range — must pass because the trigger sees
    // the statement's final state (this is the apply_slot_edit_to_cycle shape).
    const CY = '30000000-0000-0000-0000-000000000001';
    for (const day of [10, 17, 24]) {
      await db.query(
        `INSERT INTO availability_slots (trainer_id, start_time, end_time, cyclus_id) VALUES ($1, $2, $3, $4)`,
        [T1, S(10, 0, day), S(11, 0, day), CY],
      );
    }
    await db.query(
      `UPDATE availability_slots
         SET start_time = start_time - interval '7 days', end_time = end_time - interval '7 days'
       WHERE cyclus_id = $1`,
      [CY],
    );
    expect(await count(`start_time = $1`, [S(10, 0, 3)])).toBe(1);
    expect(await count(`start_time = $1`, [S(10, 0, 17)])).toBe(1);
    expect(await count(`start_time = $1`, [S(10, 0, 24)])).toBe(0);
  });

  it('does not fire on non-time updates, and lets a pre-existing overlapping row be moved AWAY', async () => {
    // Seed an overlapping pair with the triggers disabled (models pre-migration prod data).
    const A = '20000000-0000-0000-0000-00000000000a';
    const B = '20000000-0000-0000-0000-00000000000b';
    await db.exec(`ALTER TABLE availability_slots DISABLE TRIGGER trg_trainer_slot_overlap_ins;`);
    await insertSlot(T1, S(10), S(11), A);
    await insertSlot(T1, S(10), S(11), B);
    await db.exec(`ALTER TABLE availability_slots ENABLE TRIGGER trg_trainer_slot_overlap_ins;`);

    // Non-time update on a still-overlapping row: WHEN clause keeps the trigger silent.
    await db.query(`UPDATE availability_slots SET price_per_session = 25 WHERE id = $1`, [A]);
    // Moving one of the bad pair AWAY is allowed (the guard helps clean up, never traps)...
    await db.query(`UPDATE availability_slots SET start_time = $2, end_time = $3 WHERE id = $1`, [A, S(14), S(15)]);
    // ...but moving it back INTO the overlap is refused.
    await expectOverlapRefusal(
      db.query(`UPDATE availability_slots SET start_time = $2, end_time = $3 WHERE id = $1`, [A, S(10, 30), S(11, 30)]),
    );
  });

  it('carries the conflicting slot in DETAIL (client display contract)', async () => {
    const A = '20000000-0000-0000-0000-00000000000a';
    await insertSlot(T1, S(10), S(11), A);
    let detail = '';
    await insertSlot(T1, S(10), S(11)).catch((e: { detail?: string; message?: string }) => {
      detail = e.detail ?? '';
    });
    expect(detail).toContain(A);
    expect(detail).toContain('conflicting_slot_id');
  });
});
