// @vitest-environment node
// 10c-b B — the canonical open_slots_player catalog row + the IMMUTABLE v1 digest-item schema,
// verified on a REAL Postgres server (embedded-postgres; no Docker, no stubs for the SQL under test).
//
// Proves, against the real functions:
//   * the catalog row carries EXACTLY the accepted contract, and digest_engine_enabled stays FALSE
//   * the kill-switch CHECK (digest_engine_enabled ⇒ supports_digest) is real, not decorative
//   * deterministic nl/en rendering for BOTH subtypes, byte-identical across repeated calls
//   * unsafe content (email, phone, token, absolute URL, angle brackets) is REFUSED, not sanitized
//   * ISO date fields are NOT mistaken for phone numbers (the bug this schema was written around)
//   * url accepts only app-relative paths
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54363;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openslots-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  await c.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
  // The catalog table exactly as the foundation ships it, plus the 10c-a kill switch.
  await c.query(`
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL CHECK (category IN ('booking','payment','invoice','reminder','rebook','security','marketing','account')),
      audience text NOT NULL CHECK (audience IN ('player','trainer','academy_manager','club_manager','admin','guest')),
      priority text NOT NULL CHECK (priority IN ('critical','transactional','actionable','engagement','marketing')),
      required_delivery boolean NOT NULL DEFAULT false,
      supports_email boolean NOT NULL DEFAULT true,
      supports_whatsapp boolean NOT NULL DEFAULT false,
      supports_push boolean NOT NULL DEFAULT false,
      supports_digest boolean NOT NULL DEFAULT false,
      default_email_frequency text NOT NULL DEFAULT 'instant' CHECK (default_email_frequency IN ('instant','daily','weekly','off')),
      default_whatsapp_frequency text NOT NULL DEFAULT 'off' CHECK (default_whatsapp_frequency IN ('instant','daily','weekly','off')),
      default_push_frequency text NOT NULL DEFAULT 'off' CHECK (default_push_frequency IN ('instant','daily','weekly','off')),
      collapse_window_minutes int NOT NULL DEFAULT 0,
      max_per_user_per_hour int, max_per_user_per_day int,
      quiet_hours_respect boolean NOT NULL DEFAULT false,
      template_email text, template_whatsapp text,
      visibility_scope text NOT NULL DEFAULT 'private_user_only' CHECK (visibility_scope IN
        ('private_user_only','tenant_visible','tenant_visible_limited','admin_only')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      digest_engine_enabled boolean NOT NULL DEFAULT false,
      CONSTRAINT chk_event_types_digest_engine_implies_supports CHECK (NOT digest_engine_enabled OR supports_digest)
    );`);
  await c.query(MIG('20261008100000_open_slots_player_event.sql'));
}, 180_000);

afterAll(async () => {
  try { await c?.end(); } catch { /* ignore */ }
  try { await epg?.stop(); } catch { /* ignore */ }
});

const item = async (subtype: string, locale: string | null, data: unknown) => {
  const r = await c.query('SELECT public.notif_digest_item_open_slots_v1($1,$2,$3::jsonb) AS i',
    [subtype, locale, JSON.stringify(data)]);
  return r.rows[0].i as Record<string, unknown>;
};
const rejects = async (subtype: string, locale: string | null, data: unknown) => {
  await expect(item(subtype, locale, data)).rejects.toThrow();
};

describe('10c-b B — open_slots_player catalog row', () => {
  it('carries exactly the accepted contract', async () => {
    const { rows } = await c.query(`SELECT * FROM public.notification_event_types WHERE key='open_slots_player'`);
    expect(rows).toHaveLength(1);
    const e = rows[0];
    expect(e.category).toBe('booking');
    expect(e.audience).toBe('player');
    expect(e.priority).toBe('engagement');
    expect(e.required_delivery).toBe(false);
    expect(e.supports_email).toBe(true);
    expect(e.supports_digest).toBe(true);
    expect(e.supports_whatsapp).toBe(false);
    expect(e.supports_push).toBe(false);
    expect(e.default_email_frequency).toBe('weekly');   // mirrors legacy open_slots_digest
    expect(e.default_whatsapp_frequency).toBe('off');
    expect(e.default_push_frequency).toBe('off');
    expect(e.quiet_hours_respect).toBe(true);
    expect(e.visibility_scope).toBe('private_user_only');
  });

  it('leaves the digest engine DISABLED', async () => {
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.notification_event_types WHERE digest_engine_enabled`);
    expect(rows[0].n).toBe(0);
  });

  it('re-running the migration cannot silently enable the engine', async () => {
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = true WHERE key='open_slots_player'`);
    await c.query(MIG('20261008100000_open_slots_player_event.sql'));
    const { rows } = await c.query(`SELECT digest_engine_enabled FROM public.notification_event_types WHERE key='open_slots_player'`);
    expect(rows[0].digest_engine_enabled).toBe(false);
  });

  it('the kill-switch CHECK is load-bearing: engine-on without supports_digest is rejected', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET supports_digest=false, digest_engine_enabled=true WHERE key='open_slots_player'`
    )).rejects.toThrow(/chk_event_types_digest_engine_implies_supports/);
  });
});

describe('10c-b B — v1 digest item: deterministic rendering', () => {
  const NEW = { trainer_name: 'Sanne de Vries', date_from: '2026-08-10', date_to: '2026-08-16', slot_count: 3 };
  const REO = { trainer_name: 'Sanne de Vries', slot_date: '2026-08-12', slot_time: '19:30' };

  it('new_availability renders EN and NL distinctly, with the frozen envelope', async () => {
    const en = await item('new_availability', 'en', NEW);
    expect(en.v).toBe(1);
    expect(en.event).toBe('open_slots_player');
    expect(en.subtype).toBe('new_availability');
    expect(en.locale).toBe('en');
    expect(en.title).toBe('New availability from Sanne de Vries');
    expect(en.body).toBe('3 new slots between 2026-08-10 and 2026-08-16.');

    const nl = await item('new_availability', 'nl', NEW);
    expect(nl.locale).toBe('nl');
    expect(nl.title).toBe('Nieuwe beschikbaarheid van Sanne de Vries');
    expect(nl.body).toBe('3 nieuwe momenten tussen 2026-08-10 en 2026-08-16.');
  });

  it('slot_reopened renders EN and NL distinctly', async () => {
    const en = await item('slot_reopened', 'en', REO);
    expect(en.subtype).toBe('slot_reopened');
    expect(en.title).toBe('A spot opened up with Sanne de Vries');
    expect(en.body).toBe('A spot opened up on 2026-08-12 at 19:30.');
    const nl = await item('slot_reopened', 'nl', REO);
    expect(nl.title).toBe('Plek vrijgekomen bij Sanne de Vries');
    expect(nl.body).toBe('Er is een plek vrijgekomen op 2026-08-12 om 19:30.');
  });

  it('is byte-deterministic: repeated calls serialize identically (the request hash depends on it)', async () => {
    const a = await c.query(`SELECT public.notif_digest_item_open_slots_v1('new_availability','nl',$1::jsonb)::text AS t`, [JSON.stringify(NEW)]);
    const b = await c.query(`SELECT public.notif_digest_item_open_slots_v1('new_availability','nl',$1::jsonb)::text AS t`, [JSON.stringify(NEW)]);
    expect(a.rows[0].t).toBe(b.rows[0].t);
  });

  it('an unknown locale falls back to EN deterministically (never a third untranslated shape)', async () => {
    for (const loc of ['fr', 'de', '', null]) {
      const out = await item('new_availability', loc, NEW);
      expect(out.locale).toBe('en');
      expect(out.title).toBe('New availability from Sanne de Vries');
    }
  });

  it('degrades gracefully when optional data is absent', async () => {
    const en = await item('new_availability', 'en', { trainer_name: 'Ana' });
    expect(en.body).toBe('New slots are available.');
    expect(en.data).toEqual({ trainer_name: 'Ana' });   // jsonb_strip_nulls drops the absent keys
    expect('url' in en).toBe(false);
  });

  it('rejects an unknown subtype and a missing trainer_name', async () => {
    await rejects('marketing_blast', 'en', NEW);
    await rejects('new_availability', 'en', { date_from: '2026-08-10' });
  });
});

describe('10c-b B — v1 digest item: content safety is fail-closed', () => {
  it('an ISO date is NOT mistaken for a phone number (regression: the 8-digit date trap)', async () => {
    const out = await item('new_availability', 'en',
      { trainer_name: 'Ana', date_from: '2026-08-10', date_to: '2026-08-16', slot_count: 2 });
    expect(out.body).toBe('2 new slots between 2026-08-10 and 2026-08-16.');
  });

  it('refuses an email address in free text', async () => {
    await rejects('new_availability', 'en', { trainer_name: 'Ana <ana@example.com>' });
    await rejects('new_availability', 'en', { trainer_name: 'ana@example.com' });
  });

  it('refuses a phone-like number in free text', async () => {
    await rejects('new_availability', 'en', { trainer_name: 'Ana 06 12 34 56 78' });
    await rejects('new_availability', 'en', { trainer_name: 'Ana +31612345678' });
  });

  it('refuses token/secret shapes', async () => {
    await rejects('new_availability', 'en', { trainer_name: 'eyJhbGciOiJIUzI1NiJ9xxxx' });
    await rejects('new_availability', 'en', { trainer_name: 'Bearer abcdefghijkl' });
    await rejects('new_availability', 'en', { trainer_name: 're_abcdefghijkl' });
  });

  it('refuses URLs, schemes and angle brackets in free text', async () => {
    await rejects('new_availability', 'en', { trainer_name: 'Ana https://evil.example' });
    await rejects('new_availability', 'en', { trainer_name: 'Ana //evil.example' });
    await rejects('new_availability', 'en', { trainer_name: 'javascript:alert(1)' });
    await rejects('new_availability', 'en', { trainer_name: '<script>x</script>' });
  });

  it('accepts an app-relative url and refuses anything else', async () => {
    const ok = await item('new_availability', 'en', { trainer_name: 'Ana', url: '/trainers/ana/slots' });
    expect(ok.url).toBe('/trainers/ana/slots');
    for (const bad of ['https://evil.example/x', '//evil.example', 'trainers/ana', '/a/../../etc', 'javascript:x']) {
      await rejects('new_availability', 'en', { trainer_name: 'Ana', url: bad });
    }
  });

  it('rejects an out-of-range or non-integer slot_count', async () => {
    await rejects('new_availability', 'en', { trainer_name: 'Ana', slot_count: 999999 });
    await rejects('new_availability', 'en', { trainer_name: 'Ana', slot_count: 'many' });
  });

  it('bounds a very long trainer name rather than letting one item dominate the budget', async () => {
    const out = await item('new_availability', 'en', { trainer_name: 'A'.repeat(500) });
    expect(String(out.title).length).toBeLessThanOrEqual(200);
    expect((out.data as Record<string, string>).trainer_name.length).toBe(80);
  });
});
