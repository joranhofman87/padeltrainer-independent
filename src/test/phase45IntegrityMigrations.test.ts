import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function readMigration(file: string): string {
  const path = join(process.cwd(), "supabase", "migrations", file);
  expect(existsSync(path), `migration file missing: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

describe("P5-CHK-01 availability_slots time-order CHECK", () => {
  const sql = readMigration("20260614170000_availability_slots_time_order_check.sql");

  it("adds a NOT VALID end_time > start_time CHECK (forward-enforcing, deploy-safe)", () => {
    expect(sql).toContain("ALTER TABLE public.availability_slots");
    expect(sql).toContain("availability_slots_time_order_check");
    expect(sql).toContain("CHECK (end_time > start_time)");
    expect(sql).toContain("NOT VALID");
  });

  it("documents the VALIDATE follow-up gated on a zero violator count", () => {
    expect(sql).toContain("VALIDATE CONSTRAINT availability_slots_time_order_check");
    expect(sql).toContain("end_time <= start_time");
  });
});

describe("P5-CHK-02 cycles date-order CHECK", () => {
  const sql = readMigration("20260614180000_cycles_date_order_check.sql");

  it("adds a NULL-tolerant start_date <= end_date CHECK (NOT VALID)", () => {
    expect(sql).toContain("ALTER TABLE public.cycles");
    expect(sql).toContain("cycles_date_order_check");
    // NULL guards are mandatory: start_date/end_date are nullable (is_always_open cycles)
    expect(sql).toContain("start_date IS NULL OR end_date IS NULL OR start_date <= end_date");
    expect(sql).toContain("NOT VALID");
  });
});

describe("CRON-SF-03 cron single-flight advisory-lock RPCs", () => {
  const sql = readMigration("20260614190000_cron_single_flight_lock.sql");

  it("defines session-scoped try/unlock RPCs keyed by hashtextextended(job_name)", () => {
    expect(sql).toContain("FUNCTION public.try_lock_cron_job(p_job_name text)");
    expect(sql).toContain("FUNCTION public.unlock_cron_job(p_job_name text)");
    // session-scoped (NOT pg_advisory_xact_lock) so it survives the edge fn's many round-trips
    expect(sql).toContain("pg_try_advisory_lock(hashtextextended(p_job_name, 0))");
    expect(sql).toContain("pg_advisory_unlock(hashtextextended(p_job_name, 0))");
    expect(sql).not.toContain("pg_advisory_xact_lock");
  });

  it("locks down execution to service_role only", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.try_lock_cron_job(text) FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.unlock_cron_job(text) FROM PUBLIC");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.try_lock_cron_job(text) TO service_role");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.unlock_cron_job(text) TO service_role");
  });
});

describe("CRON-SF-03 grant tightening (revoke from anon + authenticated)", () => {
  const sql = readMigration("20260614200000_cron_lock_revoke_authenticated.sql");

  it("revokes EXECUTE from anon AND authenticated (Supabase default-privilege grant)", () => {
    // a plain REVOKE ... FROM PUBLIC does NOT remove Supabase's default
    // anon/authenticated grants — they must be named explicitly.
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.try_lock_cron_job(text) FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.unlock_cron_job(text) FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.try_lock_cron_job(text) TO service_role");
  });
});

describe("P5-CHK VALIDATE follow-up (count-then-conditionally-validate)", () => {
  const sql = readMigration("20260614220000_validate_date_order_checks.sql");

  it("validates only when 0 violators, never aborts the deploy", () => {
    // counts first; VALIDATE under IF v = 0, WARNING (not error) otherwise
    expect(sql).toContain("VALIDATE CONSTRAINT availability_slots_time_order_check");
    expect(sql).toContain("VALIDATE CONSTRAINT cycles_date_order_check");
    expect(sql).toContain("end_time <= start_time");
    expect(sql).toContain("end_date < start_date");
    expect(sql).toContain("RAISE WARNING");
    expect(sql).not.toContain("RAISE EXCEPTION");
  });
});

describe("BJ-08 notification_sends dedup table", () => {
  const sql = readMigration("20260614210000_notification_sends_dedup.sql");

  it("creates the dedup table with a UNIQUE dedup_key index", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.notification_sends");
    expect(sql).toContain("dedup_key text NOT NULL");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_sends_dedup_key");
    expect(sql).toContain("ON public.notification_sends (dedup_key)");
  });

  it("is service_role only (RLS on, revoked from anon/authenticated)", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON TABLE public.notification_sends FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT SELECT, INSERT, DELETE ON TABLE public.notification_sends TO service_role");
  });
});

// BJ-08's dedup CONTRACT survives 10c-b D, but its mechanism moved. notify-followers no longer
// claims rows in notification_sends before POSTing send-email — it calls
// enqueue_notification('open_slots_player'), whose idempotency key
// (<event>:<subject>:<recipient>) IS the dedup. The migration assertions above are unchanged:
// notification_sends and its grants still exist, and the legacy table is retired on its own
// reviewed boundary (10c-d), not here.
describe("notify-followers edge function (post-10c-b-D)", () => {
  const src = readFileSync(
    join(process.cwd(), "supabase", "functions", "notify-followers", "index.ts"),
    "utf8",
  );

  it("enqueues through the v2 resolver and never reaches the legacy sender", () => {
    // Assert the CALL, not the word — the header comment mentions enqueue_notification too,
    // so a bare toContain() would stay green if the rpc name were changed to anything else.
    expect(src).toContain('.rpc("enqueue_notification"');
    expect(src).toContain('p_event_key: "open_slots_player"');
    // the legacy route is GONE — no direct send-email POST, no notification_sends claim.
    // Either one surviving beside the v2 call would be a dual send.
    // Assert on CODE, not prose: the header comment legitimately explains what was removed.
    expect(src).not.toContain("functions/v1/send-email");
    expect(src).not.toContain('from("notification_sends")');
    expect(src).not.toContain('onConflict: "dedup_key"');
  });

  it("keeps dedup deterministic and derived from STRUCTURED fields", () => {
    // the subject builder lives in the shared production module, not inline here
    expect(src).toContain("eventSubject");
    expect(src).toContain("p_idempotency_subject");
    // display-formatted dates must never be the event identity again
    expect(src).not.toContain("date_range");
  });

  it("batches with bounded concurrency and a wall-clock budget", () => {
    expect(src).toContain("CHUNK_SIZE");
    expect(src).toContain("TIME_BUDGET_MS");
    expect(src).toContain("Promise.all");
    expect(src).not.toContain("for (const player of playersToNotify)");
  });

  it("reports enqueue outcomes and never claims a send", () => {
    expect(src).toContain("already_existing");
    expect(src).toContain("deferred");
    // "sent" was the old, untrue count: this route enqueues, it does not deliver
    expect(src).not.toContain("sentCount");
  });
});
