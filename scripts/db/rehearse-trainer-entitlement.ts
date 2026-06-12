/**
 * PGlite rehearsal for 20260612210000_p02_trainer_academy_entitlement.sql.
 *
 * Verifies, against a minimal schema mirror, that the redefined
 * trainer_profiles_safe.is_active_subscription counts academy entitlement:
 *  1. Own active subscription -> true.
 *  2. Own running trial -> true.
 *  3. Expired own trial + active membership in an academy whose trial runs -> true.
 *  4. Same membership but academy trial expired and academy not active -> false.
 *  5. No academy and no own entitlement -> false.
 *
 * Run: npx tsx scripts/db/rehearse-trainer-entitlement.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  __dirname,
  "../../supabase/migrations/20260612210000_p02_trainer_academy_entitlement.sql",
);

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    console.log(`  PASS ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`, detail ?? "");
  }
};

const main = async () => {
  const db = new PGlite();

  // --- Harness stubs (roles referenced by the migration's GRANT) ---
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
  `);

  // --- Minimal schema mirror (every column the view selects must exist) ---
  await db.exec(`
    CREATE TABLE public.trainer_profiles (
      id uuid PRIMARY KEY,
      user_id uuid,
      slug text,
      hourly_rate numeric,
      coaching_since_year integer,
      experience_years integer,
      certifications text[],
      specializations text[],
      is_verified boolean,
      knltb_rating numeric,
      trainer_rating_system text,
      coaching_method text,
      favourite_quote text,
      video_url text,
      website_url text,
      social_instagram text,
      social_tiktok text,
      social_youtube text,
      social_linkedin text,
      preferred_min_rating numeric,
      preferred_max_rating numeric,
      preferred_rating_system text,
      is_public boolean,
      slot_duration_minutes integer,
      schedule_weeks_ahead integer,
      require_booking_approval boolean,
      use_manual_invoicing boolean,
      waiting_list_enabled boolean,
      welcome_message text,
      general_terms text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      subscription_status text,
      trial_ends_at timestamptz
    );
    CREATE TABLE public.academy_profiles (
      id uuid PRIMARY KEY,
      subscription_status text,
      trial_ends_at timestamptz
    );
    CREATE TABLE public.academy_trainers (
      academy_profile_id uuid REFERENCES public.academy_profiles(id),
      trainer_profile_id uuid REFERENCES public.trainer_profiles(id),
      status text
    );
  `);

  // --- Apply the EXACT migration file content ---
  await db.exec(readFileSync(MIGRATION, "utf8"));
  console.log("migration applied cleanly");

  const T_OWN_ACTIVE = "00000000-0000-0000-0000-000000000001";
  const T_OWN_TRIAL = "00000000-0000-0000-0000-000000000002";
  const T_ACADEMY_TRIAL = "00000000-0000-0000-0000-000000000003";
  const T_ACADEMY_EXPIRED = "00000000-0000-0000-0000-000000000004";
  const T_NOTHING = "00000000-0000-0000-0000-000000000005";
  const ACAD_TRIALING = "00000000-0000-0000-0000-00000000000a";
  const ACAD_EXPIRED = "00000000-0000-0000-0000-00000000000b";

  await db.exec(`
    INSERT INTO public.trainer_profiles (id, subscription_status, trial_ends_at) VALUES
      ('${T_OWN_ACTIVE}', 'active', NULL),
      ('${T_OWN_TRIAL}', 'trial', now() + interval '7 days'),
      ('${T_ACADEMY_TRIAL}', 'trial', now() - interval '7 days'),
      ('${T_ACADEMY_EXPIRED}', 'trial', now() - interval '7 days'),
      ('${T_NOTHING}', 'trial', now() - interval '7 days');

    INSERT INTO public.academy_profiles (id, subscription_status, trial_ends_at) VALUES
      ('${ACAD_TRIALING}', 'trial', now() + interval '14 days'),
      ('${ACAD_EXPIRED}', 'trial', now() - interval '14 days');

    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status) VALUES
      ('${ACAD_TRIALING}', '${T_ACADEMY_TRIAL}', 'active'),
      ('${ACAD_EXPIRED}', '${T_ACADEMY_EXPIRED}', 'active');
  `);

  const isActive = async (trainerId: string): Promise<boolean> => {
    const r = await db.query<{ is_active_subscription: boolean }>(
      `SELECT is_active_subscription FROM public.trainer_profiles_safe WHERE id = $1`,
      [trainerId],
    );
    return r.rows[0].is_active_subscription;
  };

  // 1) Own active subscription -> true
  check("own active subscription gives true", (await isActive(T_OWN_ACTIVE)) === true);

  // 2) Own running trial -> true
  check("own running trial gives true", (await isActive(T_OWN_TRIAL)) === true);

  // 3) Expired own trial + active membership in academy with running trial -> true
  check(
    "expired own trial + active membership in trialing academy gives true",
    (await isActive(T_ACADEMY_TRIAL)) === true,
  );

  // 4) Same, but academy trial expired and academy not active -> false
  check(
    "active membership in expired, non-active academy gives false",
    (await isActive(T_ACADEMY_EXPIRED)) === false,
  );

  // 5) No academy and no own entitlement -> false
  check("no academy and no own entitlement gives false", (await isActive(T_NOTHING)) === false);

  if (failures > 0) {
    console.error(`\n${failures} rehearsal check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll P-02 trainer-entitlement rehearsal checks passed.");
};

main().catch((e) => {
  console.error("rehearsal crashed:", e);
  process.exit(1);
});
