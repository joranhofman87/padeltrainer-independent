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
 *    A table is now read by `backup_export_group`, which returns rows AND their count from ONE
 *    statement, and returns EVERY table in a consistency group together. That is stronger than the
 *    paging this replaces twice over: a count in one request and pages in later ones can agree while
 *    representing no instant that ever existed, and a `membership_backfill_items` row exported after
 *    a backfill commit can name a membership the backup does not contain. Same statement, same
 *    snapshot, for the whole group. The function also exists because the membership tables REVOKE
 *    ALL from `service_role` — they are owner-only until the backfill is authorized — so the backup
 *    cannot read them directly at all.
 *
 * 2. **Coverage.** `academy_player_memberships` — the canonical academy↔Player relation U1a
 *    introduced, and the only thing a U1c backfill rollback can be reconstructed from — was not in
 *    the list, and neither were the legacy tables it migrates from, U1b's checkpoint state, or
 *    notification CONSENT. `scripts/check-backup-coverage.mjs` now derives the required set from the
 *    schema instead of trusting this list to stay current.
 *
 * A backup that silently saves less than it claims is worse than no backup, because it is trusted.
 *
 * WHAT THIS IS NOT. It is a SCOPED recovery snapshot — a declared set of tables, as JSON, with a
 * best-effort 14-day cleanup pass — and it must never be described as disaster recovery. Read
 * "kept 14 days" as an intention, not a guarantee: the cleanup at the end of this function runs
 * only after a COMPLETE backup, skips entirely otherwise, and does not inspect the result of the
 * list or remove calls it makes. Snapshots older than the window can therefore survive, and nothing
 * here detects it. Whether that is acceptable — and whether the retention should instead be
 * enforced and its failures surfaced — is an open privacy/retention decision for the owner, not a
 * property this function currently provides. It contains no auth schema, no Storage
 * object bytes, no project configuration, no extensions or secrets, and by deliberate decision no
 * `account_deletion_audit` (that table carries subject_email, subject_name, ip_address, user_agent
 * and raw failure_reason, and none of it is needed for the recovery this artifact exists to serve —
 * so copying it here would widen the personal data held for no recovery benefit. That is a
 * data-minimisation decision about ONE table, not a claim about the snapshot as a whole: `profiles`,
 * `persons`, `guest_players`, `trainer_profiles`, `invoices` and `notification_contacts` are all in
 * the list and all carry direct identifiers, because a restore genuinely needs them).
 * Full-database recovery INCLUDING all required PII is Supabase physical backup / PITR, which
 * necessarily holds the personal data present at each restore point. Storage-object recovery,
 * configuration/secret recovery, a portable off-site dump, and an erasure ledger retained outside
 * and beyond every restorable backup are all real requirements and all belong to a separate reviewed
 * DR slice — not to this function.
 *
 * WHAT IT CONTAINS, stated plainly: personal data. Rows keyed by UUIDs that remain linkable to a
 * person are pseudonymous personal data, not anonymous data, and several of these tables hold direct
 * identifiers outright. The snapshots inherit every access, encryption and retention obligation that
 * follows from that.
 *
 * A NOTE ON WHAT BACKING UP AN ERASURE RECORD DOES AND DOES NOT BUY. Preserving evidence is not the
 * same as acting on it. Restoring a database to a point before an erasure still reinstates the erased
 * account: nothing here replays erasures after a restore, and no restore-replay protocol exists yet.
 * What the export buys is that the evidence such a protocol would need still exists when it is built.
 */
import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

/**
 * Every table has a single uuid `id` primary key and must also appear in `backup_export_tables()` —
 * both asserted by `scripts/db/backup-coverage.mjs`, so this list and the database's allow-list
 * cannot drift apart. The `id` requirement is about DETERMINISM, not paging: `backup_export_table`
 * aggregates a whole table in one statement, ordered by `t.id`
 * (`20261118100000_u1c_prereq_backup_export.sql:149-152`), which is what makes two exports of an
 * unchanged table byte-identical and therefore diffable.
 */
export const TABLES_TO_BACKUP = [
  "profiles",
  // person-unification (Phase 1+): the canonical humans and the old→new identity map — a restore
  // without these would leave every stamped person_id on bookings/invoices dangling.
  "persons",
  "person_links",
  "person_merge_review",
  // U2: the durable create receipt (creation_request_id → the canonical person it produced). Losing
  // it does not lose an audit trail — it loses the thing that stops a REPLAYED create from minting a
  // second Player for a request that already had one.
  "player_create_commands",
  // U2: the erasure record, and the mirror image of the line above. Restore the database to a point
  // before an account was erased and nothing in the restored state says the erasure happened — and
  // no later query can derive it. Kept so a future restore-replay protocol has the evidence it will
  // need; it is not that protocol, and on its own it prevents nothing. Its columns are UUIDs, one
  // boolean, one attempt counter, a state, a controlled code and timestamps, so including it adds no
  // direct identifier — though the UUIDs are still pseudonymous personal data. The legacy
  // PII-bearing account_deletion_audit is deliberately NOT here — see the header note.
  "account_scrub_operations",
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
export async function fetchGroup(
  supabase: SupabaseClient,
  group: string,
  expected: readonly string[],
): Promise<Record<string, { rows: unknown[]; expected: number }>> {
  const { data, error } = await supabase.rpc("backup_export_group", { _group: group });
  if (error) throw new Error(`export failed: ${error.message}`);

  const payload = (data ?? {}) as Record<string, { rows?: unknown[]; row_count?: number }>;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`export of group ${group} returned an unusable payload`);
  }

  const out: Record<string, { rows: unknown[]; expected: number }> = {};
  for (const [table, v] of Object.entries(payload)) {
    const rows = Array.isArray(v?.rows) ? v.rows : null;
    if (rows === null || typeof v?.row_count !== "number") {
      throw new Error(`export of ${table} returned an unusable payload`);
    }
    out[table] = { rows, expected: v.row_count };
  }
  // EXACTLY the declared members, no more and no fewer. A group export that quietly omits one table
  // would otherwise upload the rest and report ok — which is the same cross-table hole groups exist
  // to close, arriving through the front door.
  const got = Object.keys(out).sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((t, i) => t !== want[i])) {
    throw new Error(
      `export of group ${group} returned [${got.join(", ")}], expected [${want.join(", ")}]`,
    );
  }
  return out;
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
    /** Tables whose exported row count disagreed with the count the same scan reported. */
    const incomplete: string[] = [];

    // Grouped, so the tables that have to agree with each other come from one snapshot. Everything
    // else is a group of one, which is the same as before.
    const { data: groupRows, error: groupError } = await supabase.rpc("backup_export_groups");
    if (groupError) throw new Error(`could not read export groups: ${groupError.message}`);
    const groups = [
      ...new Set(((groupRows ?? []) as Array<{ group_name: string }>).map((g) => g.group_name)),
    ].sort();
    if (groups.length === 0) throw new Error("no export groups are declared");

    for (const group of groups) {
      const members = ((groupRows ?? []) as Array<{ group_name: string; relname: string }>)
        .filter((g) => g.group_name === group)
        .map((g) => g.relname);

      let exported: Record<string, { rows: unknown[]; expected: number }>;
      try {
        exported = await fetchGroup(supabase, group, members);
      } catch (err) {
        console.error(`Error exporting group ${group}:`, err instanceof Error ? err.message : err);
        // every table in a failed group is a failed table — a group that half-uploads is the
        // inconsistency this design exists to prevent
        for (const t of members) {
          failedQueries.push(t);
          results.push({ name: t, row_count: 0, size_bytes: 0, expected_rows: 0 });
        }
        continue;
      }

      for (const [table, { rows, expected }] of Object.entries(exported)) {
        // THE CHECK THAT MAKES THIS A BACKUP. Rows and row_count come from one scan, so a
        // disagreement here means this code misread the payload — never a silent partial.
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
    }

    results.sort((a, b) => a.name.localeCompare(b.name));

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
