/**
 * `backup-database` — the two properties that make it a backup rather than a report.
 *
 * The failure this replaces cannot be caught by testing against a real local database, because it
 * only appears when the table is larger than PostgREST's `max_rows` — so the stub here BEHAVES like
 * a capped backend: it refuses to return more than `cap` rows per request and, like the real thing,
 * gives no indication that it truncated. Under that stub the old single-`select("*")` shape silently
 * returns one page and calls it a complete backup; the paged shape walks the key.
 *
 * The fixtures are SHUFFLED, and the stub sorts only because `backup_export_page` promises to. An
 * earlier version of this file pre-sorted its rows and let the stub ignore ordering entirely, so
 * dropping the ORDER BY from the real query passed every pagination assertion — the walk was
 * correct only because the fixture happened to be.
 *
 * Lives in `_shared/` because that is the directory `npm run test:edge` runs.
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fetchWholeTable,
  handleRequest,
  PAGE_SIZE,
  READ_ATTEMPTS,
  TABLES_TO_BACKUP,
} from "../backup-database/index.ts";

/**
 * Rows with sortable ids, deliberately OUT of id order — a keyset walk that relies on the backend's
 * ORDER BY must still be correct, and one that does not must visibly fail.
 */
const makeRows = (n: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}`, v: i }));
  // deterministic shuffle — no Math.random, so a failure is reproducible
  for (let i = rows.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
};

interface StubOptions {
  rows: Record<string, Array<{ id: string; v: number }>>;
  /** Max rows any single request may return — PostgREST's `max_rows`, silently applied. */
  cap?: number;
  /** Report a count that disagrees with what the pages return, i.e. rows written mid-backup. */
  countOverride?: Record<string, number>;
  uploadFails?: Set<string>;
  /** Existing backup folders, so retention has something it could delete. */
  folders?: string[];
}

function makeSupabase(opts: StubOptions) {
  const {
    rows, cap = PAGE_SIZE, countOverride = {}, uploadFails = new Set<string>(),
    folders = [],
  } = opts;
  const uploaded: string[] = [];
  const removed: string[] = [];
  let requests = 0;

  /** `backup_export_count` / `backup_export_page`, with the ordering the SQL function promises. */
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const table = String(args._relname);
    const all = rows[table] ?? [];

    if (fn === "backup_export_count") {
      return Promise.resolve({ data: countOverride[table] ?? all.length, error: null });
    }
    if (fn !== "backup_export_page") {
      return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
    }

    requests++;
    const after = args._after === null || args._after === undefined ? null : String(args._after);
    const limit = Math.min(Number(args._limit), cap);   // the cap, applied silently
    const page = [...all]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))   // ORDER BY t.id
      .filter((r) => after === null || r.id > after)
      .slice(0, limit);
    return Promise.resolve({ data: page, error: null });
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

Deno.test("a table larger than the row cap is read WHOLE, not one page", async () => {
  const rows = { persons: makeRows(1234) };
  const { supabase } = makeSupabase({ rows, cap: PAGE_SIZE });

  const out = await fetchWholeTable(supabase, "persons");

  assertEquals(out.rows.length, 1234);
  assertEquals(out.expected, 1234);
  // proof it actually paged rather than getting lucky with one big response
  assertEquals(out.pages, Math.ceil(1234 / PAGE_SIZE));
  // and no row was fetched twice — the keyset walk must not overlap
  assertEquals(new Set((out.rows as Array<{ id: string }>).map((r) => r.id)).size, 1234);
});

Deno.test("the page walk is keyset, so the last page ends the walk", async () => {
  // exactly one full page then nothing: a `.length < PAGE_SIZE` terminator would loop forever
  // without the id advancing, so this pins the exact-multiple boundary
  const { supabase } = makeSupabase({ rows: { persons: makeRows(PAGE_SIZE) } });
  const out = await fetchWholeTable(supabase, "persons");
  assertEquals(out.rows.length, PAGE_SIZE);
  assertEquals(out.pages, 2);   // the full page, then the empty one that proves the end
});

Deno.test("an empty table is one request and no rows", async () => {
  const { supabase } = makeSupabase({ rows: { persons: [] } });
  const out = await fetchWholeTable(supabase, "persons");
  assertEquals(out.rows.length, 0);
  assertEquals(out.pages, 1);
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
  // a SYSTEMATIC disagreement reproduces, so the re-reads do not launder it into a pass
  const personsAttempts = body.tables.find((t: { name: string }) => t.name === "persons");
  assertEquals(personsAttempts.row_count, 800);
  const persons = body.tables.find((t: { name: string }) => t.name === "persons");
  assertNotEquals(persons.row_count, persons.expected_rows);
  // and the partial backup must not have been used as licence to delete older ones — the folder
  // IS old enough to be swept, so this only passes because the sweep was skipped
  assertEquals(removed.length, 0);
  assertEquals(body.deleted_old_backups, 0);
});

Deno.test("a complete backup covers every declared table and reports ok", async () => {
  const rows = allRows(3);
  rows.academy_player_memberships = makeRows(1100);   // over the cap on purpose

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

Deno.test("a count that disagrees only ONCE is a concurrent write, not a bad backup", async () => {
  // The count is taken before the walk, so an insert during it makes them differ. Failing the
  // night's backup over that teaches people to ignore backup failures — so it is re-read, and only
  // a disagreement that KEEPS happening fails.
  const rows = allRows(0);
  rows.persons = makeRows(10);
  let call = 0;
  const { supabase } = makeSupabase({ rows });
  const inner = (supabase as unknown as { rpc: (f: string, a: Record<string, unknown>) => unknown }).rpc;
  (supabase as unknown as { rpc: unknown }).rpc = (f: string, a: Record<string, unknown>) => {
    if (f === "backup_export_count" && a._relname === "persons" && call++ === 0) {
      return Promise.resolve({ data: 11, error: null });   // wrong on the FIRST attempt only
    }
    return inner(f, a);
  };

  const out = await fetchWholeTable(supabase, "persons");
  assertEquals(out.rows.length, 10);
  assertEquals(out.expected, 10);
  assertEquals(out.attempts, 2);            // it took a second read, and the second agreed
});

Deno.test("a count that NEVER agrees is not retried into success", async () => {
  const { supabase } = makeSupabase({ rows: { persons: makeRows(10) }, countOverride: { persons: 11 } });
  const out = await fetchWholeTable(supabase, "persons");
  assertEquals(out.attempts, READ_ATTEMPTS);
  assertEquals(out.rows.length, 10);
  assertEquals(out.expected, 11);           // still reported as a disagreement, so the backup fails
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
