import { corsHeaders, requireServiceRoleOrAdmin } from "../_shared/auth.ts";

const TABLES_TO_BACKUP = [
  "profiles",
  // person-unification (Phase 1+): the canonical humans and the old→new identity map — a restore
  // without these would leave every stamped person_id on bookings/invoices dangling.
  "persons",
  "person_links",
  "person_merge_review",
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
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authResult = await requireServiceRoleOrAdmin(req);
    if (authResult instanceof Response) return authResult;

    const supabase = authResult.supabase;
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const results: { name: string; row_count: number; size_bytes: number }[] =
      [];
    const failedQueries: string[] = [];
    const failedUploads: string[] = [];

    for (const table of TABLES_TO_BACKUP) {
      const { data, error } = await supabase.from(table).select("*");

      if (error) {
        console.error(`Error querying ${table}:`, error.message);
        failedQueries.push(table);
        results.push({ name: table, row_count: 0, size_bytes: 0 });
        continue;
      }

      const jsonContent = JSON.stringify(data || [], null, 2);
      const bytes = new TextEncoder().encode(jsonContent);

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
        row_count: data?.length || 0,
        size_bytes: bytes.length,
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
    const RETENTION_DAYS = 14;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    const { data: allFolders } = await supabase.storage
      .from("backups")
      .list("", { limit: 1000, sortBy: { column: "name", order: "asc" } });

    if (allFolders) {
      for (const folder of allFolders) {
        if (!folder.name || folder.name.startsWith(".")) continue;
        // Parse timestamp from folder name like 2026-03-30T12-00-00
        const m = folder.name.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/
        );
        if (!m) continue;
        const folderDate = new Date(
          `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
        );
        if (folderDate >= cutoff) continue;

        const { data: files } = await supabase.storage
          .from("backups")
          .list(folder.name);
        if (files && files.length > 0) {
          const paths = files.map((f) => `${folder.name}/${f.name}`);
          await supabase.storage.from("backups").remove(paths);
        }
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log(`Retention cleanup: deleted ${deletedCount} backups older than ${RETENTION_DAYS} days`);
    }

    // A backup that silently uploads nothing is worse than a loud failure: if any
    // table failed to query or upload (e.g. a missing `backups` storage bucket makes
    // every upload fail), return non-2xx so the daily cron surfaces it instead of
    // reporting a green "backup complete" while saving nothing.
    const ok = failedQueries.length === 0 && failedUploads.length === 0;
    return new Response(
      JSON.stringify({ ...summary, ok, failedQueries, failedUploads, deleted_old_backups: deletedCount }),
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
});
