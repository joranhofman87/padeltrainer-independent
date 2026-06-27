/**
 * PGlite rehearsal for protect_booking_financial_columns_for_players (migration 20260624120000) —
 * the BEFORE UPDATE trigger that blocks a logged-in PLAYER from editing their OWN booking's
 * financial columns (payment_status / paid_at / paid_externally / payment_amount / original_amount /
 * discount_* / mollie_*). Until now only a STATIC shape-guard (bookingFinancialGuard.test.ts) checked
 * the SQL text; this runs the ACTUAL trigger against real Postgres under each auth context.
 *
 * Run: npx tsx scripts/db/rehearse-booking-financial-guard.ts
 */
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const U_PLAYER = '11111111-1111-1111-1111-111111111111'; // player's auth user
const P_PLAYER = '22222222-2222-2222-2222-222222222222'; // player's profile (= booking.player_id)
const U_STAFF = '33333333-3333-3333-3333-333333333333'; // staff (manager/trainer) auth user
const P_STAFF = '44444444-4444-4444-4444-444444444444'; // staff profile (!= booking's player)
const B1 = 'aaaaaaaa-0000-0000-0000-000000000001';

const setUid = async (uid: string) => { await db.query(`SELECT set_config('test.uid', $1, false)`, [uid]); };
/** Run an UPDATE under a given auth.uid(); return true if it RAISED (was blocked), false if it succeeded. */
const blocked = async (uid: string, setClause: string): Promise<boolean> => {
  await setUid(uid);
  try {
    await db.query(`UPDATE public.bookings SET ${setClause} WHERE id = '${B1}'`);
    return false;
  } catch {
    return true;
  }
};
const reseed = async () => {
  await db.exec(`
    UPDATE public.bookings SET
      payment_status = 'pending', paid_at = NULL, paid_externally = false, payment_amount = 50,
      notes = 'orig', status = 'confirmed'
    WHERE id = '${B1}';`);
};

await db.exec(`
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

-- user -> profile map + the get_profile_id_for_user() the trigger calls.
CREATE TABLE public._user_profiles (user_id uuid, profile_id uuid);
CREATE FUNCTION public.get_profile_id_for_user(p_user uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT profile_id FROM public._user_profiles WHERE user_id = p_user $$;

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY,
  player_id uuid,
  status text,
  notes text,
  payment_status text,
  paid_at timestamptz,
  paid_externally boolean,
  payment_amount numeric,
  original_amount numeric,
  discount_amount numeric,
  discount_reason text,
  mollie_payment_id text,
  mollie_transaction_id text
);

INSERT INTO public._user_profiles VALUES ('${U_PLAYER}', '${P_PLAYER}'), ('${U_STAFF}', '${P_STAFF}');
INSERT INTO public.bookings (id, player_id, status, notes, payment_status, paid_externally, payment_amount)
  VALUES ('${B1}', '${P_PLAYER}', 'confirmed', 'orig', 'pending', false, 50);
`);

const fs = await import('node:fs');
const path = await import('node:path');
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '20260624120000_protect_booking_financial_columns_for_players.sql'),
  'utf8',
);
await db.exec(migration);

// (a) The booking's own player CANNOT change its financial columns.
check('player blocked: payment_status -> paid', await blocked(U_PLAYER, `payment_status = 'paid'`));
await reseed();
check('player blocked: paid_externally -> true', await blocked(U_PLAYER, `paid_externally = true`));
await reseed();
check('player blocked: payment_amount change', await blocked(U_PLAYER, `payment_amount = 0`));
await reseed();
check('player blocked: paid_at set', await blocked(U_PLAYER, `paid_at = now()`));
await reseed();

// (b) The player MAY still cancel + edit notes (non-financial columns).
check('player allowed: status -> cancelled (cancel own booking)', !(await blocked(U_PLAYER, `status = 'cancelled'`)));
await reseed();
check('player allowed: notes-only edit', !(await blocked(U_PLAYER, `notes = 'my note'`)));
await reseed();

// (c) Staff acting on ANOTHER player's booking pass through (caller profile != booking.player_id).
check('staff allowed: mark another player paid', !(await blocked(U_STAFF, `payment_status = 'paid', paid_at = now()`)));
await reseed();

// (d) Service role / unauthenticated (auth.uid() IS NULL) passes through.
check('service-role allowed: mark paid (auth.uid NULL)', !(await blocked('', `payment_status = 'paid'`)));
await reseed();

// (e) Confirm the block actually persisted nothing for the player case.
await setUid(U_PLAYER);
let raised = false;
try { await db.query(`UPDATE public.bookings SET payment_status = 'paid' WHERE id = '${B1}'`); } catch { raised = true; }
const { rows } = await db.query<{ payment_status: string }>(`SELECT payment_status FROM public.bookings WHERE id = '${B1}'`);
check('blocked player update left payment_status unchanged', raised && rows[0]?.payment_status === 'pending', rows[0]);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
