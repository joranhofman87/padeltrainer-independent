/**
 * `backup-database` — the two properties that make it a backup rather than a report.
 *
 * What is tested HERE is the handler's own decisions: that a payload disagreeing with its count is
 * refused, that a partial backup never authorises retention, and that the tables a U1c rollback
 * needs are actually in the list. The export's behaviour — one snapshot, allow-listing, ordering,
 * the size bound — is tested against real Postgres in `scripts/db/backup-coverage.mjs`, because a
 * stub cannot notice the real function breaking its own promises.
 *
 * Lives in `_shared/` because that is the directory `npm run test:edge` runs.
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchWholeTable, handleRequest, TABLES_TO_BACKUP } from "../backup-database/index.ts";

const makeRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}`, v: i }));

interface StubOptions {
  rows: Record<string, Array<{ id: string; v: number }>>;
  /** A row_count that disagrees with the rows in the same payload — a payload this code misread. */
  countOverride?: Record<string, number>;
  /** Tables whose export raises, e.g. the size bound or a permission. */
  exportFails?: Record<string, string>;
  uploadFails?: Set<string>;
  /** Existing backup folders, so retention has something it could delete. */
  folders?: string[];
}

function makeSupabase(opts: StubOptions) {
  const { rows, countOverride = {}, exportFails = {}, uploadFails = new Set<string>(), folders = [] } = opts;
  const uploaded: string[] = [];
  const removed: string[] = [];
  let requests = 0;

  /** `backup_export_table`: rows and their count, together, as the SQL function returns them. */
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const table = String(args._relname);
    if (fn !== "backup_export_table") {
      return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
    }
    if (exportFails[table]) {
      return Promise.resolve({ data: null, error: { message: exportFails[table] } });
    }
    requests++;
    const all = rows[table] ?? [];
    return Promise.resolve({
      data: { row_count: countOverride[table] ?? all.length, rows: all },
      error: null,
    });
  };

  const supabase = {
    rpc,
    storage: {
      from: () => ({
        upload: (path: string) => {
          const table = path.split("/")[1]?.replace(".json", "") ?? "";
          if (uploadFails.has(table)) return Promise.resolve({ error: { message: "no bucket" } });
          uploaded.push(path);
          return Promise.resolve({ error: null });
        },
        list: (prefix?: string) =>
          Promise.resolve({
            data: prefix
              ? [{ name: "persons.json" }]                       // files inside a folder
              : folders.map((name) => ({ name })),               // the folder listing
            error: null,
          }),
        remove: (paths: string[]) => { removed.push(...paths); return Promise.resolve({ error: null }); },
      }),
    },
  };
  return { supabase: supabase as never, uploaded, removed, requests: () => requests };
}

const req = () => new Request("http://localhost/backup-database", { method: "POST" });
const auth = (supabase: unknown) => () => Promise.resolve({ supabase } as never);

/** Fixed clock, so "older than 14 days" is a fact rather than a race. */
const NOW = () => new Date("2026-08-09T12:00:00Z");
const OLD_FOLDER = "2026-07-01T03-00-00";   // 39 days before NOW
const allRows = (n: number) => {
  const r: Record<string, Array<{ id: string; v: number }>> = {};
  for (const t of TABLES_TO_BACKUP) r[t] = makeRows(n);
  return r;
};

Deno.test("the rows and the count the database reported are both carried through", async () => {
  const { supabase } = makeSupabase({ rows: { persons: makeRows(1234) } });
  const out = await fetchWholeTable(supabase, "persons");
  assertEquals(out.rows.length, 1234);
  assertEquals(out.expected, 1234);
});

Deno.test("an export payload that is not {rows, row_count} is refused, not half-read", async () => {
  // a null `rows`, or a missing count, must not be read as "zero rows, backed up fine"
  for (const bad of [{}, { rows: null, row_count: 0 }, { rows: [] }, { row_count: 3 }]) {
    const supabase = {
      rpc: () => Promise.resolve({ data: bad, error: null }),
    } as never;
    let threw = false;
    try { await fetchWholeTable(supabase, "persons"); } catch { threw = true; }
    assertEquals(`${JSON.stringify(bad)}:${threw}`, `${JSON.stringify(bad)}:true`);
  }
});

Deno.test("an export that raises fails its table rather than writing an empty file", async () => {
  const rows = allRows(1);
  const { supabase, uploaded } = makeSupabase({
    rows,
    exportFails: { invoices: "BACKUP_EXPORT_TOO_LARGE: invoices has 900000 rows" },
  });
  const res = await handleRequest(req(), { auth: auth(supabase), now: NOW });
  const body = await res.json();

  assertEquals(res.status, 500);
  assertEquals(body.failedQueries, ["invoices"]);
  // and nothing was uploaded for it — an empty invoices.json would look like a restorable backup
  assertEquals(uploaded.some((p: string) => p.endsWith("/invoices.json")), false);
});

Deno.test("a read that does not match the table's own count FAILS the backup", async () => {
  // the database says 900 rows; the walk returns 800. Under the old code this was a green backup
  // with row_count: 800 and nothing to compare it against.
  const rows = allRows(0);
  rows.persons = makeRows(800);

  const { supabase, removed } = makeSupabase({
    rows, countOverride: { persons: 900 }, folders: [OLD_FOLDER],
  });
  const res = await handleRequest(req(), { auth: auth(supabase), now: NOW });
  const body = await res.json();

  assertEquals(res.status, 500);
  assertEquals(body.ok, false);
  assertEquals(body.incomplete, ["persons"]);
  // rows and row_count come from one scan in the database, so a disagreement here means this code
  // misread the payload — which is exactly what must not pass silently
  const persons = body.tables.find((t: { name: string }) => t.name === "persons");
  assertNotEquals(persons.row_count, persons.expected_rows);
  // and the partial backup must not have been used as licence to delete older ones — the folder
  // IS old enough to be swept, so this only passes because the sweep was skipped
  assertEquals(removed.length, 0);
  assertEquals(body.deleted_old_backups, 0);
});

Deno.test("a complete backup covers every declared table and reports ok", async () => {
  const rows = allRows(3);
  rows.academy_player_memberships = makeRows(1100);

  const { supabase, uploaded, removed } = makeSupabase({ rows, folders: [OLD_FOLDER] });
  const res = await handleRequest(req(), { auth: auth(supabase), now: NOW });
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.incomplete, []);
  assertEquals(uploaded.length, TABLES_TO_BACKUP.length);
  const memberships = body.tables.find(
    (t: { name: string }) => t.name === "academy_player_memberships",
  );
  assertEquals(memberships.row_count, 1100);
  // the counterpart to the incomplete case: a COMPLETE backup does sweep, so the skip above is a
  // decision and not simply a retention path that never runs
  assertEquals(body.deleted_old_backups, 1);
  assertEquals(removed, [`${OLD_FOLDER}/persons.json`]);
});

Deno.test("the membership tables a U1c rollback needs are in the list", () => {
  // U1c's stated rollback is "delete only the backfilled membership rows" — which is not something
  // you can do from a backup that never contained them.
  for (const t of [
    "academy_player_memberships",
    "membership_backfill_runs",
    "membership_backfill_items",
    "academy_player_metadata",
    "academy_player_locations",
    "persons",
    "person_links",
  ]) {
    assertEquals(`${t}:${(TABLES_TO_BACKUP as readonly string[]).includes(t)}`, `${t}:true`);
  }
});

Deno.test("a failed upload still fails the backup and spares the old ones", async () => {
  const { supabase, removed } = makeSupabase({
    rows: allRows(2), uploadFails: new Set(["invoices"]), folders: [OLD_FOLDER],
  });
  const res = await handleRequest(req(), { auth: auth(supabase), now: NOW });
  const body = await res.json();

  assertEquals(res.status, 500);
  assertEquals(body.failedUploads, ["invoices"]);
  assertEquals(removed.length, 0);
});
