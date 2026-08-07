// @vitest-environment node
// C-2 — `notif_open_slots_validate_batch` against a REAL PostgreSQL server.
//
// The whole point of this RPC is that a SCALAR AGGREGATE cannot be row-cap truncated, so the edge
// can prove "everything you submitted is yours and public" instead of filtering a result set and
// hoping. That proof is arithmetic done inside Postgres, and none of it is testable from
// TypeScript: the counts, the FILTER clauses, the timezone conversion and the grants are all SQL.
// So the ACTUAL migration is applied here and the ACTUAL function is called.
//
// What this pins, in order of what would hurt most if it broke:
//   * the equality contract — supplied == matched == public_owned, and each inequality means a
//     DIFFERENT thing (missing / foreign / private), which is what lets the edge report honestly;
//   * the aggregates see ONLY the trainer's own public rows, so a foreign or private slot can
//     never widen the reported window while the counts still look plausible;
//   * the date range is CALENDAR DATES in the trainer's timezone, taken as min/max over the
//     CONVERTED dates — not over the instants, which differ across a DST fall-back;
//   * the degenerate inputs (empty array, NULL array, NULL trainer) answer with one row rather
//     than raising, because refusing an empty batch is the caller's decision to make;
//   * the grants: service_role only. anon and authenticated have no business asking this question
//     about a trainer id they merely typed.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54398;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

const TRAINER = '44444444-4444-4444-4444-444444444444';
const OTHER_TRAINER = '55555555-5555-5555-5555-555555555555';
const TZ = 'Europe/Amsterdam';

type Row = {
  supplied_distinct_count: number;
  matched_count: number;
  public_owned_count: number;
  max_created_at: Date | null;
  min_start_date: Date | null;
  max_start_date: Date | null;
};

const validate = async (ids: string[] | null, trainer: string | null = TRAINER, tz: string | null = TZ): Promise<Row> => {
  const r = await c.query(
    'SELECT * FROM public.notif_open_slots_validate_batch($1::uuid, $2::uuid[], $3::text)',
    [trainer, ids, tz]);
  expect(r.rows.length, 'a scalar aggregate always returns exactly ONE row').toBe(1);
  return r.rows[0] as Row;
};

/** Postgres `date` comes back as a Date in the node TZ; compare the calendar parts only. */
const asIso = (d: Date | null): string | null =>
  d === null ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const slot = async (
  id: string,
  opts: { trainer?: string; isPublic?: boolean; startTime: string; createdAt?: string },
) => c.query(
  `INSERT INTO public.availability_slots (id, trainer_id, start_time, end_time, is_public, created_at)
   VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '1 hour', $4, coalesce($5::timestamptz, now()))`,
  [id, opts.trainer ?? TRAINER, opts.startTime, opts.isPublic ?? true, opts.createdAt ?? null]);

const ID = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'validatebatch-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  // Prod-shaped enough to be honest and no more: the function touches exactly four columns of
  // availability_slots. The REAL migration is what defines them, so the CREATE TABLE below is the
  // production one with its foreign keys dropped (trainer_profiles/lessons are not what is under
  // test, and dragging in half the schema is how a fixture starts diverging from production).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.availability_slots (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      trainer_id uuid NOT NULL,
      start_time timestamptz NOT NULL,
      end_time timestamptz NOT NULL,
      is_public boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);

  // THE MIGRATION UNDER TEST, applied verbatim.
  await c.query(MIG('20261111100000_notif_open_slots_validate_batch.sql'));
}, 180_000);

beforeEach(async () => {
  await c.query('DELETE FROM public.availability_slots');
});

afterAll(async () => {
  await c?.end();
  await epg?.stop();
});

describe('notif_open_slots_validate_batch — the equality contract', () => {
  it('a wholly-owned public batch reports all three counts EQUAL', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    await slot(ID(2), { startTime: '2026-08-16T10:00:00+02' });
    const r = await validate([ID(1), ID(2)]);
    expect(r.supplied_distinct_count).toBe(2);
    expect(r.matched_count).toBe(2);
    expect(r.public_owned_count).toBe(2);
  });

  it('a MISSING id shows up as supplied > matched — and only there', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    const r = await validate([ID(1), ID(9)]);
    expect(r.supplied_distinct_count, 'the size of the question is measured on the INPUT').toBe(2);
    expect(r.matched_count).toBe(1);
    expect(r.public_owned_count).toBe(1);
  });

  it('a FOREIGN id shows up as matched > public_owned — the row exists, it is not yours', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    await slot(ID(2), { trainer: OTHER_TRAINER, startTime: '2026-08-11T10:00:00+02' });
    const r = await validate([ID(1), ID(2)]);
    expect(r.supplied_distinct_count).toBe(2);
    expect(r.matched_count, 'matched_count is deliberately UNSCOPED — any trainer, any visibility').toBe(2);
    expect(r.public_owned_count).toBe(1);
  });

  it('a PRIVATE slot of the caller\'s OWN shows up the same way, and that is correct', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    await slot(ID(2), { isPublic: false, startTime: '2026-08-11T10:00:00+02' });
    const r = await validate([ID(1), ID(2)]);
    expect(r.matched_count).toBe(2);
    expect(r.public_owned_count).toBe(1);
  });

  it('DUPLICATE uuids collapse in supplied_distinct — which is why the edge rejects them upstream', async () => {
    // Asking twice about one slot is one slot. The edge refuses duplicates before it gets here
    // precisely so that `supplied_distinct == the number of ids submitted` stays a real check
    // rather than a tautology.
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    const r = await validate([ID(1), ID(1), ID(1)]);
    expect(r.supplied_distinct_count).toBe(1);
    expect(r.matched_count).toBe(1);
    expect(r.public_owned_count).toBe(1);
  });

  it('MIXED CASE is one uuid to Postgres — the reason the edge requires lowercase canonical form', async () => {
    // This is the executable half of that rule: JavaScript's Set would see two distinct strings
    // here and the database sees one, so without the lowercase requirement the two sides would be
    // counting different things.
    const lower = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await slot(lower, { startTime: '2026-08-10T10:00:00+02' });
    const r = await validate([lower, lower.toUpperCase()]);
    expect(r.supplied_distinct_count).toBe(1);
    expect(r.matched_count).toBe(1);
  });
});

describe('notif_open_slots_validate_batch — the aggregates see ONLY the owned public subset', () => {
  it('a FOREIGN slot cannot widen the reported window', async () => {
    // The whole reason the FILTER is repeated on each aggregate instead of being hoisted into the
    // WHERE clause: matched_count must keep counting the rows the aggregates ignore. Were the
    // window computed over "everything that matched", a foreign slot would stretch it and a
    // downstream freshness check would be reasoning about a slot the trainer does not own.
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02', createdAt: '2026-08-01T09:00:00+02' });
    await slot(ID(2), {
      trainer: OTHER_TRAINER, startTime: '2030-01-01T10:00:00+01', createdAt: '2030-01-01T09:00:00+01',
    });
    const r = await validate([ID(1), ID(2)]);
    expect(asIso(r.min_start_date)).toBe('2026-08-10');
    expect(asIso(r.max_start_date), 'the foreign slot must not stretch the window').toBe('2026-08-10');
    expect(r.max_created_at?.toISOString()).toBe(new Date('2026-08-01T09:00:00+02:00').toISOString());
  });

  it('a PRIVATE slot cannot widen it either', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    await slot(ID(2), { isPublic: false, startTime: '2027-12-31T10:00:00+01' });
    const r = await validate([ID(1), ID(2)]);
    expect(asIso(r.max_start_date)).toBe('2026-08-10');
  });

  it('max_created_at is the NEWEST owned public row — the moment the announced availability appeared', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02', createdAt: '2026-08-01T09:00:00+02' });
    await slot(ID(2), { startTime: '2026-08-11T10:00:00+02', createdAt: '2026-08-03T09:00:00+02' });
    const r = await validate([ID(1), ID(2)]);
    expect(r.max_created_at?.toISOString()).toBe(new Date('2026-08-03T09:00:00+02:00').toISOString());
  });
});

describe('notif_open_slots_validate_batch — the date range is a CALENDAR range in the trainer\'s timezone', () => {
  it('an instant just after local midnight belongs to the LOCAL day, not the UTC one', async () => {
    // 2026-08-10T00:30+02 is 2026-08-09T22:30Z. Deriving the calendar date from the UTC instant —
    // which is what a JavaScript `toISOString().slice(0,10)` on the returned timestamp would do —
    // gives 2026-08-09 and disagrees with the client by a day. This is the off-by-one the whole
    // correction exists to remove, so it is pinned here in the one place that decides it.
    await slot(ID(1), { startTime: '2026-08-10T00:30:00+02' });
    const r = await validate([ID(1)]);
    expect(asIso(r.min_start_date)).toBe('2026-08-10');
    expect(asIso(r.max_start_date)).toBe('2026-08-10');
    expect(r.max_created_at, 'the occurrence is still a real instant, not a date').not.toBeNull();
  });

  it('the SAME instant yields a different calendar date under a different trainer timezone', async () => {
    // Proof that p_timezone is genuinely used rather than decoration.
    await slot(ID(1), { startTime: '2026-08-10T00:30:00+02' });
    expect(asIso((await validate([ID(1)], TRAINER, 'Europe/Amsterdam')).min_start_date)).toBe('2026-08-10');
    expect(asIso((await validate([ID(1)], TRAINER, 'UTC')).min_start_date)).toBe('2026-08-09');
  });

  it('a NULL timezone falls back to Europe/Amsterdam, the column\'s own default', async () => {
    await slot(ID(1), { startTime: '2026-08-10T00:30:00+02' });
    expect(asIso((await validate([ID(1)], TRAINER, null)).min_start_date)).toBe('2026-08-10');
  });

  it('an INVALID timezone RAISES rather than silently substituting one', async () => {
    // Fail closed: the caller gets an RPC error, refuses the batch and enqueues nothing, which is
    // the right outcome for a request whose dates we cannot establish.
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    await expect(validate([ID(1)], TRAINER, 'Mars/Olympus_Mons')).rejects.toThrow();
  });

  it('min/max are taken over the CONVERTED DATES, which differ from the instants across a DST fall-back', async () => {
    // Europe/Amsterdam falls back at 2026-10-25 03:00 CEST -> 02:00 CET.
    //   A = 2026-10-25T00:59:00+02  (22:59Z on the 24th)  -> local 2026-10-25 00:59
    //   B = 2026-10-24T23:30:00+02  (21:30Z on the 24th)  -> local 2026-10-24 23:30
    // B is the EARLIER instant and also the earlier local date, so this pair alone does not
    // separate the two definitions. The separating pair is inside the repeated hour:
    //   C = 2026-10-25T02:30:00+02  (00:30Z) -> local 02:30 on the 25th
    //   D = 2026-10-25T02:30:00+01  (01:30Z) -> local 02:30 on the 25th, one hour LATER in UTC
    // Both land on the same local date, so `min(instant)` and `min(local date)` agree here too —
    // which is the point worth pinning: the function must not be sensitive to WHICH of the two
    // repeated wall-clock instants it saw. What it must get right is the DATE.
    await slot(ID(1), { startTime: '2026-10-25T00:30:00Z' });   // local 02:30 CEST, 25 Oct
    await slot(ID(2), { startTime: '2026-10-25T01:30:00Z' });   // local 02:30 CET,  25 Oct
    const r = await validate([ID(1), ID(2)]);
    expect(asIso(r.min_start_date)).toBe('2026-10-25');
    expect(asIso(r.max_start_date)).toBe('2026-10-25');

    // And a batch that genuinely straddles the transition reports both days.
    await c.query('DELETE FROM public.availability_slots');
    await slot(ID(3), { startTime: '2026-10-24T21:30:00Z' });   // local 23:30 CEST, 24 Oct
    await slot(ID(4), { startTime: '2026-10-25T01:30:00Z' });   // local 02:30 CET,  25 Oct
    const s = await validate([ID(3), ID(4)]);
    expect(asIso(s.min_start_date)).toBe('2026-10-24');
    expect(asIso(s.max_start_date)).toBe('2026-10-25');
  });
});

describe('notif_open_slots_validate_batch — the degenerate inputs answer, they do not raise', () => {
  it('an EMPTY array is one row of zeros, so the caller decides with a count in hand', async () => {
    const r = await validate([]);
    expect(r).toMatchObject({ supplied_distinct_count: 0, matched_count: 0, public_owned_count: 0 });
    expect(r.max_created_at).toBeNull();
    expect(r.min_start_date).toBeNull();
    expect(r.max_start_date).toBeNull();
  });

  it('a NULL array is the same, not an error', async () => {
    const r = await validate(null);
    expect(r.supplied_distinct_count).toBe(0);
    expect(r.matched_count).toBe(0);
  });

  it('a NULL trainer fails the equality for any non-empty batch instead of waving it through', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    const r = await validate([ID(1)], null);
    expect(r.supplied_distinct_count).toBe(1);
    expect(r.matched_count).toBe(1);
    expect(r.public_owned_count, '`trainer_id = NULL` is NULL, so nothing is owned').toBe(0);
    expect(r.max_created_at).toBeNull();
  });

  it('a NULL element is invisible to count(DISTINCT) and matches nothing — it cannot be smuggled through', async () => {
    await slot(ID(1), { startTime: '2026-08-10T10:00:00+02' });
    const r = await validate([ID(1), null as unknown as string]);
    expect(r.supplied_distinct_count, 'count(DISTINCT) skips NULLs').toBe(1);
    expect(r.matched_count).toBe(1);
    expect(r.public_owned_count).toBe(1);
    // The equality therefore HOLDS for this input, which is exactly why the edge refuses a
    // non-string element before it can be sent. Stated here so the division of labour is explicit.
  });

  it('a LARGE batch is still exactly one row — the property the whole design rests on', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 500; i++) {
      ids.push(ID(i));
      await slot(ID(i), { startTime: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10:00:00+02` });
    }
    const r = await validate(ids);
    expect(r.supplied_distinct_count).toBe(500);
    expect(r.matched_count).toBe(500);
    expect(r.public_owned_count).toBe(500);
  }, 120_000);
});

describe('notif_open_slots_validate_batch — the grants', () => {
  it('is EXECUTABLE by service_role and by nobody else', async () => {
    const r = await c.query(`
      SELECT
        has_function_privilege('service_role',   p.oid, 'EXECUTE') AS svc,
        has_function_privilege('authenticated',  p.oid, 'EXECUTE') AS auth,
        has_function_privilege('anon',           p.oid, 'EXECUTE') AS anon,
        has_function_privilege('public',         p.oid, 'EXECUTE') AS pub
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'notif_open_slots_validate_batch'`);
    expect(r.rows.length, 'exactly one overload — a second would make PostgREST guess').toBe(1);
    expect(r.rows[0]).toMatchObject({ svc: true, auth: false, anon: false, pub: false });
  });

  it('is SECURITY INVOKER, STABLE, and pins its search_path', async () => {
    // DEFINER here would hand any future grantee an RLS-free read of every trainer's slots, and
    // the only caller is a service-role client that already reads this table directly.
    const r = await c.query(`
      SELECT p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'notif_open_slots_validate_batch'`);
    expect(r.rows[0].definer).toBe(false);
    expect(r.rows[0].volatility).toBe('s');
    expect(r.rows[0].config).toEqual(['search_path=pg_catalog']);
  });

  it('never returns slot rows — the immunity to row caps is structural, not incidental', async () => {
    const r = await c.query(`
      SELECT pg_get_function_result(p.oid) AS result
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'notif_open_slots_validate_batch'`);
    // A TABLE(...) of six scalars. If this ever becomes SETOF availability_slots, a PostgREST row
    // cap can silently truncate the answer and every equality above stops proving anything.
    expect(r.rows[0].result).toContain('supplied_distinct_count integer');
    expect(r.rows[0].result).not.toContain('availability_slots');
  });
});
