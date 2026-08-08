// @vitest-environment node
/**
 * U1c prerequisite 2 — `account_membership_preflight`, the probe the deletion edge functions call.
 *
 * It exists because `academy_player_memberships` is default-deny down to and including `service_role`
 * (U1a), so the edge functions cannot read it through PostgREST at all. Rather than open that
 * lockdown for a yes/no question, a SECURITY DEFINER probe answers it and is granted to `service_role`
 * alone — which is itself asserted below, because a probe that leaked to `authenticated` would hand
 * every client a way to enumerate person ids.
 *
 * The two resolution paths both matter, and the second is the dangerous one: `deleteUserData` deletes
 * a trainer's guest players roughly two-thirds of the way through its sequence, long after ~40 other
 * deletes have committed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const U1A = 'supabase/migrations/20261113100000_u1a_academy_player_memberships.sql';
const PREFLIGHT = 'supabase/migrations/20261116100000_u1c_prereq_deletion_preflight.sql';

const USER = '99999999-9999-4999-8999-999999999999';
const OTHER_USER = '88888888-8888-4888-8888-888888888888';
const ACADEMY = '11111111-1111-4111-8111-111111111111';
const PROFILE = 'bbbb0001-0000-4000-8000-000000000000';
const TRAINER = 'dddd0001-0000-4000-8000-000000000000';
const GUEST = 'cccc0001-0000-4000-8000-000000000000';
const P_PROFILE = 'aaaa0001-0000-4000-8000-000000000000';
const P_GUEST = 'aaaa0002-0000-4000-8000-000000000000';
const P_UNRELATED = 'aaaa0003-0000-4000-8000-000000000000';

let db: PGlite;

/**
 * Invoke the probe AS service_role — the role the edge functions actually run as.
 *
 * Running it on the migration-owning connection would prove nothing about SECURITY DEFINER: that
 * connection owns the protected table and can read it anyway, so a mutant dropping SECURITY DEFINER
 * would sail through. Under service_role the definer escalation is the ONLY thing that makes the read
 * possible, which is the property worth testing.
 */
const preflight = async (userId: string) => {
  await db.exec('SET ROLE service_role;');
  try {
    const { rows } = await db.query<{ r: { has_memberships: boolean; membership_count: number; person_ids: string[] } }>(
      'SELECT public.account_membership_preflight($1) AS r', [userId]);
    return rows[0].r;
  } finally {
    await db.exec('RESET ROLE;');
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  `);
  await db.exec(readFileSync(U1A, 'utf8'));
  await db.exec(readFileSync(PREFLIGHT, 'utf8'));

  await db.exec(`
    INSERT INTO public.academy_profiles VALUES ('${ACADEMY}');
    INSERT INTO public.persons (id) VALUES ('${P_PROFILE}'), ('${P_GUEST}'), ('${P_UNRELATED}');
    INSERT INTO public.profiles (id, user_id) VALUES ('${PROFILE}', '${USER}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER}', '${USER}');
    INSERT INTO public.guest_players (id, trainer_id) VALUES ('${GUEST}', '${TRAINER}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P_PROFILE}', '${PROFILE}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_GUEST}', '${GUEST}');
  `);
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => { await db.exec('DELETE FROM public.academy_player_memberships;'); });

const addMembership = (person: string) => db.query(
  `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1, $2)`,
  [ACADEMY, person]);

describe('account_membership_preflight — what it resolves', () => {
  it('reports clear when the account owns no memberships', async () => {
    const r = await preflight(USER);
    expect(r.has_memberships).toBe(false);
    expect(r.membership_count).toBe(0);
    // it still resolved both persons — the answer is "none held memberships", not "found nobody"
    expect([...r.person_ids].sort()).toEqual([P_PROFILE, P_GUEST].sort());
  });

  it('catches a membership held by the account PROFILE person', async () => {
    await addMembership(P_PROFILE);
    const r = await preflight(USER);
    expect(r.has_memberships).toBe(true);
    expect(r.membership_count).toBe(1);
  });

  it('catches a membership held by a TRAINER-OWNED GUEST person', async () => {
    // The dangerous path: these guests are deleted mid-sequence, after ~40 committed deletes.
    await addMembership(P_GUEST);
    const r = await preflight(USER);
    expect(r.has_memberships).toBe(true);
    expect(r.membership_count).toBe(1);
  });

  it('counts both paths together', async () => {
    await addMembership(P_PROFILE);
    await addMembership(P_GUEST);
    expect(await preflight(USER)).toMatchObject({ has_memberships: true, membership_count: 2 });
  });

  it('ignores a membership belonging to somebody else', async () => {
    await addMembership(P_UNRELATED);
    expect(await preflight(USER)).toMatchObject({ has_memberships: false, membership_count: 0 });
  });

  it('reports clear for a user with no profile and no trainer profile', async () => {
    const r = await preflight(OTHER_USER);
    expect(r.has_memberships).toBe(false);
    expect(r.person_ids).toEqual([]);
  });

  it('refuses a null user rather than answering for nobody', async () => {
    await expect(db.query('SELECT public.account_membership_preflight(NULL)')).rejects.toThrow(/required/i);
  });
});

describe('account_membership_preflight — it must not become a client-callable enumerator', () => {
  it('is executable by service_role and NOBODY else', async () => {
    for (const [role, expected] of [['service_role', true], ['authenticated', false], ['anon', false]] as const) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, 'public.account_membership_preflight(uuid)', 'EXECUTE') AS ok`,
        [role]);
      expect(`${role}=${rows[0].ok}`).toBe(`${role}=${expected}`);
    }
  });

  it('reads the membership table that service_role itself cannot read', async () => {
    // The premise of the whole design: the probe is needed BECAUSE the direct read is denied.
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('service_role', 'public.academy_player_memberships', 'SELECT') AS ok`);
    expect(rows[0].ok).toBe(false);
  });

  it('the definer escalation is what makes the probe work — the direct read really fails', async () => {
    await db.exec('SET ROLE service_role;');
    try {
      // same role, same session: the probe succeeds, the direct read does not.
      await expect(db.query('SELECT public.account_membership_preflight($1)', [USER])).resolves.toBeTruthy();
      await expect(db.query('SELECT count(*) FROM public.academy_player_memberships')).rejects.toThrow();
    } finally {
      await db.exec('RESET ROLE;');
    }
  });
});

/**
 * P1 PREMISE, pinned executably.
 *
 * A preflight over ~60 independently-committed calls is inherently TOCTOU: a membership created after
 * the probe but before a later delete would still hit the RESTRICT FK. That window is unreachable
 * TODAY only because nothing can write a membership — the table is empty and revoked from every
 * application role. This slice's safety rests on that premise, so the premise is asserted rather than
 * assumed: the day a writer is granted, this test fails and whoever granted it has to confront the
 * TOCTOU question (atomic DB-side veto, transactional deletion, or shipping retain-and-scrub) instead
 * of inheriting a guard that quietly stopped being sufficient.
 */
describe('the preflight is only sufficient while memberships have no application writer', () => {
  it('no application role can write academy_player_memberships', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await db.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, 'public.academy_player_memberships', $2) AS ok`, [role, priv]);
        expect(`${role}:${priv}=${rows[0].ok}`).toBe(`${role}:${priv}=false`);
      }
    }
  });
});
