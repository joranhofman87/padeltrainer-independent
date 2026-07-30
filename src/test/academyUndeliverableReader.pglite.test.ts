// @vitest-environment node
// 10c-a3 PR-1 — get_academy_undeliverable_recipients returns a TRUTHFUL status: hard_bounced/complained for a bounce,
// and 'provider_suppressed' for a provider-only suppression (state='ok' on Resend's list) — never a bare 'ok' the
// client would miscast to EmailBounceState (migration 20261006120000).
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');
let db: PGlite;
const ACADEMY = '00000000-0000-0000-0000-0000000000a1';

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-0000000000f1'::uuid $$;
    CREATE FUNCTION public.is_academy_manager(u uuid, a uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE public.academy_player_metadata (academy_profile_id uuid, profile_id uuid, guest_player_id uuid, removed_at timestamptz, billing_email text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, email text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text, email text, linked_profile_id uuid);
    CREATE TABLE public.email_address_state (email text, state text, last_event_at timestamptz,
      provider_suppressed_active boolean NOT NULL DEFAULT false,
      is_suppressed boolean GENERATED ALWAYS AS ((state IN ('hard_bounced','complained')) OR provider_suppressed_active) STORED);
  `);
  // load the reader migration (late-binding: get_players_overview coexists without its deps)
  await db.exec(MIG('20261006120000_readers_canonical_is_suppressed.sql'));
});

const rows = async () =>
  (await db.query<{ player_key: string; email: string; state: string }>(
    `SELECT player_key, email, state FROM get_academy_undeliverable_recipients($1) ORDER BY email`, [ACADEMY])).rows;

describe('get_academy_undeliverable_recipients — truthful suppression status', () => {
  it('reports hard_bounced/complained for bounces AND provider_suppressed for a provider-only suppression', async () => {
    const P_HARD = '00000000-0000-0000-0000-000000000101';
    const P_COMP = '00000000-0000-0000-0000-000000000102';
    const G_PROV = '00000000-0000-0000-0000-000000000201';
    const P_OK = '00000000-0000-0000-0000-000000000103';
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES
        ('${P_HARD}','Hard Bounce','hard@x.com'), ('${P_COMP}','Complainer','comp@x.com'), ('${P_OK}','Fine','ok@x.com');
      INSERT INTO public.guest_players (id, full_name, email) VALUES ('${G_PROV}','Guest Prov','prov@x.com');
      INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id) VALUES
        ('${ACADEMY}','${P_HARD}'), ('${ACADEMY}','${P_COMP}'), ('${ACADEMY}','${P_OK}');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${ACADEMY}','${G_PROV}');
      INSERT INTO public.email_address_state (email, state, provider_suppressed_active) VALUES
        ('hard@x.com','hard_bounced', false),
        ('comp@x.com','complained', false),
        ('prov@x.com','ok', true),          -- provider-suppressed, never bounced
        ('ok@x.com','ok', false);           -- deliverable → excluded
    `);
    const r = await rows();
    // ok@x.com excluded (not suppressed); the three suppressed rows present with truthful statuses
    expect(r.map((x) => [x.email, x.state])).toEqual([
      ['comp@x.com', 'complained'],
      ['hard@x.com', 'hard_bounced'],
      ['prov@x.com', 'provider_suppressed'],   // NOT 'ok'
    ]);
  });

  it('uses the EFFECTIVE billing_email override (round-10 P2), registered: suppressed login + clean override ⇒ excluded', async () => {
    const P = '00000000-0000-0000-0000-000000000401';
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${P}','Overridden','login-bounced@x.com');
      INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, billing_email) VALUES ('${ACADEMY}','${P}','clean-override@x.com');
      INSERT INTO public.email_address_state (email, state) VALUES ('login-bounced@x.com','hard_bounced');  -- login email bounced
      -- clean-override@x.com is deliverable (no row) → the effective address is fine → excluded
    `);
    expect(await rows()).toHaveLength(0);
  });

  it('registered: clean login + SUPPRESSED override ⇒ included, returning the OVERRIDE address', async () => {
    const P = '00000000-0000-0000-0000-000000000402';
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${P}','O2','fine-login@x.com');
      INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, billing_email) VALUES ('${ACADEMY}','${P}','override-bounced@x.com');
      INSERT INTO public.email_address_state (email, state) VALUES ('override-bounced@x.com','hard_bounced');
    `);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].email).toBe('override-bounced@x.com');   // the effective (override) address, not the clean login
    expect(r[0].state).toBe('hard_bounced');
  });

  it('guest: billing_email override precedes linked-profile + guest email', async () => {
    const G = '00000000-0000-0000-0000-000000000403';
    const LP = '00000000-0000-0000-0000-000000000404';
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${LP}','Linked','linked-fine@x.com');
      INSERT INTO public.guest_players (id, full_name, email, linked_profile_id) VALUES ('${G}','Guest','guest-fine@x.com','${LP}');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, billing_email) VALUES ('${ACADEMY}','${G}','guest-override-bounced@x.com');
      INSERT INTO public.email_address_state (email, state) VALUES ('guest-override-bounced@x.com','complained');
    `);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].email).toBe('guest-override-bounced@x.com');   // override wins over linked-profile + guest email
    expect(r[0].state).toBe('complained');
  });

  it('never returns a bare ok: a provider-only suppression is always labelled provider_suppressed', async () => {
    const G = '00000000-0000-0000-0000-000000000301';
    await db.exec(`
      INSERT INTO public.guest_players (id, full_name, email) VALUES ('${G}','G','only-prov@x.com');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${ACADEMY}','${G}');
      INSERT INTO public.email_address_state (email, state, provider_suppressed_active) VALUES ('only-prov@x.com','ok', true);
    `);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].state).toBe('provider_suppressed');
    expect(r[0].state).not.toBe('ok');
  });
});
