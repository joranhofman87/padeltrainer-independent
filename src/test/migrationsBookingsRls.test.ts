import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATION_FILE = "20260530170000_academy_manager_bookings_insert.sql";
const POLICY_NAME = "Academy managers can create bookings for academy slots";

function readMigration(): string {
  const path = join(process.cwd(), "supabase", "migrations", MIGRATION_FILE);
  expect(existsSync(path), `migration file missing: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

describe("academy manager bookings INSERT migration", () => {
  it("defines the academy manager bookings INSERT policy", () => {
    const sql = readMigration();
    expect(sql).toContain(`CREATE POLICY "${POLICY_NAME}"`);
    expect(sql).toContain("ON public.bookings");
    expect(sql).toContain("FOR INSERT");
    expect(sql).toContain("guest_player_id IS NOT NULL");
    expect(sql).toContain("get_user_academy_ids(auth.uid())");
  });

  it("includes pg_policies assertion for the policy name", () => {
    const sql = readMigration();
    expect(sql).toContain("pg_policies");
    expect(sql).toContain(POLICY_NAME);
  });
});
