import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const U = { TR: '10000000-0000-0000-0000-000000000001', PARENT: '10000000-0000-0000-0000-000000000002', OTHER: '10000000-0000-0000-0000-000000000003' };
const P = { PLAYER: '20000000-0000-0000-0000-000000000001', PARENT: '20000000-0000-0000-0000-000000000002' };
const TP = '30000000-0000-0000-0000-000000000001';
const G = { LINKED: '40000000-0000-0000-0000-000000000001', UNLINKED: '40000000-0000-0000-0000-000000000002' };
const INV = { REG: '50000000-0000-0000-0000-000000000001', GUEST: '50000000-0000-0000-0000-000000000002' };

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $f$ LANGUAGE sql STABLE;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
    billing_business_name text, billing_address text, billing_btw_number text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, first_name text, last_name text, full_name text, email text, phone text,
    billing_business_name text, billing_address text, billing_btw_number text, linked_profile_id uuid);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
  CREATE TABLE public.admins (user_id uuid);
  CREATE TABLE public.invoices (id uuid PRIMARY KEY, player_id uuid, guest_player_id uuid, trainer_id uuid, academy_profile_id uuid);
  CREATE FUNCTION public.is_admin(u uuid) RETURNS boolean AS $f$ SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id=u) $f$ LANGUAGE sql STABLE;

  -- The registered player has their own profile + billing.
  INSERT INTO public.profiles (id,user_id,full_name,email,phone,billing_business_name,billing_address,billing_btw_number) VALUES
    ('${P.PLAYER}','${U.OTHER}','Registered Rick','rick@reg.com','111','Rick BV','Reg St 1','NL111'),
    ('${P.PARENT}','${U.PARENT}','Parent Petra','petra@new.com','999','Petra Holding','New Address 9','NL999');
  -- Linked guest (a child): own name, but linked to the parent profile (edited email/billing).
  INSERT INTO public.guest_players (id,first_name,last_name,full_name,email,phone,billing_business_name,billing_address,billing_btw_number,linked_profile_id) VALUES
    ('${G.LINKED}','Kid','Kevin',NULL,'old@stale.com','000','Old Biz','Old Address','NL000','${P.PARENT}'),
    ('${G.UNLINKED}',NULL,NULL,'Solo Sam','sam@solo.com','222','Sam Co','Solo St','NL222',NULL);
  INSERT INTO public.trainer_profiles (id,user_id) VALUES ('${TP}','${U.TR}');
  INSERT INTO public.invoices (id,player_id,guest_player_id,trainer_id,academy_profile_id) VALUES
    ('${INV.REG}','${P.PLAYER}',NULL,'${TP}',NULL),
    ('${INV.GUEST}',NULL,'${G.LINKED}','${TP}',NULL);
`);

const mig = readFileSync('supabase/migrations/20260613180000_invoice_recipient_identity.sql', 'utf8');
await db.exec(mig);

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const ident = async (pid, gid) => (await db.query(
  `SELECT * FROM public.get_invoice_recipient_identity(${pid ? `'${pid}'` : 'NULL'}, ${gid ? `'${gid}'` : 'NULL'})`)).rows[0];

// 1. Registered player → own profile identity + billing.
let r = await ident(P.PLAYER, null);
ok(r.full_name === 'Registered Rick' && r.email === 'rick@reg.com' && r.billing_business_name === 'Rick BV',
   'REGISTERED: identity + billing from profile', r);

// 2. Linked guest → OWN name, but email + billing from the linked (parent) profile.
r = await ident(null, G.LINKED);
ok(r.full_name === 'Kid Kevin', 'LINKED GUEST: shows the child\'s OWN name', r.full_name);
ok(r.email === 'petra@new.com', 'LINKED GUEST: email from linked profile (not stale guest email)', r.email);
ok(r.billing_business_name === 'Petra Holding' && r.billing_address === 'New Address 9' && r.billing_btw_number === 'NL999',
   'LINKED GUEST: billing from linked profile', r);

// 3. Unlinked guest → its own values.
r = await ident(null, G.UNLINKED);
ok(r.full_name === 'Solo Sam' && r.email === 'sam@solo.com' && r.billing_business_name === 'Sam Co',
   'UNLINKED GUEST: own identity + billing', r);

// 4. get_invoice_recipient_email gate.
async function emailFor(invId, uid) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid','${uid}',false);`);
  try { return (await db.query(`SELECT public.get_invoice_recipient_email('${invId}') AS e`)).rows[0].e; }
  finally { await db.exec('RESET ROLE'); }
}
ok((await emailFor(INV.GUEST, U.TR)) === 'petra@new.com', 'GATE: owning trainer gets the resolved (profile) email', await emailFor(INV.GUEST, U.TR));
ok((await emailFor(INV.GUEST, U.OTHER)) === null, 'GATE: a non-owner gets NULL (no probing arbitrary emails)', await emailFor(INV.GUEST, U.OTHER));
ok((await emailFor(INV.REG, U.TR)) === 'rick@reg.com', 'GATE: owning trainer resolves a registered invoice email', await emailFor(INV.REG, U.TR));

console.log(fail === 0 ? '\nALL invoice-recipient checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
