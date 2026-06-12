/**
 * PGlite rehearsal for 20260612121000_m10_invoice_numbering_atomic.sql.
 *
 * Verifies, against a minimal schema mirror:
 *  1. next_invoice_sequence allocates strictly increasing numbers (atomic UPDATE).
 *  2. GREATEST floor: p_min above the counter raises the allocation atomically.
 *  3. unique_invoice_number_per_academy rejects a duplicate academy number (23505)
 *     while leaving trainer-personal invoices (NULL academy) unaffected.
 *  4. Authorization: unauthorized authenticated caller is refused (42501);
 *     academy managers, trainer owners, and service-role (uid NULL) pass.
 *
 * Run: npx tsx scripts/db/rehearse-m10-invoice-numbering.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  __dirname,
  "../../supabase/migrations/20260612121000_m10_invoice_numbering_atomic.sql",
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

  // --- Harness stubs (roles + auth.uid(), matching the established pattern) ---
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth_stub (uid uuid);
    INSERT INTO auth_stub VALUES (NULL);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT uid FROM auth_stub LIMIT 1';
  `);

  // --- Minimal schema mirror ---
  await db.exec(`
    CREATE TABLE public.trainer_profiles (
      id uuid PRIMARY KEY,
      user_id uuid,
      invoice_next_number integer
    );
    CREATE TABLE public.academy_profiles (
      id uuid PRIMARY KEY,
      invoice_next_number integer
    );
    CREATE TABLE public.academy_managers (
      academy_profile_id uuid,
      user_id uuid
    );
    CREATE TABLE public.user_roles (
      user_id uuid,
      role text
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid,
      academy_profile_id uuid,
      invoice_number text NOT NULL,
      CONSTRAINT unique_invoice_number_per_trainer UNIQUE (trainer_id, invoice_number)
    );
    CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.academy_managers
        WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id
      );
    $$;
  `);

  // --- Apply the migration under test ---
  await db.exec(readFileSync(MIGRATION, "utf8"));
  console.log("migration applied cleanly");

  const ACAD = "00000000-0000-0000-0000-00000000000a";
  const TRAINER = "00000000-0000-0000-0000-00000000000b";
  const MANAGER = "00000000-0000-0000-0000-000000000001";
  const STRANGER = "00000000-0000-0000-0000-000000000002";
  const OWNER = "00000000-0000-0000-0000-000000000003";

  await db.exec(`
    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 5);
    INSERT INTO public.trainer_profiles VALUES ('${TRAINER}', '${OWNER}', NULL);
    INSERT INTO public.academy_managers VALUES ('${ACAD}', '${MANAGER}');
  `);

  const alloc = async (type: string, id: string, min = 1) => {
    const r = await db.query<{ n: number }>(
      `SELECT public.next_invoice_sequence($1, $2, $3) AS n`,
      [type, id, min],
    );
    return r.rows[0].n;
  };
  const setUid = (uid: string | null) =>
    db.exec(`UPDATE auth_stub SET uid = ${uid ? `'${uid}'` : "NULL"}`);

  // 1) Sequential allocation (service-role path: uid NULL)
  const a1 = await alloc("academy", ACAD);
  const a2 = await alloc("academy", ACAD);
  check("academy allocations are sequential from the counter", a1 === 5 && a2 === 6, { a1, a2 });

  // NULL counter starts at 1
  const t1 = await alloc("trainer", TRAINER);
  const t2 = await alloc("trainer", TRAINER);
  check("trainer NULL counter starts at 1 then 2", t1 === 1 && t2 === 2, { t1, t2 });

  // 2) GREATEST floor (legacy numbers ahead of the counter)
  const a3 = await alloc("academy", ACAD, 100);
  const a4 = await alloc("academy", ACAD);
  check("p_min floor applies atomically (100 then 101)", a3 === 100 && a4 === 101, { a3, a4 });

  // 3) Academy uniqueness constraint
  await db.exec(`
    INSERT INTO public.invoices (trainer_id, academy_profile_id, invoice_number)
    VALUES (NULL, '${ACAD}', 'WIL-2026-0001');
  `);
  let dupCode = "";
  let dupConstraint = "";
  try {
    await db.exec(`
      INSERT INTO public.invoices (trainer_id, academy_profile_id, invoice_number)
      VALUES ('${TRAINER}', '${ACAD}', 'WIL-2026-0001');
    `);
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string; message?: string };
    dupCode = err.code ?? "";
    dupConstraint = err.constraint_name ?? err.message ?? "";
  }
  check(
    "duplicate academy number rejected with 23505 on unique_invoice_number_per_academy",
    dupCode === "23505" && String(dupConstraint).includes("unique_invoice_number_per_academy"),
    { dupCode, dupConstraint },
  );

  // Personal trainer invoices (NULL academy) stay exempt
  await db.exec(`
    INSERT INTO public.invoices (trainer_id, academy_profile_id, invoice_number)
    VALUES ('${TRAINER}', NULL, 'WIL-2026-0001');
  `);
  check("trainer-personal invoice with same number (NULL academy) still allowed", true);

  // 4) Authorization
  await setUid(STRANGER);
  let strangerBlocked = false;
  try {
    await alloc("academy", ACAD);
  } catch (e) {
    strangerBlocked = String((e as Error).message).includes("not authorized");
  }
  check("stranger (authenticated, no role) is refused", strangerBlocked);

  await setUid(MANAGER);
  const m1 = await alloc("academy", ACAD);
  check("academy manager may allocate", m1 === 102, { m1 });

  await setUid(OWNER);
  const o1 = await alloc("trainer", TRAINER);
  check("trainer owner may allocate", o1 === 3, { o1 });

  await setUid(STRANGER);
  await db.exec(`INSERT INTO public.user_roles VALUES ('${STRANGER}', 'admin');`);
  const adm = await alloc("academy", ACAD);
  check("admin fallback may allocate", adm === 103, { adm });

  // Unknown type / missing profile
  await setUid(null);
  let badType = false;
  try {
    await alloc("nonsense", ACAD);
  } catch (e) {
    badType = String((e as Error).message).includes("unknown profile type");
  }
  check("unknown profile type raises", badType);

  let missing = false;
  try {
    await alloc("academy", "00000000-0000-0000-0000-0000000000ff");
  } catch (e) {
    missing = String((e as Error).message).includes("not found");
  }
  check("missing profile raises", missing);

  if (failures > 0) {
    console.error(`\n${failures} rehearsal check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll M-10 rehearsal checks passed.");
};

main().catch((e) => {
  console.error("rehearsal crashed:", e);
  process.exit(1);
});
