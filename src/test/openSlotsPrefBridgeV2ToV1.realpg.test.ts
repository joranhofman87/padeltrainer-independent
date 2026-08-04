// @vitest-environment node
// 10c-b J — THE REVERSE PREFERENCE BRIDGE (v2 -> v1), verified on a REAL Postgres server.
//
// The gap under test, in one sentence: during the window the 10c-b runbook deliberately opens
// (migrations -> frontend -> wait out the browser bundle cache -> edge function), the NEW settings
// page writes an open-slots opt-out to notification_preferences_v2 ONLY, while the still-live OLD
// send-email bundle reads and enforces notification_preferences.open_slots_digest. Without the
// reverse bridge the player sees "Saved" and keeps receiving mail.
//
// WHY THIS FIXTURE IS NOT THE ONE IN openSlotsResolverDigest.realpg.test.ts. That suite stubs the
// legacy table as `(user_id uuid PRIMARY KEY, open_slots_digest text NOT NULL DEFAULT 'weekly')`.
// Two of the three things this bridge must survive are missing from that shape:
//   * the REAL validate_notification_prefs_frequency trigger, which RAISES (does not ignore) on an
//     unknown cadence — so a bridge writing a bad value aborts the user's save;
//   * the REAL update_notification_preferences_updated_at BEFORE UPDATE trigger;
//   * the other thirteen NOT NULL columns, which decide whether CREATING a legacy row where none
//     existed is behaviour-neutral for the legacy sender.
// So this file builds the table at its production shape and applies the REAL column/trigger
// migration (20260210090026) rather than a hand copy of it.
//
// Everything under test is loaded from the REAL migration files. Nothing is retyped: the forward
// trigger is extracted from 20261011100000, the catalog row (and therefore the catalog default the
// ambiguity rule turns on) from 20261008100000, and the bridge itself from 20261013100000.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54392;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;

const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

const F_BRIDGE = '20261013100000_notif_10cb_pref_bridge_v2_to_v1.sql';
const F_RESOLVER = '20261011100000_notif_10cb_resolver_open_slots_digest.sql';
const F_V1_COLUMNS = '20260210090026_6e534231-28a9-46ef-9065-7a16c9ccdea5.sql';
const F_CATALOG = '20261008100000_open_slots_player_event.sql';

const BRIDGE_SQL = MIG(F_BRIDGE);

const USER = '11111111-1111-1111-1111-111111111111';
const USER2 = '22222222-2222-2222-2222-222222222222';
const OTHER_EVENT = 'session_reminder_player';

/** The catalog default the INSERT ambiguity rule turns on — read from the DB, never retyped. */
let catalogDefault: string;
/**
 * The arrival rule, stated once: only an opt-out may OVERWRITE an existing legacy choice, because
 * an arriving value's provenance is not recoverable (see §1b of the migration). Everything else
 * seeds. So 'off' is the only cadence that applies over an existing row.
 */
const APPLIES_OVER_EXISTING = 'off';
const SEEDS_ONLY = ['instant', 'daily', 'weekly'];

/**
 * Extract a statement range from a REAL migration, refusing rather than silently returning
 * something that no longer matches. 10c-b I paid for this lesson: a fixture whose own string
 * surgery stops matching quietly tests a world that was never built.
 */
function slice(sql: string, from: string, to: string, mustContain: string[]): string {
  const i = sql.indexOf(from);
  const j = sql.indexOf(to, i + from.length);
  expect(i, `anchor not found: ${from}`).toBeGreaterThan(-1);
  expect(j, `terminator not found: ${to}`).toBeGreaterThan(i);
  const out = sql.slice(i, j);
  for (const m of mustContain) expect(out, `extract lost: ${m}`).toContain(m);
  return out;
}

/** The forward (v1 -> v2) trigger, taken from the migration that owns it. */
const FORWARD_TRIGGER = slice(
  MIG(F_RESOLVER),
  'DROP TRIGGER IF EXISTS trg_mirror_open_slots_pref_to_v2',
  'EXECUTE FUNCTION public.notif_mirror_open_slots_pref_to_v2();',
  ['AFTER INSERT OR UPDATE OF open_slots_digest'],
) + 'EXECUTE FUNCTION public.notif_mirror_open_slots_pref_to_v2();';

/** The real catalog row for open_slots_player, carrying the real default_email_frequency. */
const CATALOG_INSERT = slice(
  MIG(F_CATALOG),
  'INSERT INTO public.notification_event_types',
  'CREATE OR REPLACE FUNCTION',
  ["'open_slots_player'", '= now();'],
);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefbridge-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    -- ---- the v1 table at its PRODUCTION shape ----------------------------------------------
    -- Base, verbatim from 20260115230547:12-21 (the four boolean columns it also created are
    -- dropped by 20260210090026 below, so they are omitted rather than added-then-dropped).
    CREATE TABLE public.notification_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- The standard updated_at helper + the real trigger from 20260115230547:62-65. Present so the
    -- bridge is proven to coexist with a BEFORE UPDATE trigger on its target.
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;
    CREATE TRIGGER update_notification_preferences_updated_at
      BEFORE UPDATE ON public.notification_preferences
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

    -- ---- v2, verbatim from 20260910100000:119-129 -------------------------------------------
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL DEFAULT 'booking',
      audience text NOT NULL DEFAULT 'player',
      priority text NOT NULL DEFAULT 'engagement',
      required_delivery boolean NOT NULL DEFAULT false,
      supports_email boolean NOT NULL DEFAULT true,
      supports_whatsapp boolean NOT NULL DEFAULT false,
      supports_push boolean NOT NULL DEFAULT false,
      supports_digest boolean NOT NULL DEFAULT false,
      default_email_frequency text NOT NULL DEFAULT 'instant' CHECK (default_email_frequency IN ('instant','daily','weekly','off')),
      default_whatsapp_frequency text NOT NULL DEFAULT 'off' CHECK (default_whatsapp_frequency IN ('instant','daily','weekly','off')),
      default_push_frequency text NOT NULL DEFAULT 'off' CHECK (default_push_frequency IN ('instant','daily','weekly','off')),
      collapse_window_minutes int NOT NULL DEFAULT 0,
      quiet_hours_respect boolean NOT NULL DEFAULT false,
      template_email text, template_whatsapp text,
      visibility_scope text NOT NULL DEFAULT 'private_user_only',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      digest_engine_enabled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.notification_preferences_v2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      event_type text NOT NULL REFERENCES public.notification_event_types(key) ON DELETE CASCADE,
      email_frequency text NOT NULL DEFAULT 'instant' CHECK (email_frequency IN ('instant','daily','weekly','off')),
      whatsapp_frequency text NOT NULL DEFAULT 'off' CHECK (whatsapp_frequency IN ('instant','daily','weekly','off')),
      push_frequency text NOT NULL DEFAULT 'off' CHECK (push_frequency IN ('instant','daily','weekly','off')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_type)
    );

    -- ---- the write audit -------------------------------------------------------------------
    -- Counts REAL writes to each table so "did it bounce?" is measured, not inferred. Without
    -- this, a recursion guard is untestable: two mirrors that ping-pong once still converge on
    -- the same final values, so the end state alone cannot tell a guarded bridge from an
    -- unguarded one.
    CREATE TABLE public.bridge_audit (
      seq bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, uid uuid, val text
    );
    CREATE FUNCTION public.audit_v1() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.bridge_audit(tbl, op, uid, val)
      VALUES ('v1', TG_OP, NEW.user_id, NEW.open_slots_digest);
      RETURN NEW;
    END $fn$;
    CREATE FUNCTION public.audit_v2() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.bridge_audit(tbl, op, uid, val)
      VALUES ('v2', TG_OP, NEW.user_id, NEW.email_frequency);
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER zz_audit_v1 AFTER INSERT OR UPDATE ON public.notification_preferences
      FOR EACH ROW EXECUTE FUNCTION public.audit_v1();
    CREATE TRIGGER zz_audit_v2 AFTER INSERT OR UPDATE ON public.notification_preferences_v2
      FOR EACH ROW WHEN (NEW.event_type = 'open_slots_player') EXECUTE FUNCTION public.audit_v2();
  `);

  // The REAL v1 frequency columns, defaults, and the REAL validation trigger.
  await c.query(MIG(F_V1_COLUMNS));
  // The REAL catalog row (this is where 'weekly' comes from).
  await c.query(CATALOG_INSERT);
  await c.query(
    `INSERT INTO public.notification_event_types (key, supports_email) VALUES ($1, true)
     ON CONFLICT (key) DO NOTHING`, [OTHER_EVENT],
  );
  // The forward bridge's trigger (its function is (re)defined by the bridge migration).
  await c.query(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [USER, USER2]);

  await applyBridge();

  const d = await c.query(
    `SELECT default_email_frequency AS f FROM public.notification_event_types WHERE key='open_slots_player'`,
  );
  catalogDefault = d.rows[0].f;
  // Guard the whole ambiguity story: if this ever stops being a value the column default cannot
  // also produce, the rules below are testing something other than what they claim.
  expect(['instant', 'daily', 'weekly', 'off']).toContain(catalogDefault);
}, 300_000);

/** (Re)apply the real bridge migration, optionally mutated. Idempotent by construction. */
async function applyBridge(sql: string = BRIDGE_SQL) {
  await c.query(sql);
  await c.query(FORWARD_TRIGGER);
}

afterAll(async () => {
  await c?.end();
  await epg?.stop();
});

beforeEach(async () => {
  await c.query(`DELETE FROM public.notification_preferences_v2;
                 DELETE FROM public.notification_preferences;
                 DELETE FROM public.bridge_audit;`);
});

// ---- helpers ---------------------------------------------------------------------------------
const v1Of = async (u = USER) =>
  (await c.query(`SELECT open_slots_digest AS f FROM public.notification_preferences WHERE user_id=$1`, [u]))
    .rows[0]?.f ?? null;
const v2Of = async (u = USER) =>
  (await c.query(
    `SELECT email_frequency AS f FROM public.notification_preferences_v2
      WHERE user_id=$1 AND event_type='open_slots_player'`, [u])).rows[0]?.f ?? null;
const writes = async (tbl: string) =>
  Number((await c.query(`SELECT count(*)::int n FROM public.bridge_audit WHERE tbl=$1`, [tbl])).rows[0].n);

/**
 * Clear the v2 row WITHOUT firing the departure mirror.
 *
 * Several scenarios need the state "a legacy row exists, no v2 row" — which is a pre-J world, or a
 * user who never used the v2 page. Deleting the row normally is now a DEPARTURE, and the departure
 * mirror correctly moves v1 to the catalog default, so a plain DELETE would build a different
 * world than the one under test. Deletion as a SUBJECT is exercised in its own describe.
 */
const clearV2NoMirror = async () => {
  await c.query(`ALTER TABLE public.notification_preferences_v2
                   DISABLE TRIGGER trg_mirror_open_slots_pref_departure_del`);
  try {
    await c.query(`DELETE FROM public.notification_preferences_v2`);
  } finally {
    await c.query(`ALTER TABLE public.notification_preferences_v2
                     ENABLE TRIGGER trg_mirror_open_slots_pref_departure_del`);
  }
};

/** A legacy row as production has it: every other column at its real DDL default. */
const seedV1 = (freq: string, u = USER) =>
  c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,$2)`, [u, freq]);
/** A v2 save exactly as NotificationSettings.saveEvent() issues it (BOTH channel columns). */
const saveV2 = (email: string, whatsapp = 'off', u = USER, evt = 'open_slots_player') =>
  c.query(
    `INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency, whatsapp_frequency)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, event_type)
     DO UPDATE SET email_frequency=EXCLUDED.email_frequency,
                   whatsapp_frequency=EXCLUDED.whatsapp_frequency, updated_at=now()`,
    [u, evt, email, whatsapp],
  );

// =================================================================================================
describe('J — the reverse bridge closes the deploy-window gap', () => {
  it('a v2 opt-out reaches the legacy reader immediately, over an existing legacy choice', async () => {
    await seedV1('instant');
    await clearV2NoMirror(); // drop the forward mirror's row
    await saveV2('off');
    // This is the whole point: send-email reads open_slots_digest and would otherwise still send.
    expect(await v1Of()).toBe('off');
    expect(await v2Of()).toBe('off');
  });

  it('a FIRST-TIME v2 insert reaches the legacy reader when no legacy row exists at all', async () => {
    expect(await v1Of()).toBeNull();
    await saveV2('off');
    expect(await v1Of()).toBe('off');
  });

  it('a v2 UPDATE that changes the cadence applies to v1', async () => {
    await saveV2('instant');
    expect(await v1Of()).toBe('instant');
    await saveV2('daily');
    expect(await v1Of()).toBe('daily');
  });

  it('an opt-out carries across exactly; every other cadence only seeds', async () => {
    for (const f of [APPLIES_OVER_EXISTING]) {
      await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
      await seedV1('weekly');
      await clearV2NoMirror();
      await saveV2(f);
      expect(await v1Of(), `cadence ${f}`).toBe(f);
    }
  });

  it('a WhatsApp-only save does NOT rewrite the legacy column (no-change short-circuit)', async () => {
    await saveV2('daily');
    const before = await c.query(
      `SELECT open_slots_digest, updated_at FROM public.notification_preferences WHERE user_id=$1`, [USER]);
    const v1WritesBefore = await writes('v1');

    await saveV2('daily', 'instant'); // flips WhatsApp; email_frequency re-sent unchanged
    const after = await c.query(
      `SELECT open_slots_digest, updated_at FROM public.notification_preferences WHERE user_id=$1`, [USER]);

    expect(after.rows[0].open_slots_digest).toBe(before.rows[0].open_slots_digest);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at); // no pointless v1 write
    expect(await writes('v1')).toBe(v1WritesBefore);
  });

  it('RETARGETING a row onto this event reaches the legacy reader', async () => {
    // event_type is updatable by its owner (own-row UPDATE policy + column grant), so a row can
    // move onto open_slots_player from another event. With a `UPDATE OF email_frequency` column
    // list the trigger would not fire at all: the effective v2 preference would become 'off' while
    // the legacy reader kept sending. Reachable only through the table API, but it is an opt-out
    // that never lands, which is the failure this whole unit is about.
    await seedV1('instant');
    await clearV2NoMirror();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ($1,$2,'off')`, [USER, OTHER_EVENT]);
    expect(await v1Of(), 'precondition: another event must not touch v1').toBe('instant');

    await c.query(`UPDATE public.notification_preferences_v2 SET event_type='open_slots_player'
                    WHERE user_id=$1 AND event_type=$2`, [USER, OTHER_EVENT]);
    expect(await v1Of()).toBe('off');
  });

  it('MUTANT: the trigger narrowed back to UPDATE OF email_frequency — the retarget is invisible', async () => {
    const ANCHOR = '  AFTER INSERT OR UPDATE ON public.notification_preferences_v2';
    expect(BRIDGE_SQL).toContain(ANCHOR);
    const narrowed = BRIDGE_SQL.replace(
      ANCHOR, '  AFTER INSERT OR UPDATE OF email_frequency ON public.notification_preferences_v2');
    expect(narrowed).not.toBe(BRIDGE_SQL);
    try {
      await applyBridge(narrowed);
      await seedV1('instant');
      await clearV2NoMirror();
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                     VALUES ($1,$2,'off')`, [USER, OTHER_EVENT]);
      await c.query(`UPDATE public.notification_preferences_v2 SET event_type='open_slots_player'
                      WHERE user_id=$1 AND event_type=$2`, [USER, OTHER_EVENT]);
      expect(await v1Of(), 'the forbidden outcome: an opt-out the legacy reader never sees').toBe('instant');
    } finally { await applyBridge(); }
  });

  it('a RETARGET carrying anything but an opt-out is treated as incidental', async () => {
    // The hole the retarget fix opened: a WhatsApp-only first save on an event whose catalog
    // default is 'daily' stores email='daily' without the user choosing it. Retargeted onto
    // open_slots_player, 'daily' is not in THIS event's incidental set {instant, weekly} — so
    // without carrying the departing event's default into the test it reads as explicit and
    // overwrites a legacy 'off', resuming mail after an opt-out.
    await c.query(`UPDATE public.notification_event_types SET default_email_frequency='daily'
                    WHERE key=$1`, [OTHER_EVENT]);
    try {
      await seedV1('off');
      await clearV2NoMirror();
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                     VALUES ($1,$2,'daily')`, [USER, OTHER_EVENT]);
      await c.query(`UPDATE public.notification_preferences_v2 SET event_type='open_slots_player'
                      WHERE user_id=$1 AND event_type=$2`, [USER, OTHER_EVENT]);
      expect(await v1Of(), 'an incidental value from the departing event must not overwrite an opt-out')
        .toBe('off');
    } finally {
      await c.query(`UPDATE public.notification_event_types SET default_email_frequency='instant'
                      WHERE key=$1`, [OTHER_EVENT]);
    }
  });


  it('reassigning a row to ANOTHER user is an arrival for that user, not a no-op', async () => {
    // service_role is not constrained by RLS and can move a row between users. Comparing only
    // event_type left this misclassified: email did not change, so the change path returned early
    // and the new owner's opt-out never reached the legacy reader.
    await seedV1('instant', USER2);
    await clearV2NoMirror();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ($1,'open_slots_player','off')`, [USER]);
    await c.query(`UPDATE public.notification_preferences_v2 SET user_id=$1 WHERE user_id=$2`, [USER2, USER]);
    expect(await v1Of(USER2), "the new owner's opt-out must reach the legacy reader").toBe('off');
  });

  it('DELETING an opt-out never resumes mail — the legacy column stays off', async () => {
    // The one case a departure mirror must refuse: the value departing IS the opt-out, so moving
    // v1 to the catalog default would trade it away and the legacy reader would start sending.
    await saveV2('off');
    expect(await v1Of()).toBe('off');
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
    expect(await v2Of()).toBeNull();                       // v2 now resolves to the catalog default
    expect(await v1Of(), 'an opt-out must not be traded for the catalog default').toBe('off');
  });

  it('a different event type never touches the legacy column', async () => {
    await seedV1('instant');
    await clearV2NoMirror();
    await saveV2('off', 'off', USER, OTHER_EVENT);
    expect(await v1Of()).toBe('instant');
  });

  it('only the acting user is affected', async () => {
    await seedV1('instant', USER2);
    await clearV2NoMirror();
    await saveV2('off', 'off', USER);
    expect(await v1Of(USER)).toBe('off');
    expect(await v1Of(USER2)).toBe('instant');
  });
});

// =================================================================================================
describe('J — the INSERT ambiguity rule, and why it is not symmetric with the UPDATE rule', () => {
  it('an inserted CATALOG-DEFAULT cadence never overwrites an existing legacy choice', async () => {
    // saveEvent() computes the untouched channel from effective(), which falls back to the catalog
    // default — so a brand-new user flipping only the WhatsApp switch inserts this value without
    // ever expressing an email choice. Applying it over 'off' would resume mail after an opt-out.
    await seedV1('off');
    await clearV2NoMirror();
    await saveV2(catalogDefault, 'instant');
    expect(await v1Of()).toBe('off');
  });

  it('but it still SEEDS the legacy row when the user has none', async () => {
    expect(await v1Of()).toBeNull();
    await saveV2(catalogDefault);
    expect(await v1Of()).toBe(catalogDefault);
  });

  it('an inserted NON-default cadence does apply over an existing legacy choice', async () => {
    const explicit = APPLIES_OVER_EXISTING;
    await seedV1('weekly');
    await clearV2NoMirror();
    await saveV2(explicit);
    expect(await v1Of()).toBe(explicit);
  });

  it('an UPDATE to the catalog default DOES apply — only INSERT is ambiguous', async () => {
    const explicit = APPLIES_OVER_EXISTING;
    await saveV2(explicit);
    expect(await v1Of()).toBe(explicit);
    await saveV2(catalogDefault); // a real, deliberate change on the v2 page
    expect(await v1Of()).toBe(catalogDefault);
  });



  it("an opt-out applies EVEN IF 'off' is also the catalog default", async () => {
    // The rule turns on the VALUE, not on a comparison against any default, so a catalog edit
    // cannot make an opt-out stop applying. This used to depend on an explicit exclusion inside a
    // derived-set helper; it is now simply what the rule says.
    await c.query(`UPDATE public.notification_event_types SET default_email_frequency='off'
                    WHERE key='open_slots_player'`);
    try {
      await seedV1('instant');
      await clearV2NoMirror();
      await saveV2('off');
      expect(await v1Of(), 'an opt-out must apply even when it is also the catalog default').toBe('off');
    } finally {
      await c.query(`UPDATE public.notification_event_types SET default_email_frequency=$1
                      WHERE key='open_slots_player'`, [catalogDefault]);
    }
  });

  it('MUTANT: the arrival seed-only rule removed — an incidental value overwrites an opt-out', async () => {
    const ANCHOR = `  IF NEW.email_frequency <> 'off' THEN`;
    expect(BRIDGE_SQL).toContain(ANCHOR);
    const mutated = BRIDGE_SQL.replace(ANCHOR, `  IF false THEN`);
    expect(mutated).not.toBe(BRIDGE_SQL);
    try {
      await applyBridge(mutated);
      await seedV1('off');
      await clearV2NoMirror();
      // a partial insert: email_frequency takes the v2 COLUMN default, which nobody chose
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type)
                     VALUES ($1,'open_slots_player')`, [USER]);
      expect(await v1Of(), 'the forbidden outcome: mail resumes after an opt-out').not.toBe('off');
    } finally { await applyBridge(); }
  });

  it('a PARTIAL v2 insert takes the COLUMN default and must not overwrite a legacy opt-out', async () => {
    // notification_preferences_v2 is granted INSERT to `authenticated` with an own-rows policy, so
    // a row can be created through the table API without naming email_frequency at all. The column
    // default then applies — a value nobody chose. Treating it as explicit would resume mail after
    // an opt-out. (This, not the WhatsApp-only save, is the LIVE incidental source for this event:
    // open_slots_player ships supports_whatsapp = false.)
    await seedV1('off');
    await clearV2NoMirror();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type)
                   VALUES ($1,'open_slots_player')`, [USER]);
    expect(SEEDS_ONLY, 'the column default is not an opt-out, so it can only seed').toContain(await v2Of());
    expect(await v1Of(), 'an incidental column default must never overwrite an opt-out').toBe('off');
  });

  it('...but a partial insert still SEEDS a legacy row when the user has none', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type)
                   VALUES ($1,'open_slots_player')`, [USER]);
    expect(await v1Of()).toBe(await v2Of());
  });

  it('only an opt-out applies over an existing legacy choice — the case the contract names', async () => {
    for (const f of SEEDS_ONLY) {
      await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
      await seedV1('daily');
      await clearV2NoMirror();
      await saveV2(f);
      expect(await v1Of(), `${f} must not overwrite an existing legacy choice`).toBe('daily');
    }
    await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
    await seedV1('daily');
    await clearV2NoMirror();
    await saveV2('off');
    expect(await v1Of(), 'an opt-out does').toBe('off');
  });

});

// =================================================================================================
describe('J — production shape: creating a legacy row is behaviour-neutral for the legacy sender', () => {
  it('the seven other columns send-email reads all default to the absent-row fallback', async () => {
    // send-email/index.ts:1383 reads `(prefs)?.[col] || "instant"`, so an ABSENT row behaves as
    // 'instant'. The bridge creates a row where none existed; that is only safe if every column
    // send-email can consult already defaults to 'instant'. Asserted against the REAL DDL.
    await saveV2('off');
    const row = await c.query(
      `SELECT booking_confirmation, booking_reminder, booking_cancelled, new_review,
              payment_receipt, payment_received, new_booking
         FROM public.notification_preferences WHERE user_id=$1`, [USER]);
    for (const [col, val] of Object.entries(row.rows[0])) {
      expect(val, `${col} must match send-email's absent-row fallback`).toBe('instant');
    }
  });

  it('the bridge satisfies the REAL validation trigger for every cadence it can write', async () => {
    for (const f of ['off', 'instant', 'daily', 'weekly']) {
      await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
      await saveV2(f);
      expect(await v1Of()).toBe(f); // would have RAISEd, not been ignored, if invalid
    }
  });

  it('the real validation trigger is present and does raise (the fixture is not a soft stub)', async () => {
    await expect(
      c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest)
               VALUES ($1,'fortnightly')`, [USER2]),
    ).rejects.toThrow(/Invalid frequency value/);
  });
});

// =================================================================================================
describe('J — recursion: two mirrors, one hop each', () => {
  it('a v2 save produces exactly ONE v1 write and no bounce back into v2', async () => {
    await saveV2('off');
    expect(await writes('v2')).toBe(1);
    expect(await writes('v1')).toBe(1);
  });

  it('a legacy save produces exactly ONE v2 write and no bounce back into v1', async () => {
    await seedV1('off');
    expect(await writes('v1')).toBe(1);
    expect(await writes('v2')).toBe(1);
    expect(await v2Of()).toBe('off');
  });

  it('the guard is transaction-local and does not leak between statements', async () => {
    // Two independent saves in ONE transaction must BOTH mirror. A guard left set by the first
    // would silently swallow the second — the failure mode of a flag that is set but never reset.
    await c.query('BEGIN');
    await saveV2('off', 'off', USER);
    await saveV2('daily', 'off', USER2);
    await c.query('COMMIT');
    expect(await v1Of(USER)).toBe('off');
    expect(await v1Of(USER2)).toBe('daily');
  });

  it('the guard is rolled back when the abort happens INSIDE the guarded write', async () => {
    // The failure this must exclude is the guard being left 'on' by an error raised BETWEEN
    // set_config('on') and set_config('off') — after which every later mirror in that transaction
    // silently does nothing.
    //
    // Reaching that window takes work: an invalid cadence is rejected by v1's BEFORE validation
    // trigger, which runs before the guarded AFTER trigger ever executes, so the obvious version of
    // this test never arms the guard at all. A CHECK constraint on v1 fires INSIDE the bridge's own
    // nested INSERT instead, which is the window that matters.
    await c.query(`ALTER TABLE public.notification_preferences
                     ADD CONSTRAINT tmp_no_daily CHECK (open_slots_digest <> 'daily')`);
    try {
      await c.query('BEGIN');
      await c.query('SAVEPOINT s');
      await expect(saveV2('daily'), 'the nested v1 write must be what fails').rejects.toThrow(/tmp_no_daily/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      // Same transaction: if the guard survived the abort, this mirror is swallowed.
      await saveV2('off');
      await c.query('COMMIT');
      expect(await v1Of()).toBe('off');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query(`ALTER TABLE public.notification_preferences DROP CONSTRAINT IF EXISTS tmp_no_daily`);
    }
  });

  it('the two directions agree after a chain of alternating writes', async () => {
    for (const f of ['off', 'instant', 'daily', 'weekly', 'off']) {
      await c.query(`UPDATE public.notification_preferences SET open_slots_digest=$1 WHERE user_id=$2`, [f, USER])
        .catch(() => undefined);
      await seedV1(f).catch(() => undefined);
      expect(await v2Of()).toBe(f);
      expect(await v1Of()).toBe(f);
    }
  });
});

// =================================================================================================
describe('J — departures: losing the v2 row, without ever trading away an opt-out', () => {
  it('deleting a NON-off row moves the legacy column to the catalog default, so the two agree', async () => {
    await saveV2('daily');
    await c.query(`UPDATE public.notification_preferences SET open_slots_digest='daily' WHERE user_id=$1`, [USER])
      .catch(() => undefined);
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
    // v2 now resolves to the catalog default; v1 must too.
    expect(await v1Of()).toBe(catalogDefault);
  });

  it('but it refuses when the LEGACY column is already off, whatever v2 said', async () => {
    await c.query(`ALTER TABLE public.notification_preferences_v2 DISABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ($1,'open_slots_player','daily')`, [USER]);
    await c.query(`ALTER TABLE public.notification_preferences_v2 ENABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
    await seedV1('off');
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
    expect(await v1Of(), 'a legacy opt-out is never overwritten by a departure').toBe('off');
  });

  it('retargeting AWAY is a departure too', async () => {
    await saveV2('daily');
    await c.query(`UPDATE public.notification_preferences_v2 SET event_type=$1
                    WHERE user_id=$2 AND event_type='open_slots_player'`, [OTHER_EVENT, USER]);
    expect(await v1Of()).toBe(catalogDefault);
  });

  it("a departure DOES apply when the catalog default is itself 'off' — it suppresses", async () => {
    // The refusals are about SUPPRESSION, not about the token 'off'. An earlier version refused to
    // write anything but instant/daily/weekly, so with a catalog default of 'off' the legacy reader
    // kept sending while v2 resolved to 'off' — divergence in the unsafe direction.
    await c.query(`UPDATE public.notification_event_types SET default_email_frequency='off'
                    WHERE key='open_slots_player'`);
    try {
      await saveV2('daily');
      expect(await v1Of()).toBe('daily');
      await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
      expect(await v1Of(), 'v2 now resolves to off, so the legacy reader must too').toBe('off');
    } finally {
      await c.query(`UPDATE public.notification_event_types SET default_email_frequency=$1
                      WHERE key='open_slots_player'`, [catalogDefault]);
    }
  });

  it('reassigning a row AWAY is a departure for the ORIGINAL user', async () => {
    // The other half of the user_id arm. The arrival test uses 'off', for which a departure
    // deliberately does nothing — so without this, removing `OR NEW.user_id IS DISTINCT FROM
    // OLD.user_id` from the departure trigger would leave every test green.
    await saveV2('daily', 'off', USER);
    expect(await v1Of(USER)).toBe('daily');
    await c.query(`DELETE FROM public.notification_preferences WHERE user_id=$1`, [USER2]);
    await c.query(`UPDATE public.notification_preferences_v2 SET user_id=$1 WHERE user_id=$2`, [USER2, USER]);
    expect(await v1Of(USER), 'the original user lost their preference: v1 follows the catalog default')
      .toBe(catalogDefault);
  });

  it('MUTANT: the user_id arm removed from the departure trigger — the original user is stranded', async () => {
    const ANCHOR = `             OR NEW.user_id IS DISTINCT FROM OLD.user_id))`;
    expect(BRIDGE_SQL).toContain(ANCHOR);
    const mutated = BRIDGE_SQL.replace(ANCHOR, `             ))`);
    expect(mutated).not.toBe(BRIDGE_SQL);
    try {
      await applyBridge(mutated);
      await saveV2('daily', 'off', USER);
      await c.query(`DELETE FROM public.notification_preferences WHERE user_id=$1`, [USER2]);
      await c.query(`UPDATE public.notification_preferences_v2 SET user_id=$1 WHERE user_id=$2`, [USER2, USER]);
      expect(await v1Of(USER), 'the forbidden outcome: v1 keeps sending for a user with no preference')
        .toBe('daily');
    } finally { await applyBridge(); }
  });

  it('a departure never CREATES a legacy row — account teardown stays a no-op', async () => {
    await saveV2('daily');
    await c.query(`DELETE FROM public.notification_preferences WHERE user_id=$1`, [USER]); // v1 gone first
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
    expect(await v1Of(), 'an UPDATE-only mirror cannot resurrect a deleted account row').toBeNull();
  });

  it('a departure does not bounce back through the forward mirror', async () => {
    await saveV2('daily');
    await c.query(`DELETE FROM public.bridge_audit`);
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
    expect(await writes('v1')).toBe(1);
    expect(await writes('v2'), 'the guard must hold across the departure write').toBe(0);
  });

  it("MUTANT: the departure's off-guard removed — deleting an opt-out resumes mail", async () => {
    // BOTH off-guards, because they are deliberately redundant and each masks the other: the
    // departing value is 'off' AND the legacy column is 'off', so removing either alone leaves the
    // other still refusing. The positive control below proves that is the reason.
    const A1 = `  IF OLD.email_frequency = 'off' AND v_default <> 'off' THEN RETURN NULL; END IF;`;
    const A2 = `     AND (v_default = 'off' OR open_slots_digest <> 'off');`;
    expect(BRIDGE_SQL).toContain(A1);
    expect(BRIDGE_SQL).toContain(A2);
    const mutated = BRIDGE_SQL.replace(A1, `  -- off-guard removed by mutation pin`).replace(A2, `     ;`);
    expect(mutated).not.toBe(BRIDGE_SQL);
    try {
      await applyBridge(mutated);
      await saveV2('off');
      await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
      expect(await v1Of(), 'the forbidden outcome: the opt-out traded for the catalog default')
        .toBe(catalogDefault);
    } finally { await applyBridge(); }
  });

  it('POSITIVE CONTROL: removing only the legacy-side off-guard still refuses', async () => {
    const A2 = `     AND (v_default = 'off' OR open_slots_digest <> 'off');`;
    expect(BRIDGE_SQL).toContain(A2);
    try {
      await applyBridge(BRIDGE_SQL.replace(A2, `     ;`));
      await saveV2('off');
      await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
      expect(await v1Of(), 'the departing-value guard alone is sufficient here').toBe('off');
    } finally { await applyBridge(); }
  });

  it('MUTANT: the departure mirror removed entirely — v1 and v2 stay diverged', async () => {
    try {
      await c.query(`DROP TRIGGER trg_mirror_open_slots_pref_departure_del ON public.notification_preferences_v2`);
      await saveV2('daily');
      await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id=$1`, [USER]);
      expect(await v1Of()).toBe('daily');            // v2 resolves to the catalog default: diverged
      expect(await v1Of()).not.toBe(catalogDefault);
    } finally { await applyBridge(); }
  });
});

// =================================================================================================
describe('J — the one-time reverse reconcile catches v2 rows that predate the trigger', () => {
  /** A v2 row written before the reverse mirror existed: no trigger, so no legacy counterpart. */
  const seedPreJ = async (freq: string, u = USER) => {
    await c.query(`ALTER TABLE public.notification_preferences_v2 DISABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
    try {
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                     VALUES ($1,'open_slots_player',$2)`, [u, freq]);
    } finally {
      await c.query(`ALTER TABLE public.notification_preferences_v2 ENABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
    }
  };

  it('a pre-existing v2 opt-out with NO legacy row reaches the legacy reader when J is applied', async () => {
    await seedPreJ('off');
    expect(await v1Of(), 'precondition: the trigger did not fire').toBeNull();
    await applyBridge();                       // re-applying J runs the one-time reconcile
    expect(await v1Of()).toBe('off');
  });

  it('a pre-existing v2 opt-out OVERWRITES a disagreeing legacy row', async () => {
    await seedV1('instant');
    await clearV2NoMirror();
    await seedPreJ('off');
    await applyBridge();
    expect(await v1Of()).toBe('off');
  });

  it('but an incidental value never overwrites an existing legacy choice', async () => {
    await seedV1('off');
    await clearV2NoMirror();
    await seedPreJ(SEEDS_ONLY[0]);
    await applyBridge();
    expect(await v1Of(), 'the reconcile uses the trigger rules, not a looser second rule').toBe('off');
  });

  it('re-running is a pure no-op — it does not rewrite rows that already agree', async () => {
    await saveV2('off');
    const before = await writes('v1');
    await applyBridge();
    await applyBridge();
    expect(await writes('v1')).toBe(before);
    expect(await v1Of()).toBe('off');
  });

  it('the reconcile does not bounce back through the forward mirror', async () => {
    await seedPreJ('off');
    await c.query(`DELETE FROM public.bridge_audit`);
    await applyBridge();
    expect(await writes('v1')).toBe(1);
    expect(await writes('v2'), 'the guard must hold across the whole reconcile').toBe(0);
  });

  it('MUTANT: the reconcile removed — a pre-existing v2 opt-out stays stranded', async () => {
    const RECONCILE_START = 'DO $reconcile$';
    const i = BRIDGE_SQL.indexOf(RECONCILE_START);
    const j = BRIDGE_SQL.indexOf('$reconcile$;', i);
    expect(i, 'the reconcile block must be findable').toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const without = BRIDGE_SQL.slice(0, i) + BRIDGE_SQL.slice(j + '$reconcile$;'.length);
    expect(without).not.toBe(BRIDGE_SQL);
    try {
      await seedPreJ('off');
      await c.query(without);
      await c.query(FORWARD_TRIGGER);
      expect(await v1Of()).toBeNull(); // stranded — send-email's absent-row fallback keeps mailing
    } finally { await applyBridge(); }
  });
});

// =================================================================================================
describe('J — concurrency', () => {
  const conn = async () => {
    const x = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await x.connect();
    return x;
  };

  it('two concurrent v2 saves leave v1 and v2 agreeing on one of them', async () => {
    const [a, b] = [await conn(), await conn()];
    try {
      expect((await a.query('SELECT pg_backend_pid() p')).rows[0].p)
        .not.toBe((await b.query('SELECT pg_backend_pid() p')).rows[0].p);
      const save = (x: pg.Client, f: string) => x.query(
        `INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
         VALUES ($1,'open_slots_player',$2)
         ON CONFLICT (user_id, event_type) DO UPDATE SET email_frequency=EXCLUDED.email_frequency`,
        [USER, f]);
      await Promise.allSettled([save(a, 'off'), save(b, 'daily')]);
      const [f1, f2] = [await v1Of(), await v2Of()];
      expect(['off', 'daily']).toContain(f2);
      expect(f1).toBe(f2); // THE invariant: no interleaving leaves the two tables disagreeing
    } finally { await a.end(); await b.end(); }
  });

  it('a cross-table lock cycle aborts cleanly and still leaves the tables agreeing', async () => {
    await seedV1('instant');
    const [a, b] = [await conn(), await conn()];
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      // A takes v1 first, B takes v2 first — opposite orders, the classic cycle.
      await a.query(`SELECT 1 FROM public.notification_preferences WHERE user_id=$1 FOR UPDATE`, [USER]);
      await b.query(`SELECT 1 FROM public.notification_preferences_v2
                      WHERE user_id=$1 AND event_type='open_slots_player' FOR UPDATE`, [USER]);
      const pa = a.query(`UPDATE public.notification_preferences_v2 SET email_frequency='off'
                           WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
      const pb = b.query(`UPDATE public.notification_preferences SET open_slots_digest='daily'
                           WHERE user_id=$1`, [USER]);
      const settled = await Promise.allSettled([pa, pb]);
      // Postgres must break the cycle rather than hang; exactly one side dies.
      expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
      expect(String((settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason))
        .toMatch(/deadlock detected/i);
      await a.query('COMMIT').catch(() => undefined);
      await b.query('COMMIT').catch(() => undefined);
      expect(await v1Of()).toBe(await v2Of()); // the aborted half left nothing behind
    } finally { await a.end(); await b.end(); }
  });

  it('a legacy write concurrent with a v2 write never strands an explicit opt-out', async () => {
    const [a, b] = [await conn(), await conn()];
    try {
      await Promise.allSettled([
        a.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                 VALUES ($1,'open_slots_player','off')
                 ON CONFLICT (user_id, event_type) DO UPDATE SET email_frequency='off'`, [USER]),
        b.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest)
                 VALUES ($1,'instant') ON CONFLICT (user_id) DO UPDATE SET open_slots_digest='instant'`, [USER]),
      ]);
      expect(await v1Of()).toBe(await v2Of());
    } finally { await a.end(); await b.end(); }
  });
});

// =================================================================================================
// ---- MUTATION PINS -----------------------------------------------------------------------------
// Each removes ONE guard from the REAL migration text, re-applies it, and requires the covering
// behaviour to go wrong. A pin that cannot make its own scenario fail is pinning nothing, so every
// mutation asserts that the substitution actually bit before it is used.
describe('J — MUTATION PINS', () => {
  /** Apply one or more substitutions to the REAL migration, refusing if any fails to bite. */
  const mutate = (...pairs: Array<[string, string]>) => {
    let out = BRIDGE_SQL;
    for (const [from, to] of pairs) {
      expect(out, `mutation anchor vanished: ${from}`).toContain(from);
      const next = out.split(from).join(to);
      expect(next, `mutation did not bite: ${from}`).not.toBe(out);
      out = next;
    }
    return out;
  };

  const REVERSE_GUARD = `  -- RECURSION GUARD, as above.
  IF public.notif_pref_bridge_hop_active() THEN RETURN NEW; END IF;`;
  const REVERSE_DISTINCT_ONLY = `    ON CONFLICT (user_id)
    DO UPDATE SET open_slots_digest = EXCLUDED.open_slots_digest
    WHERE public.notification_preferences.open_slots_digest IS DISTINCT FROM EXCLUDED.open_slots_digest;`;
  const REVERSE_UNCONDITIONAL = `    ON CONFLICT (user_id)
    DO UPDATE SET open_slots_digest = EXCLUDED.open_slots_digest;`;
  it('MUTANT: the reverse trigger removed — the opt-out never reaches the legacy reader', async () => {
    try {
      await c.query(`DROP TRIGGER trg_mirror_open_slots_pref_to_v1 ON public.notification_preferences_v2`);
      await seedV1('instant');
      await clearV2NoMirror();
      await saveV2('off');
      expect(await v1Of()).toBe('instant'); // <- the bug this release unit exists to fix
      expect(await v2Of()).toBe('off');
    } finally { await applyBridge(); }
  });

  it('MUTANT: the recursion guard removed — a v2 save bounces and writes v2 a second time', async () => {
    try {
      await applyBridge(mutate([
        'IF public.notif_pref_bridge_hop_active() THEN RETURN NEW; END IF;',
        '-- guard removed by mutation pin',
      ]));
      await saveV2('off');
      // The end state still converges — which is exactly why this is measured in WRITES. The
      // forward mirror's DO UPDATE is unconditional (it is the reviewed 20261011100000 body,
      // unchanged), so the bounce lands as a real second write on the v2 row.
      expect(await writes('v2')).toBeGreaterThan(1);
    } finally { await applyBridge(); }
  });

  it('MUTANT: the reverse guard AND its distinct-only write removed — the legacy row is written twice', async () => {
    // The two reverse-side protections are deliberately REDUNDANT: the guard stops the hop, the
    // distinct-only predicate stops the write even if the hop happens. Neither is observable while
    // the other stands, so the honest pin removes both and requires the bounce to appear.
    try {
      await applyBridge(mutate(
        [REVERSE_GUARD, '  -- reverse guard removed by mutation pin'],
        [REVERSE_DISTINCT_ONLY, REVERSE_UNCONDITIONAL],
      ));
      await seedV1('off');
      expect(await writes('v1')).toBeGreaterThan(1);
    } finally { await applyBridge(); }
  });

  it('POSITIVE CONTROL: with the guard intact, removing the distinct-only write changes nothing', async () => {
    // Proves the previous pin failed for the reason claimed (the guard) rather than because the
    // scenario cannot bounce at all.
    try {
      await applyBridge(mutate([REVERSE_DISTINCT_ONLY, REVERSE_UNCONDITIONAL]));
      await seedV1('off');
      expect(await writes('v1')).toBe(1);
    } finally { await applyBridge(); }
  });


  it('MUTANT: the INSERT seed path removed — a first-time v2 insert never reaches the legacy reader', async () => {
    try {
      await applyBridge(mutate([
        `    INSERT INTO public.notification_preferences (user_id, open_slots_digest)
    VALUES (NEW.user_id, NEW.email_frequency)
    ON CONFLICT (user_id) DO NOTHING;`,
        `    NULL;`,
      ]));
      await saveV2(catalogDefault);
      expect(await v1Of()).toBeNull(); // the legacy reader keeps its absent-row 'instant'
    } finally { await applyBridge(); }
  });

  it('MUTANT: the no-change short-circuit removed — a WhatsApp-only save materialises a legacy row', async () => {
    // The observable consequence is not a changed VALUE (the distinct-only predicate absorbs
    // that) but a legacy row appearing for someone who had none: without the short-circuit the
    // upsert still runs, finds no conflict, and INSERTs. A WhatsApp toggle must not create a
    // legacy email row.
    try {
      await applyBridge(mutate([
        `    IF NEW.email_frequency IS NOT DISTINCT FROM OLD.email_frequency THEN
      RETURN NEW;
    END IF;`,
        `    -- short-circuit removed by mutation pin`,
      ]));
      await saveV2('daily');
      await c.query(`DELETE FROM public.notification_preferences`); // v2 row, no v1 row
      await saveV2('daily', 'instant');                            // WhatsApp only
      expect(await v1Of()).toBe('daily');                          // the forbidden outcome
    } finally { await applyBridge(); }
  });

  it('MUTANT: the unknown-cadence filter removed — a bad value aborts the save instead of no-op', async () => {
    // Unreachable while v2 carries its CHECK, which is why the CHECK is dropped here: the point is
    // that the filter is the thing standing between a future CHECK relaxation and a hard error in
    // the user's face, not that the CHECK is currently absent.
    try {
      await applyBridge(mutate([
        `  IF NEW.email_frequency IS NULL OR NEW.email_frequency NOT IN ('off','instant','daily','weekly') THEN
    RETURN NEW;
  END IF;`,
        `  -- filter removed by mutation pin`,
      ]));
      await c.query(`ALTER TABLE public.notification_preferences_v2
                       DROP CONSTRAINT notification_preferences_v2_email_frequency_check`);
      await expect(saveV2('fortnightly')).rejects.toThrow(/Invalid frequency value/);
    } finally {
      await c.query(`ALTER TABLE public.notification_preferences_v2
        ADD CONSTRAINT notification_preferences_v2_email_frequency_check
        CHECK (email_frequency IN ('instant','daily','weekly','off'))`).catch(() => undefined);
      await applyBridge();
    }
  });

  it('MUTANT: the forward guard removed while the reverse bridge exists — forward writes still land once', async () => {
    // Pins that the forward direction's own guard is load-bearing, separately from the reverse's.
    try {
      await applyBridge(mutate([
        `  -- RECURSION GUARD. A v2 -> v1 hop is already carrying this user's choice; re-mirroring it
  -- forward would bounce it straight back.
  IF public.notif_pref_bridge_hop_active() THEN RETURN NEW; END IF;`,
        `  -- forward guard removed by mutation pin`,
      ]));
      await saveV2('off');
      expect(await writes('v2')).toBeGreaterThan(1);
    } finally { await applyBridge(); }
  });
});
