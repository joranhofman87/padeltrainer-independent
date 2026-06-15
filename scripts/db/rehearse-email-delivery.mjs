// Rehearsal for email delivery-failure tracking — Phase 1 foundation.
// Proves record_email_event idempotency + the address-state machine + the
// suppression check + the service_role-only lockdown, on PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const val = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const rec = (o) => db.query(
  `SELECT public.record_email_event(${Object.entries(o).map(([k, v]) => `${k} => ${val(v)}`).join(', ')});`);
const stateOf = async (email) => {
  const r = await db.query(`SELECT state FROM public.email_address_state WHERE email = ${val(email)};`);
  return r.rows[0]?.state ?? null;
};
const evCount = async (email) => {
  const r = await db.query(`SELECT count(*)::int AS c FROM public.email_delivery_events WHERE recipient_email = ${val(email)};`);
  return Number(r.rows[0].c);
};
const suppressed = async (email) => {
  const r = await db.query(`SELECT public.is_email_suppressed(${val(email)}) AS s;`);
  return r.rows[0].s;
};
// run sql under a role inside a scoped txn; return true if it SUCCEEDS
const allowedAs = async (role, sql) => {
  try { await db.exec(`BEGIN; SET LOCAL ROLE ${role}; ${sql}; ROLLBACK;`); return true; }
  catch { try { await db.exec('ROLLBACK;'); } catch { /* ignore */ } return false; }
};

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_profile_id uuid, trainer_id uuid, player_id uuid, guest_player_id uuid);
`);
await db.exec(readFileSync('supabase/migrations/20260615110000_email_delivery_tables.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615110010_record_email_event.sql', 'utf8'));

// ---- normalization + initialize ----
await rec({ p_event_type: 'sent', p_recipient_email: '  New@Test.com ' });
ok(await stateOf('new@test.com') === 'ok', 'sent initializes a new address to ok (lowercased + trimmed)');
ok(await evCount('new@test.com') === 1, 'sent logs exactly one event');

// ---- idempotent webhook (duplicate resend_event_id) ----
await rec({ p_event_type: 'bounced', p_recipient_email: 'dup@test.com', p_resend_event_id: 'evt_1', p_bounce_type: 'hard' });
await rec({ p_event_type: 'bounced', p_recipient_email: 'dup@test.com', p_resend_event_id: 'evt_1', p_bounce_type: 'hard' });
ok(await evCount('dup@test.com') === 1, 'duplicate resend_event_id is a no-op (one event only)');
ok(await stateOf('dup@test.com') === 'hard_bounced', 'hard bounce -> hard_bounced');

// ---- severity: soft never downgrades hard ----
await rec({ p_event_type: 'bounced', p_recipient_email: 'dup@test.com', p_resend_event_id: 'evt_1b', p_bounce_type: 'soft' });
ok(await stateOf('dup@test.com') === 'hard_bounced', 'soft bounce does NOT downgrade an existing hard bounce');

// ---- sent does not reset a hard bounce ----
await rec({ p_event_type: 'sent', p_recipient_email: 'dup@test.com' });
ok(await stateOf('dup@test.com') === 'hard_bounced', 'sent does NOT reset a hard bounce (acceptance != delivery)');

// ---- complaint is sticky; delivered does not clear it ----
await rec({ p_event_type: 'complained', p_recipient_email: 'c@test.com', p_resend_event_id: 'evt_c' });
ok(await stateOf('c@test.com') === 'complained', 'complaint -> complained');
await rec({ p_event_type: 'delivered', p_recipient_email: 'c@test.com', p_resend_event_id: 'evt_c2' });
ok(await stateOf('c@test.com') === 'complained', 'delivered does NOT clear a complaint');

// ---- soft bounce clears on real delivery ----
await rec({ p_event_type: 'bounced', p_recipient_email: 's@test.com', p_resend_event_id: 'evt_s', p_bounce_type: 'soft' });
ok(await stateOf('s@test.com') === 'soft_bounced', 'soft bounce -> soft_bounced');
await rec({ p_event_type: 'delivered', p_recipient_email: 's@test.com', p_resend_event_id: 'evt_s2' });
ok(await stateOf('s@test.com') === 'ok', 'delivered clears a soft bounce');

// ---- synchronous send_failed: logged, not suppressed ----
await rec({ p_event_type: 'send_failed', p_recipient_email: 'f@test.com', p_reason: 'invalid recipient' });
ok(await stateOf('f@test.com') === 'ok', 'send_failed on a fresh address does NOT suppress (state ok)');
ok(await evCount('f@test.com') === 1, 'send_failed is logged for invoice-level visibility');
// two synchronous failures (no event id) both log — no dedup
await rec({ p_event_type: 'send_failed', p_recipient_email: 'f@test.com', p_reason: 'again' });
ok(await evCount('f@test.com') === 2, 'synchronous rows (no resend_event_id) are never deduped');

// ---- is_email_suppressed (+ normalization) ----
ok(await suppressed('DUP@test.com') === true, 'is_email_suppressed true for hard_bounced (case-insensitive)');
ok(await suppressed('c@test.com') === true, 'is_email_suppressed true for complained');
ok(await suppressed('s@test.com') === false, 'is_email_suppressed false for ok');
ok(await suppressed('never@seen.com') === false, 'is_email_suppressed false for unknown address');

// ---- service_role lockdown ----
ok(!(await allowedAs('authenticated', 'SELECT * FROM public.email_address_state')), 'authenticated CANNOT read email_address_state');
ok(!(await allowedAs('authenticated', 'SELECT * FROM public.email_delivery_events')), 'authenticated CANNOT read email_delivery_events');
ok(!(await allowedAs('authenticated', "SELECT public.record_email_event('sent','x@test.com')")), 'authenticated CANNOT execute record_email_event');
ok(!(await allowedAs('anon', 'SELECT * FROM public.email_address_state')), 'anon CANNOT read email_address_state');
ok(await allowedAs('service_role', 'SELECT * FROM public.email_address_state'), 'service_role CAN read email_address_state');
ok(await allowedAs('service_role', "SELECT public.record_email_event('delivered','svc@test.com')"), 'service_role CAN execute record_email_event');

// ============ Phase 3: invoice delivery status + recipients (migration 4) ============
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text, email text, linked_profile_id uuid);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
  CREATE TABLE public.academy_player_metadata (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_profile_id uuid, trainer_profile_id uuid,
    profile_id uuid, guest_player_id uuid, removed_at timestamptz);
  CREATE FUNCTION public.is_academy_manager(_uid uuid, _aid uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE user_id = _uid AND academy_profile_id = _aid) $$;
  CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`);
await db.exec(readFileSync('supabase/migrations/20260615110030_invoice_delivery_status_rpcs.sql', 'utf8'));

const AC = '20000000-0000-0000-0000-000000000001';
const UM = '20000000-0000-0000-0000-0000000000m1'.replace('m', 'a');
const P1 = '21000000-0000-0000-0000-000000000001';
const P2 = '21000000-0000-0000-0000-000000000002';
const LP = '21000000-0000-0000-0000-000000000009';
const G1 = '22000000-0000-0000-0000-000000000001';
const INV1 = '23000000-0000-0000-0000-000000000001';
await db.exec(`
  INSERT INTO public.academy_managers VALUES ('${UM}', '${AC}');
  INSERT INTO public.profiles (id, user_id, full_name, email) VALUES
    ('${P1}', '${P1}', 'Bad Registered', 'bad@reg.com'),
    ('${P2}', '${P2}', 'Good Player', 'good@ok.com'),
    ('${LP}', '${LP}', 'Parent Account', 'parent@bad.com');
  INSERT INTO public.guest_players (id, full_name, email, linked_profile_id) VALUES
    ('${G1}', 'Child Guest', NULL, '${LP}');
  INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id) VALUES ('${AC}', '${P1}'), ('${AC}', '${P2}');
  INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${AC}', '${G1}');
  INSERT INTO public.invoices (id, academy_profile_id, player_id) VALUES ('${INV1}', '${AC}', '${P1}');
`);

// make two addresses undeliverable; leave good@ok.com ok
await rec({ p_event_type: 'bounced', p_recipient_email: 'bad@reg.com', p_resend_event_id: 'evx1', p_bounce_type: 'hard' });
await rec({ p_event_type: 'complained', p_recipient_email: 'parent@bad.com', p_resend_event_id: 'evx2' });
await rec({ p_event_type: 'sent', p_recipient_email: 'good@ok.com', p_resend_email_id: 'mid_ok' });

// invoice INV1: sent then bounced (same message id)
await rec({ p_event_type: 'sent', p_recipient_email: 'bad@reg.com', p_resend_email_id: 'mid_inv1', p_invoice_id: INV1 });
await rec({ p_event_type: 'bounced', p_recipient_email: 'bad@reg.com', p_resend_event_id: 'evx3', p_bounce_type: 'hard', p_resend_email_id: 'mid_inv1', p_invoice_id: INV1 });
const invStatus = async (id) => (await db.query(`SELECT public.get_invoice_delivery_status('${id}') AS s;`)).rows[0].s;
ok(await invStatus(INV1) === 'bounced', 'invoice delivery status = bounced (sent then bounced)');

await db.exec(`SELECT set_config('rehearse.uid', '${UM}', false);`);
const recips = (await db.query(`SELECT * FROM public.get_academy_undeliverable_recipients('${AC}');`)).rows;
ok(recips.length === 2, 'recipients = the 2 undeliverable players (registered + linked guest)', recips.map(r => r.email));
ok(recips.some(r => r.email === 'bad@reg.com' && r.player_type === 'registered'), 'registered bad email present');
ok(recips.some(r => r.email === 'parent@bad.com' && r.player_type === 'guest'), 'guest resolves to the linked parent bad email');
ok(!recips.some(r => r.email === 'good@ok.com'), 'the ok player is excluded');

const batch = (await db.query(`SELECT * FROM public.get_invoices_delivery_status(ARRAY['${INV1}']::uuid[]);`)).rows;
ok(batch.length === 1 && batch[0].delivery_status === 'bounced', 'batch status returns bounced for a managed invoice');

await db.exec(`SELECT set_config('rehearse.uid', '${P1}', false);`); // P1 is not a manager
let denied = false;
try { await db.query(`SELECT * FROM public.get_academy_undeliverable_recipients('${AC}');`); } catch { denied = true; }
ok(denied, 'non-manager is denied the recipients list (42501)');
const batchUnauth = (await db.query(`SELECT * FROM public.get_invoices_delivery_status(ARRAY['${INV1}']::uuid[]);`)).rows;
ok(batchUnauth.length === 0, 'batch status returns nothing for an invoice the caller does not manage');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
