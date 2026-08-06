// @vitest-environment node
/**
 * OD-1 — a trainer owns their own login.
 *
 * The owner's decision, verbatim: an academy manager may manage membership, academy role and
 * permissions, but must NEVER directly change a trainer's global login identity — "even when one
 * manager currently manages every academy to which the trainer belongs". The trainer changes it
 * through self-service; an academy may INITIATE an invitation or reset; a platform-administrator
 * recovery path may exist but must be audited.
 *
 * The endpoint refuses. These prove the rule also holds at the mutation boundary, which is what
 * makes it survive the next endpoint that forgets — including the two-academy shared-trainer case
 * and the single-academy case the old exclusivity carve-out used to permit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

const TRAINER = '11111111-1111-4111-8111-111111111111';
const MANAGER_A = '22222222-2222-4222-8222-222222222222';
const MANAGER_B = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';

const asUser = async (uid: string | null) =>
  db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      email text,
      full_name text,
      phone text
    );
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role text) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role) $fn$;
  `);
  await db.exec(MIG('20261109100000_identity_is_self_service.sql'));
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [ADMIN]);
}, 60_000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await asUser(null);
  await db.query(`DELETE FROM public.profiles`);
  await db.query(
    `INSERT INTO public.profiles (user_id, email, full_name) VALUES ($1, 'trainer@example.com', 'Coach T')`,
    [TRAINER]);
});

const changeEmail = (to = 'stolen@example.com') =>
  db.query(`UPDATE public.profiles SET email = $1 WHERE user_id = $2`, [to, TRAINER]);
const emailNow = async () =>
  (await db.query<{ email: string }>(`SELECT email FROM public.profiles WHERE user_id=$1`, [TRAINER])).rows[0].email;

describe('a tenant manager may never change a trainer\'s login', () => {
  it('a manager of ONE of the trainer\'s academies is refused', async () => {
    await asUser(MANAGER_A);
    await expect(changeEmail()).rejects.toThrow(/belongs to its owner/);
    expect(await emailNow()).toBe('trainer@example.com');
  });

  it('a manager of EVERY academy the trainer belongs to is refused too', async () => {
    // the case the old exclusivity carve-out permitted, and the one the owner named explicitly:
    // "even when one manager currently manages every academy to which the trainer belongs".
    await asUser(MANAGER_B);
    await expect(changeEmail()).rejects.toThrow(/belongs to its owner/);
    expect(await emailNow()).toBe('trainer@example.com');
  });

  it('the refusal names the alternative, so a manager knows what they CAN do', async () => {
    await asUser(MANAGER_A);
    await expect(changeEmail()).rejects.toThrow(/invitation or a password-reset link/);
  });
});

describe('the paths that ARE allowed', () => {
  it('the trainer changes their own email', async () => {
    await asUser(TRAINER);
    await changeEmail('mynew@example.com');
    expect(await emailNow()).toBe('mynew@example.com');
  });

  it('a platform administrator may, through the audited recovery path', async () => {
    await asUser(ADMIN);
    await changeEmail('recovered@example.com');
    expect(await emailNow()).toBe('recovered@example.com');
  });

  it('the signup / auth machinery (service role, no end-user JWT) is not blocked', async () => {
    await asUser(null);
    await changeEmail('signup@example.com');
    expect(await emailNow()).toBe('signup@example.com');
  });
});

describe('the guard is about CREDENTIALS, not about every profile field', () => {
  it('a manager writing a non-credential field is not blocked by this trigger', async () => {
    // the endpoint refuses these under OD-1; the DATABASE guard is deliberately narrower, because
    // blocking name/phone here would break the player-management surfaces that legitimately
    // maintain them. Pinned so the narrowing is a decision rather than an oversight.
    await asUser(MANAGER_A);
    await db.query(`UPDATE public.profiles SET full_name='Renamed' WHERE user_id=$1`, [TRAINER]);
    expect((await db.query<{ full_name: string }>(
      `SELECT full_name FROM public.profiles WHERE user_id=$1`, [TRAINER])).rows[0].full_name).toBe('Renamed');
  });

  it('a no-op email write is not a change and is not refused', async () => {
    await asUser(MANAGER_A);
    await db.query(`UPDATE public.profiles SET email='trainer@example.com' WHERE user_id=$1`, [TRAINER]);
    expect(await emailNow()).toBe('trainer@example.com');
  });
});
