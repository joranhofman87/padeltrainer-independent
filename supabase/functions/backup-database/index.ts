/**
 * Nightly logical backup — the thing a rollback actually depends on.
 *
 * Two defects this replaces, both silent:
 *
 * 1. **Truncation.** Every table was read with a single unpaginated `select("*")`. PostgREST caps a
 *    request at `max_rows` (1000 on a default Supabase project), and the response carries no signal
 *    that more rows existed — so the backup wrote the first page, reported `row_count` as the number
 *    of rows it happened to receive, and returned a green "backup complete". Every table larger than
 *    the cap has been backed up partially, and nothing said so.
 *
 *    A table is now read by `backup_export_table`, which returns its rows AND their count from ONE
 *    scan of ONE snapshot. That is stronger than the paging this replaces: a count in one request
 *    and pages in later ones can agree while representing no instant that ever existed, and no
 *    amount of retrying fixes it. Same statement, same snapshot, cannot disagree. The function also
 *    exists because the membership tables REVOKE ALL from `service_role` — they are owner-only until
 *    the backfill is authorized — so the backup cannot read them directly at all.
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

export interface TableResult {
  name: string;
  row_count: number;
  size_bytes: number;
  /** Rows the database counted in the same scan. A backup that disagrees with this is not a backup. */
  expected_rows: number;
}

/**
 * Read a whole table, and check what came back against what the database said it held.
 *
 * Both numbers come from the same scan inside `backup_export_table`, so a disagreement is not a
 * race — it is this code mis-reading the payload. It stays checked because a backup that trusts its
 * own deserialisation is how the previous version reported partial data as complete.
 */
export async function fetchWholeTable(
  supabase: SupabaseClient,
  table: string,
): Promise<{ rows: unknown[]; expected: number }> {
  const { data, error } = await supabase.rpc("backup_export_table", { _relname: table });
  if (error) throw new Error(`export failed: ${error.message}`);

  const payload = (data ?? {}) as { rows?: unknown[]; row_count?: number };
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  if (rows === null || typeof payload.row_count !== "number") {
    throw new Error(`export of ${table} returned an unusable payload`);
  }
  return { rows, expected: payload.row_count };
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
      try {
        ({ rows, expected } = await fetchWholeTable(supabase, table));
      } catch (err) {
        console.error(`Error querying ${table}:`, err instanceof Error ? err.message : err);
        failedQueries.push(table);
        results.push({ name: table, row_count: 0, size_bytes: 0, expected_rows: 0 });
        continue;
      }

      // THE CHECK THAT MAKES THIS A BACKUP. Reading fewer rows than the table holds is the failure
      // the old code could not see, so it is named and it is fatal — never a green partial.
      if (rows.length !== expected) {
        console.error(`Incomplete read of ${table}: got ${rows.length}, the scan counted ${expected}`);
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
