// @vitest-environment node
// 10c-a3 PR-1 — the hardened v1 email-delivery state machine + Resend suppression lifecycle
// (migration 20261006100000). Pins, in a single connection (concurrency itself is proven in the real-PG suite):
//   * RECENCY: an out-of-order OLDER `delivered` never clears a NEWER bounce; a NEWER `delivered` recovers.
//   * complaint is STICKY; `sent` only initializes a brand-new address (never downgrades).
//   * SUPPRESSION lifecycle: email.suppressed sets, suppression.removed clears, both UNORDERED-SAFE.
//   * the canonical generated `is_suppressed` predicate + is_email_suppressed() + operator reset.
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                 CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
  await db.exec(MIG('20260615110000_email_delivery_tables.sql'));
  await db.exec(MIG('20260615110010_record_email_event.sql'));
  await db.exec(MIG('20261006100000_email_delivery_concurrency_suppression.sql'));
  return db;
}

let db: PGlite;
beforeEach(async () => { db = await freshDb(); });

let n = 0;
const rec = (
  event_type: string,
  o: { email?: string; eid?: string; bounce?: string; at?: string } = {},
) =>
  db.query(`SELECT record_email_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    event_type, o.email ?? 'a@x.com', null, o.eid ?? `e${++n}`, o.bounce ?? null,
    null, null, null, null, o.at ?? null,
  ]);

const state = async (email = 'a@x.com') =>
  (await db.query<{ state: string; provider_suppressed_active: boolean; is_suppressed: boolean }>(
    `SELECT state, provider_suppressed_active, is_suppressed FROM email_address_state WHERE email=$1`, [email])).rows[0];
const suppressed = async (email = 'a@x.com') =>
  (await db.query<{ s: boolean }>(`SELECT is_email_suppressed($1) AS s`, [email])).rows[0].s;

describe('record_email_event — recency-aware state (finding 1)', () => {
  it('an OLDER delivered arriving after a NEWER hard bounce does NOT clear it', async () => {
    await rec('bounced', { bounce: 'hard', at: '2026-07-01T12:00:00Z' });
    await rec('delivered', { at: '2026-07-01T11:00:00Z' }); // older
    expect((await state()).state).toBe('hard_bounced');
    expect(await suppressed()).toBe(true);
  });

  it('a NEWER delivered clears an older bounce', async () => {
    await rec('bounced', { bounce: 'hard', at: '2026-07-01T12:00:00Z' });
    await rec('delivered', { at: '2026-07-01T13:00:00Z' }); // newer
    expect((await state()).state).toBe('ok');
    expect(await suppressed()).toBe(false);
  });

  it('a complaint is sticky — a later delivered never clears it', async () => {
    await rec('complained', { at: '2026-07-01T12:00:00Z' });
    await rec('delivered', { at: '2026-07-01T13:00:00Z' });
    expect((await state()).state).toBe('complained');
    expect(await suppressed()).toBe(true);
  });

  it('sent never downgrades a bad state, and a fresh sent leaves ok', async () => {
    await rec('bounced', { bounce: 'hard', at: '2026-07-01T12:00:00Z' });
    await rec('sent', { at: '2026-07-01T13:00:00Z' });
    expect((await state()).state).toBe('hard_bounced');
    // a fresh address that only got a sent is ok + not suppressed
    await rec('sent', { email: 'new@x.com', at: '2026-07-01T09:00:00Z' });
    expect((await state('new@x.com')).state).toBe('ok');
    expect(await suppressed('new@x.com')).toBe(false);
  });

  it('LIVE P1: sent@12 sets NO barrier — a delayed older hard bounce@11 still suppresses', async () => {
    await rec('sent', { email: 'p1@x.com', at: '2026-07-01T12:00:00Z' });        // acceptance, not delivery
    await rec('bounced', { email: 'p1@x.com', bounce: 'hard', at: '2026-07-01T11:00:00Z' }); // delayed, OLDER
    expect((await state('p1@x.com')).state).toBe('hard_bounced');
    expect(await suppressed('p1@x.com')).toBe(true);
  });

  it('LIVE P1: sent@12 then a delayed older complaint@11 still suppresses (complaint too)', async () => {
    await rec('sent', { email: 'p1c@x.com', at: '2026-07-01T12:00:00Z' });
    await rec('complained', { email: 'p1c@x.com', at: '2026-07-01T11:00:00Z' });
    expect((await state('p1c@x.com')).state).toBe('complained');
    expect(await suppressed('p1c@x.com')).toBe(true);
  });

  it('a duplicate resend_event_id is a no-op (idempotent)', async () => {
    await rec('bounced', { eid: 'dup', bounce: 'hard' });
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM email_delivery_events`)).rows[0].n;
    await rec('delivered', { eid: 'dup', at: '2999-01-01T00:00:00Z' }); // same svix id, would otherwise clear
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM email_delivery_events`)).rows[0].n).toBe(before);
    expect((await state()).state).toBe('hard_bounced'); // unchanged — the duplicate never applied
  });
});

describe('Resend suppression lifecycle (finding 2) — recoverable + unordered-safe', () => {
  it('email.suppressed sets, suppression.removed (newer) recovers', async () => {
    await rec('suppressed', { email: 's@x.com', at: '2026-07-02T10:00:00Z' });
    expect((await state('s@x.com')).provider_suppressed_active).toBe(true);
    expect(await suppressed('s@x.com')).toBe(true);
    await rec('suppression_removed', { email: 's@x.com', at: '2026-07-02T11:00:00Z' });
    expect((await state('s@x.com')).provider_suppressed_active).toBe(false);
    expect(await suppressed('s@x.com')).toBe(false);
  });

  it('a late OLDER suppressed does NOT undo a NEWER removal', async () => {
    await rec('suppressed', { email: 's@x.com', at: '2026-07-02T10:00:00Z' });
    await rec('suppression_removed', { email: 's@x.com', at: '2026-07-02T11:00:00Z' });
    await rec('suppressed', { email: 's@x.com', at: '2026-07-02T09:00:00Z' }); // older than the removal
    expect((await state('s@x.com')).provider_suppressed_active).toBe(false);
    expect(await suppressed('s@x.com')).toBe(false);
  });

  it('suppression is orthogonal to bounce state (a hard bounce + a suppression both suppress)', async () => {
    await rec('suppressed', { email: 'both@x.com', at: '2026-07-02T10:00:00Z' });
    await rec('bounced', { email: 'both@x.com', bounce: 'hard', at: '2026-07-02T11:00:00Z' });
    expect((await state('both@x.com')).state).toBe('hard_bounced');
    expect((await state('both@x.com')).provider_suppressed_active).toBe(true);
    // clearing only the bounce (a newer delivered) leaves the provider suppression in place
    await rec('delivered', { email: 'both@x.com', at: '2026-07-02T12:00:00Z' });
    expect((await state('both@x.com')).state).toBe('ok');
    expect(await suppressed('both@x.com')).toBe(true); // still suppressed via provider axis
  });

  it('operator reset clears both axes', async () => {
    await rec('complained', { email: 'r@x.com', at: '2026-07-02T10:00:00Z' });
    await rec('suppressed', { email: 'r@x.com', at: '2026-07-02T11:00:00Z' });
    expect(await suppressed('r@x.com')).toBe(true);
    await db.query(`SELECT reset_email_suppression($1)`, ['r@x.com']);
    expect(await suppressed('r@x.com')).toBe(false);
    expect((await state('r@x.com')).state).toBe('ok');
  });

  it('equal-timestamp suppression tie is deterministic — suppression WINS, both arrival orders', async () => {
    // removed then suppressed at the SAME instant → suppressed wins
    await rec('suppression_removed', { email: 'eq1@x.com', at: '2026-07-03T10:00:00Z' });
    await rec('suppressed', { email: 'eq1@x.com', at: '2026-07-03T10:00:00Z' });
    expect(await suppressed('eq1@x.com')).toBe(true);
    // suppressed then removed at the SAME instant → suppressed still wins
    await rec('suppressed', { email: 'eq2@x.com', at: '2026-07-03T10:00:00Z' });
    await rec('suppression_removed', { email: 'eq2@x.com', at: '2026-07-03T10:00:00Z' });
    expect(await suppressed('eq2@x.com')).toBe(true);
  });
});

describe('complaint ↔ operator reset ordering (finding 2)', () => {
  it('an OLDER complaint does NOT resurrect a complaint after a reset', async () => {
    await rec('complained', { email: 'c@x.com', at: '2026-07-04T10:00:00Z' });
    await db.query(`SELECT reset_email_suppression($1)`, ['c@x.com']); // reset at ~now (2026)
    await rec('complained', { email: 'c@x.com', at: '2026-07-04T09:00:00Z' }); // older than the reset
    expect((await state('c@x.com')).state).toBe('ok');
    expect(await suppressed('c@x.com')).toBe(false);
  });

  it('a NEWER complaint (after the reset) DOES re-suppress', async () => {
    await db.query(`SELECT reset_email_suppression($1)`, ['c2@x.com']);
    await rec('complained', { email: 'c2@x.com', at: '2999-01-01T00:00:00Z' }); // after the reset
    expect((await state('c2@x.com')).state).toBe('complained');
    expect(await suppressed('c2@x.com')).toBe(true);
  });

  it('a complaint still beats ordinary delivery regardless of arrival order', async () => {
    // delivered (newer) processed first, then an OLDER complaint → complaint wins (sticky vs delivery)
    await rec('delivered', { email: 'c3@x.com', at: '2026-07-04T12:00:00Z' });
    await rec('complained', { email: 'c3@x.com', at: '2026-07-04T11:00:00Z' });
    expect((await state('c3@x.com')).state).toBe('complained');
  });

  it('EQUAL-TIME reset/complaint precedence is explicit: the RESET wins, both arrival orders', async () => {
    const T = '2026-07-04T10:00:00Z';
    // (a) reset then a same-instant complaint → reset wins → stays ok (the complaint does not re-suppress)
    await rec('complained', { email: 'eqr1@x.com', at: '2026-07-04T09:00:00Z' });
    await db.query(`SELECT reset_email_suppression($1)`, ['eqr1@x.com']);  // stamps last_reset_at = now() (real time)
    // force the reset clock to exactly T, then a complaint at exactly T
    await db.query(`UPDATE email_address_state SET last_reset_at=$2, state_changed_at=$2 WHERE email=$1`, ['eqr1@x.com', T]);
    await rec('complained', { email: 'eqr1@x.com', at: T });
    expect((await state('eqr1@x.com')).state).toBe('ok');            // reset wins the tie
    expect(await suppressed('eqr1@x.com')).toBe(false);
    // (b) a complaint strictly AFTER the reset instant does re-suppress (boundary is strict)
    await rec('complained', { email: 'eqr1@x.com', at: '2026-07-04T10:00:01Z' });
    expect((await state('eqr1@x.com')).state).toBe('complained');
  });
});

describe('latest-event metadata coherence (finding 4)', () => {
  it('a stale callback does NOT install its type beside a newer timestamp', async () => {
    await rec('bounced', { email: 'm@x.com', bounce: 'hard', at: '2026-07-05T12:00:00Z' });
    await rec('delivered', { email: 'm@x.com', at: '2026-07-05T11:00:00Z' }); // stale (older)
    const row = (await db.query<{ last_event_type: string; last_event_at: string }>(
      `SELECT last_event_type, last_event_at FROM email_address_state WHERE email='m@x.com'`)).rows[0];
    // last_event_* must still describe the NEWER bounce, not the stale delivered
    expect(row.last_event_type).toBe('bounced');
    expect(new Date(row.last_event_at).toISOString()).toBe('2026-07-05T12:00:00.000Z');
  });

  it('on the suppression axis too, a stale callback does not desync last_event_type/at', async () => {
    await rec('suppressed', { email: 'ms@x.com', at: '2026-07-05T12:00:00Z' });
    await rec('suppression_removed', { email: 'ms@x.com', at: '2026-07-05T11:00:00Z' }); // stale (older)
    const row = (await db.query<{ last_event_type: string; last_event_at: string }>(
      `SELECT last_event_type, last_event_at FROM email_address_state WHERE email='ms@x.com'`)).rows[0];
    expect(row.last_event_type).toBe('suppressed');
    expect(new Date(row.last_event_at).toISOString()).toBe('2026-07-05T12:00:00.000Z');
    expect(await suppressed('ms@x.com')).toBe(true); // and the stale removal didn't undo the suppression
  });

  it('equal-timestamp state metadata follows the WINNER, both arrival orders', async () => {
    const T = '2026-07-06T10:00:00Z';
    // bounce then delivered at the SAME instant → hard bounce wins (severity); metadata must say 'bounced'
    await rec('bounced', { email: 'et1@x.com', bounce: 'hard', at: T });
    await rec('delivered', { email: 'et1@x.com', at: T });
    let r1 = (await db.query<{ state: string; last_event_type: string }>(
      `SELECT state, last_event_type FROM email_address_state WHERE email='et1@x.com'`)).rows[0];
    expect(r1.state).toBe('hard_bounced');
    expect(r1.last_event_type).toBe('bounced'); // never 'delivered' beside a hard_bounced state
    // delivered then bounce at the SAME instant → same winner + coherent metadata
    await rec('delivered', { email: 'et2@x.com', at: T });
    await rec('bounced', { email: 'et2@x.com', bounce: 'hard', at: T });
    r1 = (await db.query<{ state: string; last_event_type: string }>(
      `SELECT state, last_event_type FROM email_address_state WHERE email='et2@x.com'`)).rows[0];
    expect(r1.state).toBe('hard_bounced');
    expect(r1.last_event_type).toBe('bounced');
  });

  it('equal-timestamp suppression metadata follows the WINNER (suppression), both arrival orders', async () => {
    const T = '2026-07-06T11:00:00Z';
    for (const [e, first, second] of [['es1@x.com', 'suppressed', 'suppression_removed'], ['es2@x.com', 'suppression_removed', 'suppressed']] as const) {
      await rec(first, { email: e, at: T });
      await rec(second, { email: e, at: T });
      const r = (await db.query<{ provider_suppressed_active: boolean; last_event_type: string }>(
        `SELECT provider_suppressed_active, last_event_type FROM email_address_state WHERE email=$1`, [e])).rows[0];
      expect(r.provider_suppressed_active).toBe(true);           // suppression wins the tie
      expect(r.last_event_type).toBe('suppressed');              // metadata agrees — never 'suppression_removed' beside active suppression
    }
  });
});

// The UPGRADE PATH: existing rows written by the OLD function have no recency clock. The new migration must backfill
// state_changed_at, else the first post-migration OLDER callback regresses a live bounce (Codex finding 1).
describe('migration-order backfill (finding 1, upgrade path)', () => {
  // Codex's exact repro: the old writer advances last_event_at for send_failed (which does NOT change state), so a
  // last_event_at-based backfill would set the recency clock to 12:00 and wrongly reject the 11:00 bounce. The
  // state-PRODUCING derivation must set state_changed_at from the 10:00 delivered → the 11:00 bounce then applies.
  it('delivered 10:00 → send_failed 12:00 → migrate → delayed hard bounce 11:00 ⇒ hard_bounced/suppressed', async () => {
    const db2 = new PGlite();
    await db2.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                    CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
    await db2.exec(MIG('20260615110000_email_delivery_tables.sql'));
    await db2.exec(MIG('20260615110010_record_email_event.sql'));            // OLD function (no recency clock)
    const oldRec = (t: string, eid: string, at: string, bt: string | null = null) =>
      db2.query(`SELECT record_email_event($1,'old@x.com',NULL,$2,$3,NULL,NULL,NULL,NULL,$4)`, [t, eid, bt, at]);
    await oldRec('delivered', 'od1', '2026-07-01T10:00:00Z');               // state → ok (state-producing @ 10:00)
    await oldRec('send_failed', 'sf1', '2026-07-01T12:00:00Z');             // state UNCHANGED, but last_event_at → 12:00
    await db2.exec(MIG('20261006100000_email_delivery_concurrency_suppression.sql')); // NEW migration + backfill
    const sc = (await db2.query<{ state_changed_at: string }>(
      `SELECT state_changed_at FROM email_address_state WHERE email='old@x.com'`)).rows[0];
    expect(new Date(sc.state_changed_at).toISOString()).toBe('2026-07-01T10:00:00.000Z'); // from the delivered, NOT 12:00
    await db2.query(`SELECT record_email_event('bounced','old@x.com',NULL,'ob1','hard',NULL,NULL,NULL,NULL,$1)`,
      ['2026-07-01T11:00:00Z']);                                            // a delayed bounce, AFTER the delivered
    const st = (await db2.query<{ state: string; is_suppressed: boolean }>(
      `SELECT state, is_suppressed FROM email_address_state WHERE email='old@x.com'`)).rows[0];
    expect(st.state).toBe('hard_bounced');
    expect(st.is_suppressed).toBe(true);
  });

  // A LATER `sent` is not state-producing (the old writer only let the FIRST sent initialize) — so the ok backfill
  // must use the latest delivered, not max(sent), else the recency clock is placed too late.
  it('delivered 10:00 → sent 12:00 → migrate → delayed hard bounce 11:00 ⇒ hard_bounced (later sent is not state-producing)', async () => {
    const db2 = new PGlite();
    await db2.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                    CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
    await db2.exec(MIG('20260615110000_email_delivery_tables.sql'));
    await db2.exec(MIG('20260615110010_record_email_event.sql'));
    const oldRec = (t: string, eid: string, at: string) =>
      db2.query(`SELECT record_email_event($1,'s2@x.com',NULL,$2,NULL,NULL,NULL,NULL,NULL,$3)`, [t, eid, at]);
    await oldRec('delivered', 'd1', '2026-07-01T10:00:00Z');                // ok (state-producing @ 10:00)
    await oldRec('sent', 's1', '2026-07-01T12:00:00Z');                     // later sent — NOT state-producing
    await db2.exec(MIG('20261006100000_email_delivery_concurrency_suppression.sql'));
    expect(new Date((await db2.query<{ state_changed_at: string }>(
      `SELECT state_changed_at FROM email_address_state WHERE email='s2@x.com'`)).rows[0].state_changed_at).toISOString())
      .toBe('2026-07-01T10:00:00.000Z');                                    // from the delivered, NOT the 12:00 sent
    await db2.query(`SELECT record_email_event('bounced','s2@x.com',NULL,'b2','hard',NULL,NULL,NULL,NULL,$1)`, ['2026-07-01T11:00:00Z']);
    expect((await db2.query<{ state: string }>(`SELECT state FROM email_address_state WHERE email='s2@x.com'`)).rows[0].state).toBe('hard_bounced');
  });

  // An existing `ok` row with NO matching state-producing event (e.g. its events were pruned by retention) must not
  // be pinned to updated_at — a genuine earlier negative callback must still suppress it (permissive for ok).
  it('an ok row with no matching event still accepts a genuine earlier bounce (fallback direction is permissive for ok)', async () => {
    const db2 = new PGlite();
    await db2.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                    CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
    await db2.exec(MIG('20260615110000_email_delivery_tables.sql'));
    await db2.exec(MIG('20260615110010_record_email_event.sql'));
    await db2.query(`INSERT INTO email_address_state (email, state, updated_at) VALUES ('np@x.com','ok',$1)`, ['2026-07-01T15:00:00Z']);
    await db2.exec(MIG('20261006100000_email_delivery_concurrency_suppression.sql'));
    expect((await db2.query<{ state_changed_at: string | null }>(
      `SELECT state_changed_at FROM email_address_state WHERE email='np@x.com'`)).rows[0].state_changed_at).toBeNull();
    await db2.query(`SELECT record_email_event('bounced','np@x.com',NULL,'b3','hard',NULL,NULL,NULL,NULL,$1)`, ['2026-07-01T10:00:00Z']); // earlier than updated_at
    expect((await db2.query<{ state: string; is_suppressed: boolean }>(
      `SELECT state, is_suppressed FROM email_address_state WHERE email='np@x.com'`)).rows[0]).toMatchObject({ state: 'hard_bounced', is_suppressed: true });
  });
});

// Round-8 finding 1 [P1]: existing `state` itself can be arrival-order-WRONG (the old writer's last-upsert-wins). The
// backfill must RECOMPUTE canonical state (not just the clock) by replaying state-producing history — both directions.
describe('round-8: backfill RECOMPUTES canonical state from history (P1, upgrade path)', () => {
  // seed a pre-migration state row + raw historical events, then apply the migration (which backfills), then inspect.
  const legacyThenMigrate = async (email: string, legacyState: string, events: Array<[string, string, string | null]>, updatedAt = '2026-07-01T15:00:00Z') => {
    const db2 = new PGlite();
    await db2.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
    await db2.exec(MIG('20260615110000_email_delivery_tables.sql'));
    await db2.exec(MIG('20260615110010_record_email_event.sql'));
    await db2.query(`INSERT INTO email_address_state (email, state, updated_at) VALUES ($1,$2,$3)`, [email, legacyState, updatedAt]);
    let i = 0;
    for (const [et, at, bt] of events)
      await db2.query(`INSERT INTO email_delivery_events (resend_event_id, event_type, bounce_type, recipient_email, occurred_at) VALUES ($1,$2,$3,$4,$5)`, [`${email}-${i++}`, et, bt, email, at]);
    await db2.exec(MIG('20261006100000_email_delivery_concurrency_suppression.sql'));
    return (await db2.query<{ state: string; is_suppressed: boolean; state_changed_at: string | null; last_event_type: string | null; last_event_at: string | null; reason: string | null }>(
      `SELECT state, is_suppressed, state_changed_at, last_event_type, last_event_at, reason FROM email_address_state WHERE email=$1`, [email])).rows[0];
  };

  it('old `ok` despite a NEWER hard bounce ⇒ recomputed to hard_bounced/suppressed', async () => {
    const r = await legacyThenMigrate('d1@x.com', 'ok', [['delivered', '2026-07-01T11:00:00Z', null], ['bounced', '2026-07-01T12:00:00Z', 'hard']]);
    expect(r).toMatchObject({ state: 'hard_bounced', is_suppressed: true });
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('old `hard_bounced` despite a NEWER delivery ⇒ recomputed to ok/not-suppressed', async () => {
    const r = await legacyThenMigrate('d2@x.com', 'hard_bounced', [['bounced', '2026-07-01T11:00:00Z', 'hard'], ['delivered', '2026-07-01T12:00:00Z', null]]);
    expect(r).toMatchObject({ state: 'ok', is_suppressed: false });
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('complaint stickiness survives recomputation (complaint then a later delivery ⇒ complained)', async () => {
    const r = await legacyThenMigrate('d3@x.com', 'ok', [['complained', '2026-07-01T11:00:00Z', null], ['delivered', '2026-07-01T12:00:00Z', null]]);
    expect(r).toMatchObject({ state: 'complained', is_suppressed: true });
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-01T11:00:00.000Z'); // the complaint that set it
  });

  it('equal-instant severity holds in the replay (delivered + hard bounce at the same time ⇒ hard_bounced)', async () => {
    const r = await legacyThenMigrate('d4@x.com', 'ok', [['delivered', '2026-07-01T12:00:00Z', null], ['bounced', '2026-07-01T12:00:00Z', 'hard']]);
    expect(r.state).toBe('hard_bounced');
  });

  it('a `sent`-only history stays ok with NO clock barrier (sent is acceptance, not delivery evidence)', async () => {
    const r = await legacyThenMigrate('d5@x.com', 'ok', [['sent', '2026-07-01T10:00:00Z', null], ['sent', '2026-07-01T12:00:00Z', null]]);
    expect(r.state).toBe('ok');
    expect(r.state_changed_at).toBeNull();   // permissive — a delayed older bounce can still suppress (audit/round-9 P1)
  });

  it('UPGRADE P1: a `sent`@12 followed by a delayed older hard bounce@11 ⇒ hard_bounced/suppressed (sent set no barrier)', async () => {
    const r = await legacyThenMigrate('d5b@x.com', 'ok', [['sent', '2026-07-01T12:00:00Z', null], ['bounced', '2026-07-01T11:00:00Z', 'hard']]);
    expect(r).toMatchObject({ state: 'hard_bounced', is_suppressed: true });
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-01T11:00:00.000Z');
  });

  it('FAIL-SAFE: a suppressed row with NO state-producing history (purged) is NOT downgraded', async () => {
    const r = await legacyThenMigrate('d6@x.com', 'hard_bounced', [['send_failed', '2026-07-01T12:00:00Z', null]], '2026-07-01T15:00:00Z');
    expect(r).toMatchObject({ state: 'hard_bounced', is_suppressed: true });   // never blind-downgraded to ok
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-01T15:00:00.000Z'); // fail-safe clock = updated_at
  });

  // Round-8 finding 1 [P1] PARTIAL history: a suppressing ORIGIN was retention-swept but a later `delivered` survives.
  // The lone delivered must NOT silently clear the suppressed row — downgrade needs the matching origin in history.
  it.each([
    ['hard_bounced'],
    ['complained'],
  ] as const)('PARTIAL history: a SUPPRESSED %s with only a surviving later `delivered` (origin purged) is PRESERVED', async (st) => {
    const r = await legacyThenMigrate(`p-${st}@x.com`, st, [['delivered', '2026-07-09T12:00:00Z', null]], '2026-07-09T15:00:00Z');
    expect(r.state).toBe(st);                                    // NOT cleared to ok — suppressing origin evidence is gone
    expect(r.is_suppressed).toBe(true);
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-09T15:00:00.000Z'); // fail-safe clock
  });

  // soft_bounced is NOT suppressed, so it is NOT in the preserve set — it recomputes freely. This is what lets a
  // retained NEWER hard bounce correctly UPGRADE an arrival-order-wrong old soft_bounced row (audit P2).
  it('old soft_bounced + a retained NEWER hard bounce ⇒ recomputed to hard_bounced/suppressed (not preserved as soft)', async () => {
    const r = await legacyThenMigrate('p-soft-up@x.com', 'soft_bounced', [['bounced', '2026-07-09T12:00:00Z', 'hard']]);
    expect(r).toMatchObject({ state: 'hard_bounced', is_suppressed: true });
    expect(new Date(r.state_changed_at!).toISOString()).toBe('2026-07-09T12:00:00.000Z');
  });

  it('old soft_bounced with only a surviving later `delivered` recomputes to ok (soft is transient, safe to clear)', async () => {
    const r = await legacyThenMigrate('p-soft-clr@x.com', 'soft_bounced', [['delivered', '2026-07-09T12:00:00Z', null]]);
    expect(r).toMatchObject({ state: 'ok', is_suppressed: false });
  });

  it('PARTIAL history WITH the origin retained + later clear IS trusted (origin bounce + newer delivered ⇒ ok)', async () => {
    // contrast: when the matching origin IS present, a later delivered is trusted to clear it
    const r = await legacyThenMigrate('p-clr@x.com', 'hard_bounced', [['bounced', '2026-07-09T11:00:00Z', 'hard'], ['delivered', '2026-07-09T12:00:00Z', null]]);
    expect(r).toMatchObject({ state: 'ok', is_suppressed: false });
  });

  // Round-8 finding 2 [P2]: the replay must also persist last_event_type/at/reason (the newest winning transition).
  it('backfill persists recomputed last_event_* (not the stale pre-migration metadata)', async () => {
    const r = await legacyThenMigrate('le@x.com', 'ok', [['delivered', '2026-07-09T10:00:00Z', null], ['bounced', '2026-07-09T12:00:00Z', 'hard']]);
    expect(r.state).toBe('hard_bounced');
    expect(r.last_event_type).toBe('bounced');                   // the newest WINNING event
    expect(new Date(r.last_event_at!).toISOString()).toBe('2026-07-09T12:00:00.000Z');
  });
  // (operator_reset cannot appear in PRE-migration history — it wasn't an accepted event_type until this migration —
  //  so the replay's defensive operator_reset branch is not reachable on the upgrade path and is not unit-seeded here.)
});

// Round-8 finding 3 [P2]: a TOTAL deterministic ordering for equal-instant events — the "latest event" is the
// same regardless of arrival order, for every ranked pair.
describe('round-8: equal-instant last_event is a total deterministic order (both arrival orders)', () => {
  const T = '2026-07-10T10:00:00Z';
  const suppEvents = new Set(['suppressed', 'suppression_removed']);
  const send = (email: string, et: string) =>
    et === 'bounced'
      ? rec('bounced', { email, bounce: 'hard', at: T })
      : rec(et, { email, at: T });
  // higher email_event_rank must win: complained > suppressed > bounced > suppression_removed > delivered
  it.each([
    ['complained', 'suppressed', 'complained'],
    ['complained', 'delivered', 'complained'],
    ['suppressed', 'delivered', 'suppressed'],
    ['bounced', 'delivered', 'bounced'],
    ['suppressed', 'bounced', 'suppressed'],
    ['bounced', 'suppression_removed', 'bounced'],
  ] as const)('equal time %s vs %s ⇒ last_event=%s regardless of order', async (a, b, winner) => {
    for (const [order, e1, e2] of [['ab', a, b], ['ba', b, a]] as const) {
      const email = `tot-${a}-${b}-${order}@x.com`;
      await send(email, e1);
      await send(email, e2);
      const let_ = (await db.query<{ t: string }>(`SELECT last_event_type t FROM email_address_state WHERE email=$1`, [email])).rows[0].t;
      expect(let_).toBe(winner);
      // sanity: whichever axis the winner is on, the address ends suppressed for every one of these pairs
      if (suppEvents.has(winner) || ['complained', 'bounced'].includes(winner)) expect(await suppressed(email)).toBe(true);
    }
  });
});

// Round-8 finding 4 [P2]: operator_reset is not a provider callback — record_email_event must reject it.
describe('round-8: record_email_event rejects operator_reset (use reset_email_suppression)', () => {
  it('a generic operator_reset callback is refused loudly and performs no partial reset', async () => {
    await rec('suppressed', { email: 'orj@x.com', at: '2026-07-10T09:00:00Z' });
    await expect(rec('operator_reset', { email: 'orj@x.com', at: '2026-07-10T11:00:00Z' })).rejects.toThrow(/not a provider callback/);
    expect(await suppressed('orj@x.com')).toBe(true);           // suppression axis untouched (no partial reset)
    // the full path DOES clear both axes
    await db.query(`SELECT reset_email_suppression($1)`, ['orj@x.com']);
    expect(await suppressed('orj@x.com')).toBe(false);
  });
});

// Round-8 finding 3 [P2]: last_event_* is the newest WINNING transition across BOTH axes; it must never regress when
// an older event wins its own axis. Plus operator reset clears provider_suppression_event_id.
describe('round-8: cross-axis last_event monotonicity + reset clears suppression id', () => {
  const meta = async (email: string) =>
    (await db.query<{ last_event_type: string; last_event_at: string; is_suppressed: boolean }>(
      `SELECT last_event_type, last_event_at, is_suppressed FROM email_address_state WHERE email=$1`, [email])).rows[0];

  it('a suppression at 12:00 is NOT overwritten by an older delivery at 11:00 winning the state axis', async () => {
    await rec('suppressed', { email: 'x1@x.com', at: '2026-07-08T12:00:00Z' });
    await rec('delivered', { email: 'x1@x.com', at: '2026-07-08T11:00:00Z' }); // older; wins the (empty) state axis
    const m = await meta('x1@x.com');
    expect(m.last_event_type).toBe('suppressed');                     // did NOT regress to delivered@11:00
    expect(new Date(m.last_event_at).toISOString()).toBe('2026-07-08T12:00:00.000Z');
    expect(m.is_suppressed).toBe(true);                               // still provider-suppressed
  });

  it('a state bounce at 12:00 is NOT overwritten by an older suppression_removed at 11:00', async () => {
    await rec('bounced', { email: 'x2@x.com', bounce: 'hard', at: '2026-07-08T12:00:00Z' });
    await rec('suppression_removed', { email: 'x2@x.com', at: '2026-07-08T11:00:00Z' }); // older
    const m = await meta('x2@x.com');
    expect(m.last_event_type).toBe('bounced');
    expect(new Date(m.last_event_at).toISOString()).toBe('2026-07-08T12:00:00.000Z');
  });

  it('a genuinely NEWER cross-axis event DOES advance last_event (suppression@11 then bounce@12)', async () => {
    await rec('suppressed', { email: 'x3@x.com', at: '2026-07-08T11:00:00Z' });
    await rec('bounced', { email: 'x3@x.com', bounce: 'hard', at: '2026-07-08T12:00:00Z' });
    expect((await meta('x3@x.com')).last_event_type).toBe('bounced'); // newer state event advances it
  });

  it('operator reset clears provider_suppression_event_id (no stale Svix id beside the reset)', async () => {
    await rec('suppressed', { email: 'x4@x.com', eid: 'svix-supp-1', at: '2026-07-08T10:00:00Z' });
    expect((await db.query<{ id: string | null }>(`SELECT provider_suppression_event_id id FROM email_address_state WHERE email='x4@x.com'`)).rows[0].id).toBe('svix-supp-1');
    await db.query(`SELECT reset_email_suppression($1)`, ['x4@x.com']);
    expect((await db.query<{ id: string | null }>(`SELECT provider_suppression_event_id id FROM email_address_state WHERE email='x4@x.com'`)).rows[0].id).toBeNull();
  });
});
