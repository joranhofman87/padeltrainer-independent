/**
 * Nightly logical backup — the thing a rollback actually depends on.
 *
 * Two defects this replaces, both silent:
 *
 * 1. **Truncation.** Every table was read with a single unpaginated `select("*")`. PostgREST caps a
 *    request at `max_rows` (1000 on a default Supabase project), and the response carries no signal
 *    that more rows existed — so the backup wrote the first page, reported `row_count` as the number
 *    of rows it happened to receive, and returned a green "backup complete". Every table larger than
 *    the cap has been backed up partially, and nothing said so. Pages are keyset-walked on the
 *    primary key now, and the row count is checked against an exact `count` taken from the same
 *    table: a mismatch fails the backup rather than shipping a partial one.
 *
 *    The walk goes through `backup_export_page`, not PostgREST directly, for two reasons. The
 *    membership tables REVOKE ALL from `service_role` — deliberately, they are owner-only until the
 *    backfill is authorized — so a direct read of them is permission denied, and the alternative was
 *    granting every service-role caller SELECT on them. And ORDER lives in the function: PostgREST
 *    guarantees no row order without an explicit sort, and a keyset walk over unordered pages skips
 *    rows in silence.
 *
 * 2. **Coverage.** `academy_player_memberships` — the canonical academy↔Player relation U1a
 *    introduced, and the only thing a U1c backfill rollback can be reconstructed from — was not in
 *    the list, and neither were the legacy tables it migrates from, U1b's checkpoint state, or
 *    notification CONSENT. `scripts/check-backup-coverage.mjs` now derives the required set from the
 *    schema instead of trusting this list to stay current.
 *
 * A backup that silently saves less than it claims is worse than no backup, because it is trusted.
 */
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

/**
 * Every table is keyset-paged on a single uuid `id` primary key, and every one must also appear in
 * `backup_export_tables()` — both asserted by `scripts/db/backup-coverage.mjs`, so this list and the
 * database's allow-list cannot drift apart.
 */
export const TABLES_TO_BACKUP = [
  "profiles",
  // person-unification (Phase 1+): the canonical humans and the old→new identity map — a restore
  // without these would leave every stamped person_id on bookings/invoices dangling.
  "persons",
  "person_links",
  "person_merge_review",
  // U1a/U1b: the canonical academy↔Player relation and the backfill's own checkpoint state. The
  // U1c rollback is "delete only the backfilled membership rows", which is not something you can
  // do from a backup that never contained them.
  "academy_player_memberships",
  // both halves of the manifest: the items reference a run, and the run carries the plan hash and
  // completion state that says whether a backfill may be resumed or must be abandoned
  "membership_backfill_runs",
  "membership_backfill_items",
  // the academy-private Player data that membership migrates FROM — losing it loses the notes,
  // status and tags an academy has built up about its players
  "academy_player_metadata",
  "academy_player_locations",
  "academy_player_tags",
  "trainer_profiles",
  "academy_profiles",
  "club_profiles",
  "invoices",
  "bookings",
  "availability_slots",
  "locations",
  "guest_players",
  "club_managers",
  "academy_managers",
  "academy_trainers",
  "user_roles",
  "proposed_assignments",
  "intake_requests",
  "session_player_notes",
  "slot_priority_claims",
  // notification CONSENT. Not queue state — consent is a record of what a person agreed to, and
  // re-deriving it is not possible.
  "notification_contacts",
] as const;

/** Below PostgREST's default cap, so a page is never itself truncated. */
export const PAGE_SIZE = 500;

export interface TableResult {
  name: string;
  row_count: number;
  size_bytes: number;
  /** Rows the database says exist. A backup whose page walk disagrees with this is not a backup. */
  expected_rows: number;
  pages: number;
}

/**
 * Read a whole table by walking its primary key, then prove the walk was complete.
 *
 * Keyset, not `.range()`: an offset walk re-reads by position, so a row inserted or deleted between
 * pages shifts every later page and silently drops or duplicates rows. Keyset reads by value.
 */
async function readOnce(
  supabase: SupabaseClient,
  table: string,
): Promise<{ rows: unknown[]; expected: number; pages: number }> {
  const { data: count, error: countError } = await supabase.rpc("backup_export_count", {
    _relname: table,
  });
  if (countError) throw new Error(`count failed: ${countError.message}`);

  const rows: unknown[] = [];
  let after: string | null = null;
  let pages = 0;

  for (;;) {
    const { data, error } = await supabase.rpc("backup_export_page", {
      _relname: table,
      _after: after,
      _limit: PAGE_SIZE,
    });
    if (error) throw new Error(`page ${pages} failed: ${error.message}`);

    const page = (data ?? []) as Array<Record<string, unknown>>;
    pages++;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;

    const last = String(page[page.length - 1].id);
    // A full page whose last id does not advance would loop forever. `id` is a unique key and the
    // function orders by it, so it cannot happen — but a backup is not the place to find out.
    if (after !== null && last <= after) {
      throw new Error(`page walk for ${table} did not advance past ${after}`);
    }
    after = last;
  }

  return { rows, expected: Number(count ?? rows.length), pages };
}

/** How many times a table may be re-read when its row count moved underneath the walk. */
export const READ_ATTEMPTS = 3;

/**
 * Read a whole table, and prove the read was complete.
 *
 * The count is taken before the walk, so a row inserted or deleted while it runs makes them
 * disagree. That is not a truncated read and failing the night's backup over it would teach people
 * to ignore backup failures — so the table is re-read. What it is NOT is a retry-until-green: a
 * systematic disagreement (a paging defect, a permission that hides rows) reproduces on every
 * attempt and still fails. Only a disagreement that stops happening is accepted, which is exactly
 * the signature of a concurrent write.
 */
export async function fetchWholeTable(
  supabase: SupabaseClient,
  table: string,
): Promise<{ rows: unknown[]; expected: number; pages: number; attempts: number }> {
  let last!: { rows: unknown[]; expected: number; pages: number };
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    last = await readOnce(supabase, table);
    if (last.rows.length === last.expected) return { ...last, attempts: attempt };
    console.warn(
      `Re-reading ${table}: walked ${last.rows.length} rows, count said ${last.expected} (attempt ${attempt})`,
    );
  }
  return { ...last, attempts: READ_ATTEMPTS };
}

export async function handleRequest(
  req: Request,
  deps: { auth?: typeof requireServiceRoleOrAdmin; now?: () => Date } = {},
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authResult = await (deps.auth ?? requireServiceRoleOrAdmin)(req);
    if (authResult instanceof Response) return authResult;

    const supabase = authResult.supabase;
    const timestamp = (deps.now ? deps.now() : new Date())
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    const results: TableResult[] = [];
    const failedQueries: string[] = [];
    const failedUploads: string[] = [];
    /** Tables whose page walk disagreed with the database's own count. */
    const incomplete: string[] = [];

    for (const table of TABLES_TO_BACKUP) {
      let rows: unknown[];
      let expected: number;
      let pages: number;
      let attempts: number;
      try {
        ({ rows, expected, pages, attempts } = await fetchWholeTable(supabase, table));
      } catch (err) {
        console.error(`Error querying ${table}:`, err instanceof Error ? err.message : err);
        failedQueries.push(table);
        results.push({ name: table, row_count: 0, size_bytes: 0, expected_rows: 0, pages: 0 });
        continue;
      }

      // THE CHECK THAT MAKES THIS A BACKUP. Reading fewer rows than the table holds is the failure
      // the old code could not see, so it is named and it is fatal — never a green partial.
      if (rows.length !== expected) {
        console.error(
          `Incomplete read of ${table} after ${attempts} attempts: got ${rows.length}, expected ${expected}`,
        );
        incomplete.push(table);
      }

      const bytes = new TextEncoder().encode(JSON.stringify(rows, null, 2));

      const { error: uploadError } = await supabase.storage
        .from("backups")
        .upload(`${timestamp}/${table}.json`, bytes, {
          contentType: "application/json",
          upsert: false,
        });
      if (uploadError) {
        console.error(`Error uploading ${table}:`, uploadError.message);
        failedUploads.push(table);
      }

      results.push({
        name: table,
        row_count: rows.length,
        size_bytes: bytes.length,
        expected_rows: expected,
        pages,
      });
    }

    const summary = {
      timestamp,
      tables: results,
      total_rows: results.reduce((s, r) => s + r.row_count, 0),
      total_size: results.reduce((s, r) => s + r.size_bytes, 0),
    };
    console.log("Backup complete:", JSON.stringify(summary));

    // --- 14-day retention cleanup ---
    // Only after a COMPLETE backup. Deleting old backups on the strength of a partial new one is how
    // a retention policy turns into data loss.
    const ok = failedQueries.length === 0 && failedUploads.length === 0 && incomplete.length === 0;
    let deletedCount = 0;

    if (ok) {
      const RETENTION_DAYS = 14;
      const cutoff = new Date(
        (deps.now ? deps.now() : new Date()).getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );

      const { data: allFolders } = await supabase.storage
        .from("backups")
        .list("", { limit: 1000, sortBy: { column: "name", order: "asc" } });

      for (const folder of allFolders ?? []) {
        if (!folder.name || folder.name.startsWith(".")) continue;
        const m = folder.name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
        if (!m) continue;
        const folderDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
        if (folderDate >= cutoff) continue;

        const { data: files } = await supabase.storage.from("backups").list(folder.name);
        if (files && files.length > 0) {
          await supabase.storage
            .from("backups")
            .remove(files.map((f) => `${folder.name}/${f.name}`));
        }
        deletedCount++;
      }
      if (deletedCount > 0) {
        console.log(`Retention cleanup: deleted ${deletedCount} backups older than ${RETENTION_DAYS} days`);
      }
    } else {
      console.error("Backup incomplete — retention cleanup skipped so older backups survive");
    }

    return new Response(
      JSON.stringify({
        ...summary,
        ok,
        failedQueries,
        failedUploads,
        incomplete,
        deleted_old_backups: deletedCount,
      }),
      {
        status: ok ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("Backup failed:", err);
    return new Response(JSON.stringify({ error: "Backup failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// Only bind a port when run as the entrypoint — importing the module for tests must not serve.
if (import.meta.main) Deno.serve((req) => handleRequest(req));
